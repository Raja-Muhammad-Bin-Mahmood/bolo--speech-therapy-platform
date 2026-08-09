/**
 * BOLO — Structured Live Transcript Token Model + Deepgram↔Speechmatics
 * Temporal Reconciliation Engine
 *
 * The live transcript is an ARRAY of structured tokens, never a single
 * concatenated string. Speechmatics is the PRIMARY clean transcription
 * source; Deepgram is a SECONDARY real-time disfluency/lexical source.
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
   * Once a Deepgram disfluency token is reconciled it is locked —
   * a later Speechmatics token competing for the same slot is discarded.
   */
  locked: boolean;
  disfluencyType?: string;
  confidence?: number;
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

// ─── Reconciliation ────────────────────────────────────────────────────

export interface ReconcileResult {
  tokens: TranscriptToken[];
  /** Speechmatics token keys discarded (hidden from the chunk renderer). */
  hiddenKeys: string[];
}

/**
 * Reconcile ONE incoming token against the current array.
 *
 * Speechmatics (fluent final):
 *   • competing with a locked Deepgram disfluency token → DISCARD
 *     (rule: Speechmatics cannot overwrite a confirmed disfluency)
 *   • exact slot+word duplicate → never rendered twice
 *   • otherwise → committed normally
 *
 * Deepgram disfluency (final):
 *   • candidate Speechmatics token inside the reconciliation window →
 *     REPLACE (remove the Speechmatics token, insert the Deepgram token);
 *     same lexical word → MERGE into one token (source deepgram, locked)
 *   • no candidate → INSERT as a new locked token (fast-track)
 *   • other Speechmatics tokens overlapping the Deepgram interval are
 *     competing duplicates → removed
 *
 * Fluent Deepgram words never enter the permanent transcript — Speechmatics
 * remains the primary source for normal fluent transcription.
 */
export function reconcileIncoming(
  tokens: TranscriptToken[],
  incoming: TranscriptToken
): ReconcileResult {
  const hiddenKeys: string[] = [];
  let next = tokens;

  // Fluent Deepgram words must NOT override Speechmatics — skip entirely.
  if (incoming.source === "deepgram" && !incoming.isDisfluency) {
    return { tokens: next, hiddenKeys };
  }

  // ── Speechmatics final word ─────────────────────────────────────────
  if (incoming.source === "speechmatics") {
    // Locked-DG protection: a competing SM word for the same slot is
    // discarded from the LIVE transcript (never overwrites the marker).
    for (const lk of next) {
      if (
        lk.source === "deepgram" &&
        lk.isDisfluency &&
        lk.locked &&
        suppressedByLock(incoming, lk)
      ) {
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

  // ── Deepgram disfluency final (the fast-track path) ─────────────────
  const dg: TranscriptToken = { ...incoming, locked: true, isDisfluency: true };

  const candidate = findReplacementCandidate(next, dg);
  if (candidate) {
    hiddenKeys.push(tokenKey(candidate));
    next = next.filter((t) => t !== candidate);
    if (normWord(candidate.word) === normWord(dg.word)) {
      // Rule 7 — same lexical word: merge into ONE token. Retain deepgram
      // source + locked so Speechmatics can never overwrite it later.
      dg.rawWord = dg.rawWord ?? candidate.rawWord ?? candidate.word;
      dg.word = dg.word || candidate.word;
    }
  }

  // Competing Speechmatics tokens overlapping the Deepgram interval
  // directly are duplicates of the same spoken word — remove them all.
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
            locked: true,
            isDisfluency: true,
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
