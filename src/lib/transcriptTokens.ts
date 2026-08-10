/**
 * BOLO — Structured Live Transcript Token Model + Deepgram↔Speechmatics
 * Temporal Reconciliation Engine
 *
 * The live transcript is an ARRAY of structured tokens, never a single
 * concatenated string. Deepgram is the PRIMARY live transcription source
 * (its FINAL words — fluent and disfluent — are permanent tokens);
 * Speechmatics is the SECONDARY/fallback source for missing/unclear words.
 *
 * Every update to the array goes through reconcileIncoming() which:
 *   1. reconciles the incoming token against the existing array
 *   2. removes collisions / duplicates
 *   3. sorts by startTimeMs
 *   4. returns hidden Speechmatics keys (so the chunk renderer can hide
 *      Speechmatics words that a locked Deepgram token replaced)
 *
 * Both providers report on the SAME session clock (lib/sessionClock) —
 * every startTimeMs / endTimeMs here is session-relative milliseconds.
 *
 * Timestamps are compared TEMPORALLY, never by string equality: a Deepgram
 * "slap" and a Speechmatics "rap" that overlap in time are competing
 * recognitions of the same spoken interval, and the Deepgram disfluency
 * token wins (it carries the disfluency evidence).
 */

export type TranscriptTokenSource = "speechmatics" | "deepgram";

export interface TranscriptToken {
  id: string;
  /** NORMALIZED visible lexical word (never raw phonetic stutter text). */
  word: string;
  /** Original provider output — kept for detection/debugging only. */
  rawWord?: string;
  /** Session-relative milliseconds (shared BOLO session clock). */
  startTimeMs: number;
  endTimeMs: number;
  source: TranscriptTokenSource;
  /**
   * For the transcript-routing layer every Deepgram abnormality is
   * normalized to `true`; the exact subtype stays in `disfluencyType`
   * metadata for later analytics.
   */
  isDisfluency: boolean;
  /**
   * STRUCTURED Deepgram disfluency tag — the object the LIVE TRANSCRIPT
   * renderer reads to draw the purple underline. `disfluency != null`
   * means "this word IS a disfluency" (never a Detection Feed concern).
   */
  disfluency?: {
    type: string;
    confidence: number;
  } | null;
  /**
   * Once a Deepgram disfluency token is reconciled it is locked —
   * a later Speechmatics token competing for the same slot is discarded.
   */
  locked: boolean;
  disfluencyType?: string;
  confidence?: number;
  /**
   * First letter of the NORMALIZED word (a–z, lowercased) — derived from
   * the normalized word, NEVER from punctuation. `null` when the word has
   * no letters at all (e.g. "123", "…"). Populated by the token producers
   * (TranscriptTokenIndex reads it; falls back to firstLetterOfWord()).
   */
  firstLetter?: string | null;
  /** Lowercased comparison form of `word` (normWord() at creation time). */
  normalizedWord?: string;
}

// ─── Constants (spec) ──────────────────────────────────────────────────

/** Candidate lexical replacement window around a Deepgram event (ms). */
export const RECONCILIATION_WINDOW_MS = 400;
/** Lock padding around a confirmed Deepgram disfluency event (ms). */
export const LOCK_WINDOW_MS = 400;

// ─── Pure helpers ──────────────────────────────────────────────────────

/** Conservative lexical normalizer for COMPARISON (not for display). */
export function normWord(w?: string): string {
  return (w ?? "").toLowerCase().replace(/[^a-z0-9']/g, "");
}

export function overlapMs(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function midpointMs(t: { startTimeMs: number; endTimeMs: number }): number {
  return (t.startTimeMs + t.endTimeMs) / 2;
}

function midpointDistanceMs(
  a: { startTimeMs: number; endTimeMs: number },
  b: { startTimeMs: number; endTimeMs: number }
): number {
  return Math.abs(midpointMs(a) - midpointMs(b));
}

/** Stable token key — the SAME format the transcript renderer uses to
 *  hide Speechmatics words (ms-rounded start/end). */
export function tokenKey(t: {
  startTimeMs: number;
  endTimeMs: number;
}): string {
  return `${Math.round(t.startTimeMs)}-${Math.round(t.endTimeMs)}`;
}

/** Padded lock window around a confirmed Deepgram event (LOCK_WINDOW_MS). */
export function lockWindow(t: {
  startTimeMs: number;
  endTimeMs: number;
}): { start: number; end: number } {
  return {
    start: Math.max(0, t.startTimeMs - LOCK_WINDOW_MS),
    end: t.endTimeMs + LOCK_WINDOW_MS,
  };
}

/**
 * Does a (later) Speechmatics token compete for the SAME spoken slot as a
 * locked Deepgram disfluency token? It must overlap the padded lock window
 * AND either overlap the Deepgram interval directly or center on it.
 * This prevents the race {DG "slap" first → SM "rap" later overwrites it}
 * while NEVER eating legitimate adjacent words ("the", "ball").
 */
export function suppressedByLock(
  t: { startTimeMs: number; endTimeMs: number },
  locked: { startTimeMs: number; endTimeMs: number }
): boolean {
  const lw = lockWindow(locked);
  if (overlapMs(t.startTimeMs, t.endTimeMs, lw.start, lw.end) <= 0) return false;
  const directOverlap =
    overlapMs(
      t.startTimeMs,
      t.endTimeMs,
      locked.startTimeMs,
      locked.endTimeMs
    ) > 0;
  const smMid = midpointMs(t);
  const midInside =
    smMid >= locked.startTimeMs && smMid <= locked.endTimeMs;
  return directOverlap || midInside;
}

/**
 * Rule 3+4: find the best Speechmatics candidate for a Deepgram disfluency
 * token. A candidate qualifies ONLY if it falls inside the reconciliation
 * window around the Deepgram event (direct interval overlap, or its
 * midpoint within RECONCILIATION_WINDOW_MS). Among candidates, the one
 * with the greatest temporal overlap wins; ties break by smallest midpoint
 * distance.
 */
export function findReplacementCandidate(
  tokens: TranscriptToken[],
  dgToken: { startTimeMs: number; endTimeMs: number }
): TranscriptToken | null {
  let best: TranscriptToken | null = null;
  let bestOverlap = -1;
  let bestMidDist = Infinity;
  for (const t of tokens) {
    if (t.source === "deepgram") continue; // only replace Speechmatics words
    if (t.locked) continue;
    const ov = overlapMs(
      dgToken.startTimeMs,
      dgToken.endTimeMs,
      t.startTimeMs,
      t.endTimeMs
    );
    const midDist = midpointDistanceMs(dgToken, t);
    // Do NOT replace arbitrary nearby words — the temporal candidate must
    // pass the reconciliation window.
    if (ov <= 0 && midDist > RECONCILIATION_WINDOW_MS) continue;
    if (ov > bestOverlap || (ov === bestOverlap && midDist < bestMidDist)) {
      best = t;
      bestOverlap = ov;
      bestMidDist = midDist;
    }
  }
  return best;
}

export function sortTokens(tokens: TranscriptToken[]): TranscriptToken[] {
  // React-state-safe: never mutate the source array.
  return [...tokens].sort((a, b) => a.startTimeMs - b.startTimeMs);
}

// ─── First-letter metadata + TranscriptTokenIndex ──────────────────────

/**
 * First letter of the NORMALIZED word (a–z, lowercased) — derived from the
 * normalized word, NEVER from punctuation. `null` when the word has no
 * letters at all ("123", "…").
 *
 *   "Hello" → "h"   "things" → "t"   "don't" → "d"
 *   "123" → null    "um" → "u"
 */
export function firstLetterOfWord(w?: string): string | null {
  const m = (w ?? "").toLowerCase().match(/[a-z]/);
  return m ? m[0] : null;
}

/** Ensure a token carries its first-letter + normalized-word metadata.
 *  Idempotent: an explicitly-set value is preserved, never recomputed. */
export function withFirstLetterMetadata<T extends TranscriptToken>(t: T): T {
  if (t.firstLetter !== undefined && t.normalizedWord !== undefined) return t;
  return {
    ...t,
    firstLetter:
      t.firstLetter !== undefined ? t.firstLetter : firstLetterOfWord(t.word),
    normalizedWord: t.normalizedWord ?? normWord(t.word),
  };
}

/**
 * BOLO — TranscriptTokenIndex
 *
 * Maintains the relationship between every live transcript token's STABLE
 * id, word, normalized word, first letter, timestamps, source and
 * disfluency metadata. Identity is preserved by id: a word that already
 * exists in the index is REFRESHED, never re-minted, so partial/final
 * transcript updates keep ONE stable identity per spoken word.
 *
 * Pure data structure — performs NO detection and NO reclassification.
 * Use `get(id)` to select a token by its stable id.
 */
export class TranscriptTokenIndex {
  private byId = new Map<string, TranscriptToken>();
  private ordered: TranscriptToken[] = [];

  static fromTokens(tokens: TranscriptToken[]): TranscriptTokenIndex {
    const idx = new TranscriptTokenIndex();
    idx.rebuild(tokens);
    return idx;
  }

  /** Rebuild from the reconciled array, preserving identity by stable id. */
  rebuild(tokens: TranscriptToken[]): void {
    this.byId.clear();
    for (const t of tokens) {
      const meta = withFirstLetterMetadata(t);
      const existing = this.byId.get(meta.id);
      this.byId.set(
        meta.id,
        existing ? { ...existing, ...meta, id: existing.id } : meta
      );
    }
    this.ordered = sortTokens([...this.byId.values()]);
  }

  /** Retrieve a token by its stable id. */
  get(id: string): TranscriptToken | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get size(): number {
    return this.byId.size;
  }

  /** All indexed tokens, sorted by startTimeMs (chronological order). */
  all(): TranscriptToken[] {
    return this.ordered;
  }
}

// ─── LIVE UNDERLINE SAFETY RULE (visual-only gate) ─────────────────────

/**
 * Same predicate the LIVE TRANSCRIPT renderer uses for the purple
 * underline: structured `disfluency` tag first, legacy flags as backstops.
 */
export function isDisfluencyClassified(t: TranscriptToken): boolean {
  return t.disfluency != null || t.isDisfluency === true || t.locked === true;
}

function firstLetterOfToken(t: TranscriptToken): string | null {
  return t.firstLetter !== undefined ? t.firstLetter : firstLetterOfWord(t.word);
}

function allSameFirstLetter(run: TranscriptToken[]): boolean {
  const first = firstLetterOfToken(run[0]);
  return run.every((t) => firstLetterOfToken(t) === first);
}

/**
 * LIVE UNDERLINE SAFETY RULE — different-first-letter runs.
 *
 * Detection is untouched. This is a purely VISUAL safety gate evaluated
 * BEFORE rendering: when 3 or more CONSECUTIVE disfluency-classified
 * tokens in the transcript stream do NOT all share the same first letter,
 * the purple underline is suppressed for the WHOLE run.
 *
 *   "things that don't really" → t / t / d / r → suppressed
 *   "things that don't"        → t / t / d     → suppressed (3, mixed)
 *   "ma ma ma ma"              → m / m / m / m → KEPT (same initial)
 *   "germ ger ge german"       → g / g / g / g → KEPT
 *   "i i i i"                  → i / i / i / i → KEPT
 *
 * The underlying detection events are never deleted or altered — this only
 * decides whether the renderer draws the purple underline.
 */
export function suppressedUnderlineTokenIds(
  tokens: TranscriptToken[]
): Set<string> {
  const suppressed = new Set<string>();
  const sorted = sortTokens(tokens);
  let i = 0;
  while (i < sorted.length) {
    if (!isDisfluencyClassified(sorted[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < sorted.length && isDisfluencyClassified(sorted[j])) j += 1;
    const run = sorted.slice(i, j);
    if (run.length >= 3 && !allSameFirstLetter(run)) {
      for (const t of run) suppressed.add(t.id);
    }
    i = j;
  }
  return suppressed;
}

// ─── Reconciliation ────────────────────────────────────────────────────

export interface ReconcileResult {
  tokens: TranscriptToken[];
  /** Speechmatics token keys discarded (hidden from the chunk renderer). */
  hiddenKeys: string[];
}

/**
 * Reconcile ONE incoming token against the current array.
 *
 * Deepgram (PRIMARY source, fluent + disfluent finals):
 *   • disfluent → locked token (fast-track; Speechmatics can never
 *     overwrite it); replaces a competing Speechmatics word in the slot
 *   • fluent → normal permanent token; competing Speechmatics words for
 *     the same slot are removed (Deepgram wins the spoken slot)
 *
 * Speechmatics (secondary/fallback):
 *   • competing with a locked Deepgram disfluency token → DISCARD
 *     (rule: Speechmatics cannot overwrite a confirmed disfluency)
 *   • competing with a fluent Deepgram token → DISCARD (Deepgram primary)
 *   • exact slot+word duplicate → never rendered twice
 *   • otherwise → committed normally (fills gaps Deepgram missed)
 */
export function reconcileIncoming(
  tokens: TranscriptToken[],
  incoming: TranscriptToken
): ReconcileResult {
  const hiddenKeys: string[] = [];
  let next = tokens;

  // ── Deepgram final word (PRIMARY — fluent AND disfluent) ────────────
  if (incoming.source === "deepgram") {
    const dg: TranscriptToken = {
      ...incoming,
      isDisfluency: incoming.isDisfluency,
      locked: incoming.isDisfluency, // only disfluencies lock the slot
    };

    // Disfluent: replace a competing Speechmatics candidate (same slot).
    if (dg.isDisfluency) {
      const candidate = findReplacementCandidate(next, dg);
      if (candidate) {
        hiddenKeys.push(tokenKey(candidate));
        next = next.filter((t) => t !== candidate);
        if (normWord(candidate.word) === normWord(dg.word)) {
          // Same lexical word: merge into ONE token. Retain deepgram
          // source + locked so Speechmatics can never overwrite it later.
          dg.rawWord = dg.rawWord ?? candidate.rawWord ?? candidate.word;
          dg.word = dg.word || candidate.word;
          // First-letter metadata stays derived from the merged word; the
          // Speechmatics candidate (discarded below) carried its own copy.
        }
      }
    }

    // Competing Speechmatics tokens overlapping the Deepgram interval
    // directly are duplicates of the same spoken word — remove them all
    // (Deepgram is primary; it wins the spoken slot).
    const competing = next.filter(
      (t) =>
        t.source === "speechmatics" &&
        overlapMs(
          dg.startTimeMs,
          dg.endTimeMs,
          t.startTimeMs,
          t.endTimeMs
        ) > 0
    );
    for (const c of competing) hiddenKeys.push(tokenKey(c));
    next = next.filter((t) => !competing.includes(t));

    // Dedupe against an existing identical Deepgram token (re-finalized word).
    const dgKey = tokenKey(dg);
    const existing = next.find(
      (t) => t.source === "deepgram" && tokenKey(t) === dgKey
    );
    if (existing) {
      next = next.map((t) =>
        t === existing
          ? {
              ...existing,
              locked: t.isDisfluency || dg.isDisfluency,
              isDisfluency: t.isDisfluency || dg.isDisfluency,
              // Structured tag must survive the merge — the renderer reads
              // `disfluency != null` for the purple underline.
              disfluency: existing.disfluency ?? dg.disfluency ?? null,
              disfluencyType: existing.disfluencyType ?? dg.disfluencyType,
              rawWord: existing.rawWord ?? dg.rawWord,
            }
          : t
      );
    } else {
      next = [...next, dg];
    }

    return { tokens: sortTokens(next), hiddenKeys };
  }

  // ── Speechmatics final word (secondary/fallback) ────────────────────
  // Locked-DG protection + fluent-DG protection: a competing SM word for
  // the same slot is discarded (never overwrites the Deepgram token).
  for (const lk of next) {
    if (lk.source === "deepgram" && suppressedByLock(incoming, lk)) {
      hiddenKeys.push(tokenKey(incoming));
      return { tokens: next, hiddenKeys };
    }
  }
  // Exact duplicate (same slot + same lexical word) — never twice.
  const key = tokenKey(incoming);
  const dup = next.some(
    (t) =>
      t.source === "speechmatics" &&
      tokenKey(t) === key &&
      normWord(t.word) === normWord(incoming.word)
  );
  if (dup) {
    hiddenKeys.push(key);
    return { tokens: next, hiddenKeys };
  }
  // Near-duplicate: same lexical word occupying ~the same slot (>50%
  // overlap of the shorter interval) — keep the first, hide the second.
  const inDur = Math.max(1, incoming.endTimeMs - incoming.startTimeMs);
  const nearDup = next.some((t) => {
    if (t.source !== "speechmatics") return false;
    if (normWord(t.word) !== normWord(incoming.word)) return false;
    const ov = overlapMs(
      incoming.startTimeMs,
      incoming.endTimeMs,
      t.startTimeMs,
      t.endTimeMs
    );
    const tDur = Math.max(1, t.endTimeMs - t.startTimeMs);
    return ov / Math.min(inDur, tDur) >= 0.5;
  });
  if (nearDup) {
    hiddenKeys.push(key);
    return { tokens: next, hiddenKeys };
  }
  next = [...next, { ...incoming, locked: false }];
  return { tokens: sortTokens(next), hiddenKeys };
}
