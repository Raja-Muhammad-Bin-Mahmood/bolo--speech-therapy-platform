/**
 * BOLO — Stage 1: Interruption Gate (speech-flow validation)
 *
 * The acoustic detectors are tuned for RECALL — they flag every short
 * anomaly — which produces false-positive stutters in fluent speech
 * ("could", "travel", "think", "the", "any" get labeled as stutters).
 * Before ANY candidate may be classified as a stutter/stammer, it must
 * prove the speech FLOW was interrupted. A lone unusual phoneme in an
 * otherwise fluent phrase is never a stutter.
 *
 * The gate passes when at least ONE interruption signal exists:
 *
 *   1. PRE-ONSET ARREST  — the previous word ended ≥ 100 ms before the
 *      word being labeled began (the reasonable delay between the two
 *      words: 0.1 s). Covers "…could" after a brief speech arrest and
 *      blocks leading into a word ("------cat").
 *   2. REPEATED ONSET    — the event itself is a repeated-onset pattern
 *      (repetition / stutter: ≥3 fragments with 40–250 ms micro-gaps,
 *      "b-b-b-ball", "s-s-s-slap") that does NOT span several finalized
 *      words. A pattern spanning multiple words is fluent multi-word
 *      speech misread as one repetition.
 *   3. SUSTAINED SEGMENT — a prolongation / stammer hold ("mmmm-more",
 *      "ssss-slap") of ≥ 350 ms, or a held stammer ≥ 250 ms that
 *      releases into a word.
 *   4. SPEECH-ONSET BLOCK — a silent block ("------cat") of ≥ 200 ms
 *      that releases into a following word.
 *
 * The internal micro-pause is a VALIDATION SIGNAL ONLY — it is never
 * shown in the Detection Feed or the transcript, and it is distinct from
 * the visible "Pause" event. Its only job is to answer "was there enough
 * interruption in the speech flow to justify running the stutter
 * classifier?" If not, the candidate is normal fluent speech.
 *
 * Rejections are deliberately conservative — false positives are worse
 * than misses.
 */

// ─── Spec numbers ─────────────────────────────────────────────────────────

export const INTERRUPTION_GATE_SPEC = {
  /** Pre-onset arrest: previous word → labeled word gap (user: 0.1 s). */
  ARREST_MIN_S: 0.1,
  /** Repeated-onset (repetition/stutter) intrinsic floor — the detector's
   *  own minimum pattern spans ≈150 ms (3 fragments × 40–250 ms gaps). */
  REPEATED_ONSET_MIN_MS: 150,
  /** Prolongation floor — matches the fusion layer's "real prolongation"
   *  350 ms rule and the acoustic-rules doc. */
  PROLONGATION_MIN_MS: 350,
  /** Stammer (held fricative) floor — must also release into a word so a
   *  breath/sniff between words is not a stammer. */
  STAMMER_MIN_MS: 250,
  /** Speech-onset block floor (detector BLOCK_MIN_MS = 200 ms). */
  BLOCK_MIN_MS: 200,
  /** A real event may not span more than one finalized word. */
  MAX_SPANNED_WORDS: 1,
  /** Flush tolerance when counting a pre-onset fragment as "inside" a word. */
  FLUSH_TOLERANCE_S: 0.05,
} as const;

// ─── Input / output ───────────────────────────────────────────────────────

/** Minimal word shape both consumers (fusion + event engine) can provide. */
export interface WordTimes {
  startTime: number;
  endTime: number;
}

export interface InterruptionGateInput {
  /** Raw detector type (stutter / stammer / block / repetition / prolongation). */
  type: string;
  /** Event start (session clock, seconds). */
  startTime: number;
  /** Event end (seconds). */
  endTime: number | null;
  durationMs: number;
  /** End time of the previous finalized word (null when none exists yet). */
  prevWordEnd: number | null;
  /** Start time of the word being labeled (null when none attached yet). */
  wordStart: number | null;
  /** How many finalized words the event window overlaps / flushes against. */
  overlappingWords: number;
}

export interface InterruptionVerdict {
  /** true = interrupted speech flow — safe to classify; false = fluent. */
  passed: boolean;
  /** Human-readable interruption evidence (empty when rejected). */
  signals: string[];
  /** Why the candidate was rejected (null when passed). */
  rejectionReason: string | null;
}

// ─── Shared word helpers ──────────────────────────────────────────────────

/**
 * End time of the latest finalized word that ENDS before `refTime`
 * (the word spoken before the word being labeled), or null.
 */
export function findPrevWordEnd(
  words: WordTimes[],
  refTime: number
): number | null {
  let prevEnd: number | null = null;
  for (const w of words) {
    if (w.endTime <= refTime + 1e-3 && (prevEnd === null || w.endTime > prevEnd)) {
      prevEnd = w.endTime;
    }
  }
  return prevEnd;
}

/**
 * How many finalized words the event window [startTime, endTime] touches:
 * direct overlap, or a pre-onset fragment sitting flush (≤ 50 ms) before a
 * word onset (that fragment is part of the word's onset cluster, not a
 * separate word). Used to reject patterns that span several words — the
 * shape of fluent multi-word speech, not a stutter.
 */
export function countSpannedWords(
  words: WordTimes[],
  startTime: number,
  endTime: number
): number {
  let n = 0;
  const tol = INTERRUPTION_GATE_SPEC.FLUSH_TOLERANCE_S;
  for (const w of words) {
    const inter = Math.min(w.endTime, endTime) - Math.max(w.startTime, startTime);
    if (inter > 0) {
      n++;
      continue;
    }
    const preGap = w.startTime - endTime;
    if (preGap >= -tol && preGap <= tol) n++;
  }
  return n;
}

// ─── The gate ─────────────────────────────────────────────────────────────

export function evaluateInterruptionGate(
  input: InterruptionGateInput
): InterruptionVerdict {
  const signals: string[] = [];
  const type = (input.type ?? "").toLowerCase();
  const spec = INTERRUPTION_GATE_SPEC;

  // 1) Pre-onset arrest — the reasonable delay (≥ 0.1 s) between the
  //    previous word and the word being labeled. Uses the labeled word's
  //    onset when available, otherwise the event's own start.
  if (input.prevWordEnd != null) {
    const ref = input.wordStart ?? input.startTime;
    const gapMs = (ref - input.prevWordEnd) * 1000;
    if (ref >= input.prevWordEnd && gapMs >= spec.ARREST_MIN_S * 1000) {
      signals.push(
        `speech arrest before onset (${Math.round(gapMs)}ms gap from the previous word)`
      );
    }
  }

  const repeatedOnset = type === "repetition" || type === "stutter";
  const sustained = type === "prolongation";
  const stammerHold = type === "stammer";
  const onsetBlock = type === "block" || type === "tense_block";

  // 2) Repeated onset — the event itself is a cluster of ≥3 fragments with
  //    micro-gaps ("b-b-b-ball"). Must not span several finalized words.
  if (
    repeatedOnset &&
    input.durationMs >= spec.REPEATED_ONSET_MIN_MS &&
    input.overlappingWords <= spec.MAX_SPANNED_WORDS
  ) {
    signals.push(
      `repeated-onset fragments (${input.durationMs}ms, ${input.overlappingWords} spanned word${input.overlappingWords === 1 ? "" : "s"})`
    );
  }

  // 3a) Sustained prolongation — a held vowel/sound ≥ 350 ms.
  if (sustained && input.durationMs >= spec.PROLONGATION_MIN_MS) {
    signals.push(`sustained segment (${input.durationMs}ms)`);
  }

  // 3b) Stammer — a held fricative that releases into a word (the release
  //     is the interruption; without a word it is a breath/sniff).
  if (
    stammerHold &&
    input.durationMs >= spec.STAMMER_MIN_MS &&
    input.wordStart != null
  ) {
    signals.push(`held sound released into a word (${input.durationMs}ms)`);
  }

  // 4) Speech-onset block — silent arrest ≥ 200 ms releasing into a word.
  if (
    onsetBlock &&
    input.durationMs >= spec.BLOCK_MIN_MS &&
    input.wordStart != null
  ) {
    signals.push(`speech-onset block (${input.durationMs}ms before a word)`);
  }

  if (signals.length > 0) {
    return { passed: true, signals, rejectionReason: null };
  }

  return {
    passed: false,
    signals: [],
    rejectionReason:
      `No interruption in speech flow (${type}, ${input.durationMs}ms) — ` +
      `no micro-pause before the word, no repeated onset, no sustained segment, ` +
      `no onset block — treated as normal fluent speech`,
  };
}
