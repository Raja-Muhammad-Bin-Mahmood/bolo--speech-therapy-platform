/**
 * BOLO — Structured Session Disfluency Data
 *
 * During a live session EVERY disfluency the transcript showed is saved as
 * structured data (`sessionDisfluencies[]`). The collection is derived from
 * the SAME reconciled token array that powered the LIVE TRANSCRIPT — the
 * single source of truth — so nothing is ever re-detected or re-transcribed
 * after the session.
 *
 *   • STUTTERING-LIKE disfluencies (sound_repetition, prolongation, block,
 *     word/phrase repetition, revision, stutter, stammer, …): the COMPLETE
 *     word is saved AND its firstLetter is stored separately — the exercise
 *     payload. Example: "yellow" → word "yellow", firstLetter "y".
 *   • FILLER words ("um", "uh", "like", …): the ENTIRE filler word is
 *     saved — NEVER reduced to its first letter. Example: "um" → "um",
 *     "like" → "like".
 *
 * Each entry identifies:
 *   • stable token ID (the same id the live transcript token carried)
 *   • complete word
 *   • first letter (stutter-like exercises)
 *   • disfluency type
 *   • session timestamp (shared BOLO session clock, ms)
 *   • ASR source ("deepgram" | "speechmatics")
 *   • sentence/segment association (utterance index)
 *
 * The collection survives the session end via localStorage so later
 * features (the exercise system) can consume it.
 */
import {
  firstLetterOfWord,
  isDisfluencyClassified,
  sortTokens,
  type TranscriptToken,
} from "./transcriptTokens";

// ─── Types ──────────────────────────────────────────────────────────────

export interface SessionDisfluency {
  /** Stable token ID — the SAME id the live transcript token carried. */
  tokenId: string;
  /** COMPLETE word/token (fillers saved IN FULL — never just the first
   *  letter: "um" → "um", "like" → "like"). */
  word: string;
  /** First letter of the normalized word (a–z, lowercased) — exercise
   *  payload for stutter-like disfluencies. Derived from the FULL word. */
  firstLetter: string | null;
  /** Disfluency type: "filler" | "sound_repetition" | "prolongation" |
   *  "word_repetition" | "phrase_repetition" | "revision" | "block" |
   *  "stutter" | "stammer" | "repetition" | "fragment" … */
  type: string;
  /** Session-relative milliseconds (shared BOLO session clock). */
  timeMs: number;
  /** ASR lane that produced the token. */
  source: "deepgram" | "speechmatics";
  /** Sentence/segment association — utterance index (0-based), derived by
   *  the same >1.5s-gap rule the session timeline uses. */
  utterance: number;
  /** The words of the utterance this disfluency belongs to (sentence
   *  context for later exercises). */
  sentence: string;
  /** Wall-clock ISO timestamp when the disfluency was recorded. */
  recordedAt: string;
}

export interface SessionDisfluencySnapshot {
  sessionId: string;
  topic: string | null;
  recordedAt: string;
  items: SessionDisfluency[];
}

// ─── Persistence (survives the live session end) ────────────────────────

const STORAGE_KEY = "bolo_session_disfluencies";
const MAX_STORED_SESSIONS = 12;

/** Same >1.5s gap the session timeline uses for sentence boundaries. */
const UTTERANCE_GAP_MS = 1500;

// ─── Pure helpers ───────────────────────────────────────────────────────

/**
 * Utterance (sentence/segment) index per token id, derived from the token
 * stream with the SAME >1.5s-gap rule the session timeline uses — so the
 * after-session sentence boundaries match the live transcript's grouping.
 */
export function deriveUtterances(
  tokens: TranscriptToken[]
): Map<string, number> {
  const sorted = sortTokens(tokens);
  const map = new Map<string, number>();
  let utterance = 0;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    if (i > 0 && t.startTimeMs - sorted[i - 1].endTimeMs > UTTERANCE_GAP_MS) {
      utterance += 1;
    }
    map.set(t.id, utterance);
  }
  return map;
}

/** Disfluency type of a live transcript token (structured tag first, legacy
 *  `disfluencyType` as backstop). */
export function disfluencyTypeOf(t: TranscriptToken): string {
  return t.disfluency?.type ?? t.disfluencyType ?? "disfluency";
}

export function sortDisfluencies(
  items: SessionDisfluency[]
): SessionDisfluency[] {
  return [...items].sort(
    (a, b) => a.timeMs - b.timeMs || a.tokenId.localeCompare(b.tokenId)
  );
}

/**
 * Build the session disfluency collection from the FINAL live token array.
 *
 * Pure, idempotent, one pass — NO re-detection, NO new transcript. Only
 * tokens the LIVE TRANSCRIPT classified as disfluent are recorded:
 *   • Deepgram tokens with a structured `disfluency` tag (or legacy
 *     isDisfluency/locked flags)
 *   • Speechmatics words the live view colored via the `wordTags` map
 *     (fillers → yellow)
 */
export function collectSessionDisfluencies(
  tokens: TranscriptToken[],
  wordTags?: ReadonlyMap<string, string>
): SessionDisfluency[] {
  const utterances = deriveUtterances(tokens);
  const utteranceTexts = new Map<number, string>();
  for (const t of tokens) {
    const u = utterances.get(t.id) ?? 0;
    utteranceTexts.set(
      u,
      `${utteranceTexts.get(u) ?? ""}${utteranceTexts.has(u) ? " " : ""}${t.word}`
    );
  }

  const items: SessionDisfluency[] = [];
  const nowIso = new Date().toISOString();
  for (const t of tokens) {
    let type: string | null = null;
    if (isDisfluencyClassified(t)) {
      type = disfluencyTypeOf(t);
    } else if (t.source === "speechmatics") {
      // SM words carry no structured tag — the wordTags map (the SAME map
      // the live transcript colored with) supplies the tag.
      const tag = wordTags?.get(`${t.startTimeMs}-${t.endTimeMs}`);
      if (tag) type = tag;
    }
    if (!type) continue;

    const u = utterances.get(t.id) ?? 0;
    items.push({
      tokenId: t.id,
      word: t.word,
      firstLetter:
        t.firstLetter !== undefined ? t.firstLetter : firstLetterOfWord(t.word),
      type,
      timeMs: t.startTimeMs,
      source: t.source,
      utterance: u,
      sentence: utteranceTexts.get(u) ?? "",
      recordedAt: nowIso,
    });
  }
  return sortDisfluencies(items);
}

// ─── localStorage persistence ───────────────────────────────────────────

export function persistSessionDisfluencies(
  snapshot: SessionDisfluencySnapshot
): void {
  try {
    const all = loadStoredDisfluencies();
    all.push(snapshot);
    const trimmed = all.slice(-MAX_STORED_SESSIONS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // non-critical — history persistence is best-effort
  }
}

export function loadStoredDisfluencies(): SessionDisfluencySnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
