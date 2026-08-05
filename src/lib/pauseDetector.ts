/**
 * BOLO — Pause Detector (pure function, shared between unprompted & script modes)
 *
 * Detects and classifies pauses between finalized spoken words.
 * Runs on finalized word timestamps only — never partials.
 * Clusters hesitation fragments into grouped sequences ("so . so . so").
 *
 * Per spec: natural sentence pauses → no score penalty;
 * thinking/awkward/severe pauses → flagged with severity & color.
 */

// ─── Types ──────────────────────────────────────────────────────────

export type PauseType =
  | "natural"
  | "thinking"
  | "awkward"
  | "severe"
  | "hesitation_sequence";

export type PauseSeverity = "none" | "low" | "medium" | "high";

export interface FinalWordLike {
  word: string;
  /** raw text (may include trailing punctuation) */
  text?: string;
  startTime: number;
  endTime: number;
  /** EndOfUtterance counter — changes signal a sentence boundary */
  utterance?: number;
  /** ASR confidence (0..1), for optional metadata */
  confidence?: number;
}

export interface PauseEvent {
  id: string;
  /** Start of silence (previous word's end_time) */
  startTime: number;
  /** End of silence (next word's start_time) */
  endTime: number;
  durationMs: number;
  type: PauseType;
  severity: PauseSeverity;
  confidence: number;
  reason: string[];
  previousWord?: string;
  nextWord?: string;
  isSentenceBoundary: boolean;
  shouldColor: boolean;
  colorToken: string;
}

// ─── Color tokens (consistent pause family across all UI surfaces) ──

export const PAUSE_COLORS = {
  natural: "#8B93A7",    // subtle gray-blue
  thinking: "#60A5FA",   // blue
  awkward: "#FBBF24",    // amber
  severe: "#FB923C",     // red-orange
  hesitation_sequence: "#F59E0B", // strong amber
} as const;

// ─── Configurable thresholds ────────────────────────────────────────

export const PAUSE_THRESHOLDS = {
  /** Gaps below this (ms) are ignored entirely */
  ignore: 200,
  /** Gaps in [ignore, thinking) → thinking pause */
  thinking: 700,
  /** Gaps in [thinking, awkward) → awkward pause */
  awkward: 1800,
  /** Gaps ≥ awkward → severe hesitation */
  /** Rolling window (ms) to merge consecutive fragments into a hesitation sequence */
  groupWindow: 2500,
  /** Max gap (ms) between a fragment's end and the next fragment's start for merging */
  groupMergeGapMs: 1000,
  /** Minimum fragments needed to form a hesitation sequence */
  groupMinFragments: 2,
} as const;

// ─── Short connector words that don't form real sentence boundaries ──

const CONNECTORS = new Set([
  "so", "and", "but", "or", "then", "well", "anyway",
  "also", "now", "okay", "yeah", "right", "like",
]);

// ─── Pure helpers ───────────────────────────────────────────────────

function isSentenceFinalWord(w: string): boolean {
  const t = w.trim();
  if (!t) return false;
  const last = t[t.length - 1];
  return last === "." || last === "!" || last === "?" || last === "\u2026";
}

function cleanWord(w: string): string {
  return w.replace(/[^a-zA-Z]/g, "").toLowerCase();
}

function removePunctuation(w: string): string {
  return w.replace(/[^a-zA-Z']/g, "");
}

// ─── Pause detection ───────────────────────────────────────────────

let uid = 0;

/**
 * Given a list of finalized words in chronological order,
 * produce classified PauseEvents.
 *
 * Words should be the FULL list (not incremental); for incremental
 * use, cache the last processed word index and re-invoke with the
 * full list — the function skips already-seen words internally.
 *
 * Set `lastProcessedIndex` to 0 for a fresh pass; reuse the index
 * returned from a previous call for incremental updates.
 */
export function detectPauses(
  words: FinalWordLike[],
  lastProcessedIndex: number = 0
): { pauses: PauseEvent[]; nextIndex: number } {
  const events: PauseEvent[] = [];

  if (words.length < 2) return { pauses: events, nextIndex: lastProcessedIndex };

  const start = Math.max(1, lastProcessedIndex);
  const sorted = words; // caller must pass chronologically

  for (let i = start; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (!prev.word && !prev.text) continue;
    if (!next.word && !next.text) continue;

    const startMs = prev.endTime * 1000;
    const endMs = next.startTime * 1000;
    const gapMs = endMs - startMs;

    if (gapMs < PAUSE_THRESHOLDS.ignore) continue;

    const prevText = prev.text || prev.word;
    const nextText = next.text || next.word;
    const prevClean = removePunctuation(prevText);
    const nextClean = removePunctuation(nextText);

    // ── Sentence boundary detection ──────────────────────────
    // A real sentence boundary: the previous word ends with
    // terminal punctuation AND is NOT a short connector
    // that ASR may have punctuated mid-fragment.
    const prevEndsSentence =
      isSentenceFinalWord(prevText) &&
      !CONNECTORS.has(cleanWord(prevText));

    // Utterance boundary (EndOfUtterance fired) — strong signal
    const uttChanged =
      prev.utterance !== undefined &&
      next.utterance !== undefined &&
      prev.utterance !== next.utterance;

    const isSentenceBoundary = prevEndsSentence || uttChanged;

    // ── Classify ─────────────────────────────────────────────
    let type: PauseType;
    let severity: PauseSeverity;
    let confidence: number;

    if (isSentenceBoundary || gapMs < PAUSE_THRESHOLDS.thinking) {
      // Natural (if boundary) or thinking (if short mid-thought)
      if (isSentenceBoundary) {
        type = "natural";
        severity = "none";
        confidence = 0.95;
      } else {
        type = "thinking";
        severity = "low";
        confidence = 0.5 + (gapMs - PAUSE_THRESHOLDS.ignore) / PAUSE_THRESHOLDS.thinking * 0.4;
      }
    } else if (gapMs < PAUSE_THRESHOLDS.awkward) {
      type = "awkward";
      severity = "medium";
      confidence = 0.5 + (gapMs - PAUSE_THRESHOLDS.thinking) / (PAUSE_THRESHOLDS.awkward - PAUSE_THRESHOLDS.thinking) * 0.4;
    } else {
      type = "severe";
      severity = "high";
      confidence = 0.7 + Math.min(0.3, (gapMs - PAUSE_THRESHOLDS.awkward) / 3000 * 0.3);
    }

    // ── Build reason ─────────────────────────────────────────
    const reason: string[] = [];
    if (isSentenceBoundary) {
      reason.push("Sentence boundary pause — not counted as awkward.");
    } else if (type === "thinking") {
      reason.push(`Short hesitation of ${(gapMs / 1000).toFixed(1)}s.`);
    } else if (type === "awkward") {
      reason.push(`Awkward pause of ${(gapMs / 1000).toFixed(1)}s mid-sentence.`);
    } else {
      reason.push(`Long hesitation of ${(gapMs / 1000).toFixed(1)}s — broke the flow.`);
    }

    if (!isSentenceBoundary && nextClean) {
      reason.push(`Resumed with "${nextClean}".`);
    }

    const evt: PauseEvent = {
      id: `pause-${uid++}`,
      startTime: prev.endTime,
      endTime: next.startTime,
      durationMs: Math.round(gapMs),
      type,
      severity,
      confidence: Math.min(1, confidence),
      reason,
      previousWord: prevClean || undefined,
      nextWord: nextClean || undefined,
      isSentenceBoundary,
      shouldColor: !isSentenceBoundary || gapMs > PAUSE_THRESHOLDS.awkward,
      colorToken: PAUSE_COLORS[type],
    };

    events.push(evt);
  }

  // ── Merge hesitation sequences ─────────────────────────────
  // Walk classified events and merge consecutive thinking/awkward/severe
  // pauses that fall within a short rolling window.
  const merged = mergeHesitationSequences(events);

  return { pauses: merged, nextIndex: sorted.length };
}

// ─── Hesitation sequence merging ──────────────────────────────────

function mergeHesitationSequences(events: PauseEvent[]): PauseEvent[] {
  if (events.length < 2) return events;

  const result: PauseEvent[] = [];
  let i = 0;

  while (i < events.length) {
    // Skip natural pauses — never merge them
    if (events[i].type === "natural") {
      result.push(events[i]);
      i++;
      continue;
    }

    // Collect a run of non-natural pauses that can merge
    const run: PauseEvent[] = [events[i]];
    let j = i + 1;

    while (j < events.length) {
      const prevEvt = run[run.length - 1];
      const curEvt = events[j];

      if (curEvt.type === "natural") break;

      // Check merge window: gap from prev's end to cur's start
      const gapBetween = curEvt.startTime - prevEvt.endTime;
      const spanTotal = (curEvt.endTime - run[0].startTime) * 1000;

      if (
        gapBetween * 1000 <= PAUSE_THRESHOLDS.groupMergeGapMs &&
        spanTotal <= PAUSE_THRESHOLDS.groupWindow
      ) {
        run.push(curEvt);
        j++;
      } else {
        break;
      }
    }

    // ── Emit merged sequence or individual events ────────────
    if (run.length >= PAUSE_THRESHOLDS.groupMinFragments) {
      const totalSilenceMs = run.reduce((s, e) => s + e.durationMs, 0);
      const first = run[0];
      const last = run[run.length - 1];

      // Severity = max of fragments (at least medium if any awkward)
      const severities = run.map((e) => e.severity);
      let seqSeverity: PauseSeverity = "low";
      if (severities.includes("high")) seqSeverity = "high";
      else if (severities.includes("medium")) seqSeverity = "medium";

      const seqConfidence = Math.min(
        1,
        0.6 + run.reduce((s, e) => s + e.confidence, 0) / run.length * 0.3
      );

      const seq: PauseEvent = {
        id: `pause-seq-${run[0].id}`,
        startTime: first.startTime,
        endTime: last.endTime,
        durationMs: Math.round((last.endTime - first.startTime) * 1000),
        type: "hesitation_sequence",
        severity: seqSeverity,
        confidence: seqConfidence,
        reason: [
          `Hesitation sequence over ${(totalSilenceMs / 1000).toFixed(1)}s total (${run.length} fragments).`,
          ...(first.previousWord ? [`Paused after "${first.previousWord}".`] : []),
          ...(last.nextWord ? [`Resumed with "${last.nextWord}".`] : []),
        ],
        previousWord: first.previousWord,
        nextWord: last.nextWord,
        isSentenceBoundary: false,
        shouldColor: true,
        colorToken: PAUSE_COLORS.hesitation_sequence,
      };
      result.push(seq);
    } else {
      // Not enough fragments — emit individually
      for (const evt of run) result.push(evt);
    }

    i = j;
  }

  return result;
}