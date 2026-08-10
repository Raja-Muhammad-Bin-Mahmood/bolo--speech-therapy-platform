/**
 * BOLO — Training History (account-level persistence) + Profile Builder
 *
 * Completed exercises are saved to the USER'S ACCOUNT — never only in
 * frontend state — so history survives refresh / login / device changes,
 * following the EXACT same architecture as the manual-annotation store:
 *   • Supabase account (existing auth) → Postgres table
 *     `training_completions` (RLS: auth.uid() = user_id).
 *   • Local/demo account (existing app fallback) → localStorage keyed by the
 *     user's stable local id.
 *
 * The profile builder reuses the EXISTING saved speech data:
 *   • getOnsetLetterHistory() + loadUserEvents() (official disfluency
 *     events — automatic + manually confirmed) → onsets, fillers, manual
 *     stutters
 *   • the session that led here (pace + pauses) → pace / hesitation signals
 * Nothing here modifies detection, transcription or analysis.
 */
import { supabase } from "./supabase";
import { loadUserEvents, type UserAccount } from "./manualAnnotations";
import type {
  CompletedExercise,
  ExerciseCategory,
  TrainingProfile,
  TrainingStats,
} from "./exerciseTypes";

const TABLE = "training_completions";

// ─── IDs ────────────────────────────────────────────────────────────────

export function makeCompletionId(): string {
  return `trn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Local (demo / guest) store ─────────────────────────────────────────

function localKey(userId: string): string {
  return `bolo_training_completions_${userId}`;
}

function loadLocal(userId: string): CompletedExercise[] {
  try {
    const raw = localStorage.getItem(localKey(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocal(userId: string, items: CompletedExercise[]): void {
  try {
    localStorage.setItem(localKey(userId), JSON.stringify(items));
  } catch {
    // best-effort — persistence never breaks the training flow
  }
}

// ─── Row mappers (Supabase) ─────────────────────────────────────────────

function toRow(c: CompletedExercise, userId: string) {
  return {
    id: c.id,
    user_id: userId,
    exercise_id: c.exerciseId,
    category: c.category,
    target: c.target,
    exercise_name: c.exerciseName,
    session_id: c.sessionId ?? null,
    mode: c.mode ?? null,
    duration_seconds: c.durationSeconds,
    status: c.status,
    completed_at: c.completedAt,
  };
}

function fromRow(r: any): CompletedExercise {
  return {
    id: r.id,
    exerciseId: r.exercise_id,
    category: r.category as ExerciseCategory,
    target: r.target ?? r.exercise_name,
    exerciseName: r.exercise_name,
    completedAt: r.completed_at,
    durationSeconds: r.duration_seconds ?? 0,
    status: r.status ?? "done",
    sessionId: r.session_id ?? null,
    mode: r.mode ?? null,
  };
}

// ─── Public persistence API ─────────────────────────────────────────────

/** The user's FULL training history, newest first. */
export async function loadTrainingHistory(
  user: UserAccount
): Promise<CompletedExercise[]> {
  if (!user.isLocal) {
    try {
      const { data } = await supabase
        .from(TABLE)
        .select("*")
        .eq("user_id", user.id)
        .order("completed_at", { ascending: false })
        .limit(500);
      return (data ?? []).map(fromRow);
    } catch {
      return [];
    }
  }
  const items = loadLocal(user.id);
  return [...items].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
}

/** Persist one completed exercise to the user's account. Idempotent by id. */
export async function saveTrainingCompletion(
  user: UserAccount,
  c: CompletedExercise
): Promise<void> {
  if (!user.isLocal) {
    try {
      await supabase.from(TABLE).upsert(toRow(c, user.id), {
        onConflict: "id",
      });
    } catch {
      // best-effort
    }
    return;
  }
  const byId = new Map(loadLocal(user.id).map((x) => [x.id, x]));
  byId.set(c.id, c);
  saveLocal(user.id, [...byId.values()]);
}

// ─── Profile builder (reuses EXISTING saved speech data) ────────────────

export interface SessionSignals {
  /** Session-level onset counts (fallback when account history is empty). */
  onsets?: { letter: string; count: number }[];
  /** Session-level filler words (fallback when account history is empty). */
  fillers?: Record<string, number>;
  /** Existing rolling pace measurement from the originating session. */
  wpm?: number;
  paceZone?: string;
  paceConsistency?: number | null;
  pauses?: { thinking: number; awkward: number; severe: number; total: number };
}

/**
 * Assemble the training profile from the user's SAVED speech data.
 *
 * Primary source: the account-level official disfluency events (the same
 * records that power Common Onsets). The originating session's pace and
 * pause signals are appended (user-level pace history is not persisted).
 * Session-level onsets/fillers are used only as a fallback when account
 * history is empty (e.g. a persistence hiccup), to avoid double-counting.
 */
export async function buildTrainingProfile(
  user: UserAccount | null,
  session?: SessionSignals | null
): Promise<TrainingProfile> {
  const account = user ?? { id: "guest", isLocal: true };
  const events = await loadUserEvents(account);

  const onsetCounts = new Map<string, number>();
  const manualOnsets = new Map<string, number>();
  const fillerCounts = new Map<string, number>();
  let manualStutterCount = 0;

  for (const e of events) {
    if (e.type === "filler") {
      const w = (e.word ?? "").toLowerCase().replace(/[^a-z]/g, "");
      if (w) fillerCounts.set(w, (fillerCounts.get(w) ?? 0) + 1);
      continue;
    }
    if (e.firstLetter) {
      const l = e.firstLetter.toLowerCase();
      onsetCounts.set(l, (onsetCounts.get(l) ?? 0) + 1);
      if (e.source === "manual") {
        manualOnsets.set(l, (manualOnsets.get(l) ?? 0) + 1);
        manualStutterCount += 1;
      }
    }
  }

  const hasAccountData = onsetCounts.size > 0 || fillerCounts.size > 0;
  void hasAccountData;

  // Fallback: session-level onsets / fillers only when the account is empty.
  if (onsetCounts.size === 0 && Array.isArray(session?.onsets)) {
    for (const o of session.onsets) {
      const l = (o.letter ?? "").toLowerCase();
      if (l) onsetCounts.set(l, o.count);
    }
  }
  if (fillerCounts.size === 0 && session?.fillers) {
    for (const [w, c] of Object.entries(session.fillers)) {
      if (w) fillerCounts.set(w, c);
    }
  }

  const onsets = [...onsetCounts.entries()]
    .map(([letter, count]) => ({ letter, count }))
    .sort((a, b) => b.count - a.count || a.letter.localeCompare(b.letter));
  const fillers = [...fillerCounts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

  // Pace — from the existing rolling pace measurement of the session that
  // led here (elevated / unstable derived deterministically).
  const wpm = session?.wpm ?? 0;
  const zone = session?.paceZone ?? "green";
  const consistency = session?.paceConsistency ?? null;
  const elevated =
    zone === "red" || zone === "orange" || (wpm >= 185 && wpm > 0);
  const unstable = consistency != null && consistency < 55;

  const pauses = session?.pauses ?? {
    thinking: 0,
    awkward: 0,
    severe: 0,
    total: 0,
  };

  return {
    onsets,
    manualOnsets,
    manualStutterCount,
    fillers,
    pace: { wpm, zone, consistency, elevated, unstable },
    pauses,
    hasSessionData:
      !!session && (wpm > 0 || pauses.total > 0 || !!session.onsets),
  };
}

// ─── Progress stats (measures PRACTICE, never clinical improvement) ─────

/** Aggregate the training history into the Progress Report metrics. */
export function buildTrainingStats(history: CompletedExercise[]): TrainingStats {
  const totalCompleted = history.length;
  const totalPracticeSeconds = history.reduce(
    (s, c) => s + (c.durationSeconds ?? 0),
    0
  );
  const byTarget = new Map<string, number>();
  for (const c of history) {
    const key = c.target || c.exerciseName;
    byTarget.set(key, (byTarget.get(key) ?? 0) + 1);
  }
  const mostPracticed = [...byTarget.entries()]
    .map(([target, count]) => ({ target, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const recent = [...history]
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
    .slice(0, 5);
  return {
    totalCompleted,
    totalPracticeSeconds,
    mostPracticed,
    recent,
    currentFocus: mostPracticed[0]?.target ?? null,
  };
}

/** "3 min" / "2m 12s" style label for practice time. */
export function formatPracticeTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s > 0 ? `${m}m ${s}s` : `${m} min`;
}

/** Human label for an originating mode. */
export function modeLabel(mode?: string | null): string {
  switch (mode) {
    case "free":
      return "Free Speech";
    case "script":
      return "Script Mode";
    case "closer":
      return "Closer Mode";
    case "training":
      return "Direct";
    default:
      return "Training";
  }
}
