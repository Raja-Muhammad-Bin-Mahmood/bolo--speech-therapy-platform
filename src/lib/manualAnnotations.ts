/**
 * BOLO — Manual Markers, Official Disfluency Events & User Onset-Letter Data
 *
 * ADDITIVE feature (manual marker + post-session annotation). Nothing here
 * changes detection, transcription, DSP, Deepgram or the live transcript.
 *
 *   • SessionMarker — a timestamped placeholder ("come back to this point
 *     and annotate what happened"). A marker is NOT a disfluency.
 *   • OfficialDisfluencyEvent — the ONE official event model with two
 *     sources of the SAME model:
 *         source "automatic"  → auto-detected live (persisted at session end)
 *         source "manual"     → user-confirmed post-session annotation
 *     Once confirmed, both count equally as official disfluencies.
 *
 * Persistence is USER-LEVEL and durable (never only React state):
 *   • Supabase account (existing auth) → Postgres tables `disfluency_events`
 *     + `session_markers` (RLS: auth.uid() = user_id).
 *   • Local/demo account (existing app fallback) → localStorage keyed by the
 *     user's stable local id.
 *
 * Onset-letter data: every stutter-like official event stores the COMPLETE
 * word AND its first letter (session → word "session" + onsetLetter "s").
 * Filler events store the COMPLETE filler word (never reduced to a first
 * letter). getUserOnsetLetterHistory() aggregates the user's stutter-like
 * onset letters (s, s, r → counts) while every individual event record stays
 * available via loadUserEvents() — nothing is reduced to unique letters yet.
 */
import { supabase } from "./supabase";
import { firstLetterOfWord } from "./transcriptTokens";

// ─── Types ──────────────────────────────────────────────────────────────

export interface UserAccount {
  id: string;
  isLocal: boolean;
}

/** A timestamped placeholder dropped during a live session (SPACE or the
 *  MARKER button) — "come back to this point and annotate what happened".
 *  It is NOT itself a disfluency. */
export interface SessionMarker {
  /** Stable marker ID. */
  id: string;
  /** Session this marker belongs to. */
  sessionId: string;
  /** Session-relative milliseconds (shared BOLO session clock). */
  timeMs: number;
  /** Transcript position — the nearest token id, when available. */
  tokenId?: string | null;
  /** Wall-clock creation time. */
  createdAt: string;
}

/** The ONE official disfluency event model — automatic and manual are two
 *  sources of the SAME model. */
export interface OfficialDisfluencyEvent {
  /** Stable annotation/event ID. */
  id: string;
  sessionId: string;
  /** The selected transcript token(s) this event references. */
  tokenId: string;
  /** COMPLETE word (fillers keep the full word, never just a first letter). */
  word: string;
  /** First letter of the normalized word (a–z) — the onset-letter payload
   *  for stutter-like events. `null` for words with no letters. */
  firstLetter: string | null;
  /** Disfluency type: stammer | block | filler | stutter | repetition | … */
  type: string;
  /** Session-relative milliseconds (shared BOLO session clock). */
  timeMs: number;
  /** "automatic" (detected live) | "manual" (user-confirmed). */
  source: "automatic" | "manual";
  utterance?: number | null;
  sentence?: string | null;
  createdAt: string;
}

// ─── IDs ────────────────────────────────────────────────────────────────

export function makeMarkerId(): string {
  return `mark_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function makeEventId(): string {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function sortMarkers(markers: SessionMarker[]): SessionMarker[] {
  return [...markers].sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
}

export function sortEvents(
  events: OfficialDisfluencyEvent[]
): OfficialDisfluencyEvent[] {
  return [...events].sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
}

// ─── Build a manual event from a transcript token ───────────────────────

export function manualEventFromToken(
  t: {
    id: string;
    word: string;
    firstLetter?: string | null;
    startTimeMs: number;
  },
  sessionId: string,
  type: string,
  utterance?: number | null,
  sentence?: string | null
): OfficialDisfluencyEvent {
  return {
    id: makeEventId(),
    sessionId,
    tokenId: t.id,
    word: t.word,
    firstLetter: t.firstLetter !== undefined ? t.firstLetter : firstLetterOfWord(t.word),
    type,
    timeMs: t.startTimeMs,
    source: "manual",
    utterance: utterance ?? null,
    sentence: sentence ?? null,
    createdAt: new Date().toISOString(),
  };
}

// ─── Local (demo) store ─────────────────────────────────────────────────

const EVENT_TABLE = "disfluency_events";
const MARKER_TABLE = "session_markers";

interface LocalStore {
  markers: SessionMarker[];
  events: OfficialDisfluencyEvent[];
}

function localKey(userId: string): string {
  return `bolo_manual_data_${userId}`;
}

function loadLocal(userId: string): LocalStore {
  try {
    const raw = localStorage.getItem(localKey(userId));
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      markers: Array.isArray(parsed.markers) ? parsed.markers : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
    };
  } catch {
    return { markers: [], events: [] };
  }
}

function saveLocal(userId: string, store: LocalStore): void {
  try {
    localStorage.setItem(localKey(userId), JSON.stringify(store));
  } catch {
    // best-effort — persistence is never allowed to break the session
  }
}

// ─── Row mappers (Supabase) ─────────────────────────────────────────────

function toEventRow(e: OfficialDisfluencyEvent, userId: string) {
  return {
    id: e.id,
    user_id: userId,
    session_id: e.sessionId,
    token_id: e.tokenId,
    word: e.word,
    first_letter: e.firstLetter,
    type: e.type,
    time_ms: e.timeMs,
    source: e.source,
    utterance: e.utterance ?? null,
    sentence: e.sentence ?? null,
    created_at: e.createdAt,
  };
}

function fromEventRow(r: any): OfficialDisfluencyEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    tokenId: r.token_id,
    word: r.word,
    firstLetter: r.first_letter,
    type: r.type,
    timeMs: r.time_ms,
    source: r.source,
    utterance: r.utterance,
    sentence: r.sentence,
    createdAt: r.created_at,
  };
}

function toMarkerRow(m: SessionMarker, userId: string) {
  return {
    id: m.id,
    user_id: userId,
    session_id: m.sessionId,
    time_ms: m.timeMs,
    token_id: m.tokenId ?? null,
    created_at: m.createdAt,
  };
}

function fromMarkerRow(r: any): SessionMarker {
  return {
    id: r.id,
    sessionId: r.session_id,
    timeMs: r.time_ms,
    tokenId: r.token_id,
    createdAt: r.created_at,
  };
}

// ─── Public persistence API ─────────────────────────────────────────────

/** Persist markers to the user's account (Supabase when logged in, local
 *  store for demo accounts). Idempotent by marker id. */
export async function persistMarkers(
  user: UserAccount,
  markers: SessionMarker[]
): Promise<void> {
  if (markers.length === 0) return;
  if (!user.isLocal) {
    try {
      await supabase
        .from(MARKER_TABLE)
        .upsert(markers.map((m) => toMarkerRow(m, user.id)), { onConflict: "id" });
    } catch {
      // best-effort
    }
    return;
  }
  const store = loadLocal(user.id);
  const byId = new Map(store.markers.map((m) => [m.id, m]));
  for (const m of markers) byId.set(m.id, m);
  saveLocal(user.id, { ...store, markers: sortMarkers([...byId.values()]) });
}

/** Markers for one session (the session's own markers, chronological). */
export async function loadSessionMarkers(
  user: UserAccount,
  sessionId: string
): Promise<SessionMarker[]> {
  if (!user.isLocal) {
    try {
      const { data } = await supabase
        .from(MARKER_TABLE)
        .select("*")
        .eq("user_id", user.id)
        .eq("session_id", sessionId);
      return sortMarkers((data ?? []).map(fromMarkerRow));
    } catch {
      return [];
    }
  }
  return sortMarkers(loadLocal(user.id).markers.filter((m) => m.sessionId === sessionId));
}

/** Persist official disfluency events (automatic AND manual). Idempotent:
 *  unique per (session_id, token_id, source) — saving a session twice or
 *  re-confirming an annotation never duplicates a row. */
export async function persistEvents(
  user: UserAccount,
  events: OfficialDisfluencyEvent[]
): Promise<void> {
  if (events.length === 0) return;
  if (!user.isLocal) {
    try {
      await supabase
        .from(EVENT_TABLE)
        .upsert(events.map((e) => toEventRow(e, user.id)), {
          onConflict: "session_id,token_id,source",
          ignoreDuplicates: true,
        });
    } catch {
      // best-effort
    }
    return;
  }
  const store = loadLocal(user.id);
  const key = (e: OfficialDisfluencyEvent) => `${e.sessionId}|${e.tokenId}|${e.source}`;
  const byKey = new Map(store.events.map((e) => [key(e), e]));
  for (const e of events) byKey.set(key(e), e);
  saveLocal(user.id, { ...store, events: sortEvents([...byKey.values()]) });
}

/** All official events for one session (automatic + manual). */
export async function loadSessionEvents(
  user: UserAccount,
  sessionId: string
): Promise<OfficialDisfluencyEvent[]> {
  if (!user.isLocal) {
    try {
      const { data } = await supabase
        .from(EVENT_TABLE)
        .select("*")
        .eq("user_id", user.id)
        .eq("session_id", sessionId);
      return sortEvents((data ?? []).map(fromEventRow));
    } catch {
      return [];
    }
  }
  return sortEvents(loadLocal(user.id).events.filter((e) => e.sessionId === sessionId));
}

/** The user's FULL official event history (every individual event record —
 *  the source of the onset-letter aggregate below). */
export async function loadUserEvents(
  user: UserAccount
): Promise<OfficialDisfluencyEvent[]> {
  if (!user.isLocal) {
    try {
      const { data } = await supabase
        .from(EVENT_TABLE)
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(2000);
      return sortEvents((data ?? []).map(fromEventRow));
    } catch {
      return [];
    }
  }
  return sortEvents(loadLocal(user.id).events);
}

/** USER-LEVEL ONSET-LETTER HISTORY — aggregated from the user's official
 *  events (stutter-like only; fillers always keep their COMPLETE word and
 *  are excluded here). Returns per-letter counts, e.g. s:3, r:1. The
 *  individual event records remain available via loadUserEvents(). */
export async function getOnsetLetterHistory(
  user: UserAccount
): Promise<{ letter: string; count: number }[]> {
  const events = await loadUserEvents(user);
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.type === "filler") continue; // fillers keep the full word
    if (!e.firstLetter) continue;
    counts.set(e.firstLetter, (counts.get(e.firstLetter) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([letter, count]) => ({ letter, count }))
    .sort((a, b) => b.count - a.count || a.letter.localeCompare(b.letter));
}
