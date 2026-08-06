/**
 * BOLO — Conservative Stutter Fusion Engine
 *
 * Binds AudioWorklet CANDIDATES to finalized Speechmatics WORDS by
 * timestamp. Rules (from the mission spec):
 *
 * - acoustic evidence weak → event kept internal (uncertain), never highlighted
 * - confidence below threshold → not highlighted, not counted in headline totals
 * - event clearly overlapping a word → attached to that word (matchedWord)
 * - event before a word onset (block/tense_block) → attached to the onset area
 * - Speechmatics disfluency tag → supporting evidence only (we never rely on it alone)
 * - a natural sentence-boundary pause is NEVER promoted to a stutter event
 * - a specific event (repetition/prolongation/block) wins over a generic
 *   hesitation_sequence that merely contains it
 *
 * False positives are worse than misses.
 */

import {
  type StutterCandidate,
  type StutterEvent,
  type StutterEventType,
  type StutterSummary,
  STUTTER_COLORS,
  STUTTER_LABELS,
  FUSION_THRESHOLDS,
  severityFromConfidence,
  wordKey,
  overlapRatio,
} from "./stutterTypes";
import type { PauseEvent } from "./pauseDetector";

// ─── Input shape ─────────────────────────────────────────────────────────

export interface FinalWord {
  text: string;
  startTime: number;
  endTime: number;
  /** 0..1 — ASR confidence (metadata only, never a penalty signal) */
  confidence?: number;
  utterance?: number;
}

export interface FuseInput {
  candidates: StutterCandidate[];
  words: FinalWord[];
  /** Pause events (from the pause detector) — used to suppress natural-boundary false positives */
  pauseEvents?: PauseEvent[];
  /** Speechmatics disfluency tags, keyed by wordKey — supporting evidence only */
  speechmaticsTags?: Map<string, string>;
}

export interface FuseResult {
  events: StutterEvent[];
  /** wordKey → best event attached to that word (for live transcript coloring) */
  annotations: Map<string, StutterEvent>;
  summary: StutterSummary;
}

let uid = 0;
function nextId(): string {
  return `st-${Date.now().toString(36)}-${(uid++).toString(36)}`;
}

// ─── Main fusion ─────────────────────────────────────────────────────────

export function fuseStutterEvents(input: FuseInput): FuseResult {
  const { candidates, words, pauseEvents = [], speechmaticsTags } = input;

  // Natural sentence-boundary pause windows — used to suppress false positives
  const naturalWindows: { start: number; end: number }[] = pauseEvents
    .filter((p) => p.type === "natural" && p.isSentenceBoundary)
    .map((p) => ({ start: p.startTime, end: p.endTime }));

  // ── Stage 1: promote candidates above the keep threshold ─────────
  const prelim: StutterEvent[] = [];
  for (const c of candidates) {
    if (c.confidence < FUSION_THRESHOLDS.keep) continue;

    // Suppress block/tense/hesitation events sitting on a natural boundary
    if (
      (c.eventType === "block" ||
        c.eventType === "tense_block" ||
        c.eventType === "hesitation_sequence") &&
      naturalWindows.some(
        (w) => c.startTime >= w.start - 0.05 && c.endTime <= w.end + 0.05
      )
    ) {
      continue;
    }

    const confidence = Math.min(1, c.confidence);
    const highlight = confidence >= FUSION_THRESHOLDS.highlight;
    const eventType: StutterEventType = highlight
      ? c.eventType
      : c.eventType === "hesitation_sequence" || c.eventType === "uncertain"
        ? c.eventType
        : "uncertain";

    prelim.push({
      id: nextId(),
      startTime: c.startTime,
      endTime: c.endTime,
      durationMs: c.durationMs,
      eventType,
      confidence,
      severity: severityFromConfidence(confidence),
      reason: [...c.reason],
      colorToken: STUTTER_COLORS[eventType],
      shouldHighlight: highlight,
    });
  }

  // ── Stage 2: bind to words ────────────────────────────────────────
  // Mission rule: PRE-ONSET first-word attachment — the FIRST word whose
  // window [word.start − 600ms, word.end + 200ms] fits the event owns it.
  // Events never drift to later words just because timestamps are closer.
  for (const evt of prelim) {
    let best: FinalWord | null = null;
    let bestScore = 0;

    for (const w of words) {
      const inWindow =
        evt.startTime >= w.startTime - 0.6 &&
        evt.endTime <= w.endTime + 0.2;
      if (!inWindow) continue;
      // Direct overlap is the strongest anchor
      const ratio = overlapRatio(evt.startTime, evt.endTime, w.startTime, w.endTime);
      const score = ratio > 0 ? ratio : 0.5; // pre-onset within window
      if (score > bestScore) {
        bestScore = score;
        best = w;
      }
      if (best) break; // FIRST appropriate word owns the event — no drift
    }

    if (best && bestScore >= 0.3) {
      evt.matchedWord = best.text;

      // Speechmatics tag = supporting evidence only (small confidence nudge)
      const key = wordKey(best.startTime, best.endTime);
      const smTag = speechmaticsTags?.get(key);
      if (smTag && !evt.shouldHighlight && evt.confidence >= FUSION_THRESHOLDS.keep) {
        // Never let a weak signal alone create a visible false positive —
        // the nudge is capped so it can only cross the line with real support.
        const bumped = Math.min(1, evt.confidence + 0.06);
        if (bumped >= FUSION_THRESHOLDS.highlight) {
          evt.confidence = bumped;
          evt.shouldHighlight = true;
          evt.eventType = (evt.eventType === "uncertain"
            ? "hesitation_sequence"
            : evt.eventType) as StutterEventType;
          evt.severity = severityFromConfidence(bumped);
        }
      }
    }
  }

  // ── Stage 3: dedupe overlapping events (keep stronger) ───────────
  const events = dedupe(prelim.filter((e) => e.shouldHighlight || e.eventType === "uncertain" || e.eventType === "possible_false_start"));

  // ── Stage 4: specificity wins over hesitation_sequence ────────────
  const specificTypes: StutterEventType[] = [
    "repetition",
    "prolongation",
    "block",
    "tense_block",
    "possible_false_start",
  ];
  const specific = events.filter((e) => specificTypes.includes(e.eventType));
  const finalEvents = events.filter((e) => {
    if (e.eventType !== "hesitation_sequence") return true;
    // Drop a sequence that fully contains a specific event
    return !specific.some(
      (s) => s.startTime >= e.startTime && s.endTime <= e.endTime
    );
  });

  // ── Annotations for live rendering ────────────────────────────────
  const annotations = new Map<string, StutterEvent>();
  for (const evt of finalEvents) {
    if (!evt.matchedWord || !evt.shouldHighlight) continue;
    // Find the word again to get its key
    const w = words.find(
      (x) => x.text === evt.matchedWord &&
        Math.abs(x.startTime - evt.startTime) < 0.5
    );
    if (!w) continue;
    const key = wordKey(w.startTime, w.endTime);
    const existing = annotations.get(key);
    if (!existing || evt.confidence > existing.confidence) {
      annotations.set(key, evt);
    }
  }

  const summary = summarizeStutterEvents(finalEvents, words);

  return { events: finalEvents, annotations, summary };
}

// ─── Dedupe overlapping events ──────────────────────────────────────────

function dedupe(events: StutterEvent[]): StutterEvent[] {
  const sorted = [...events].sort((a, b) => b.confidence - a.confidence);
  const kept: StutterEvent[] = [];
  for (const evt of sorted) {
    const dup = kept.some(
      (k) =>
        k.eventType === evt.eventType &&
        Math.abs(k.startTime - evt.startTime) < 0.3 &&
        Math.abs(k.endTime - evt.endTime) < 0.3
    );
    if (!dup) kept.push(evt);
  }
  return kept.sort((a, b) => a.startTime - b.startTime);
}

// ─── Summary builder ────────────────────────────────────────────────────

export function summarizeStutterEvents(
  events: StutterEvent[],
  words: FinalWord[]
): StutterSummary {
  const highlighted = events.filter((e) => e.shouldHighlight);
  const uncertain = events.filter(
    (e) => !e.shouldHighlight || e.eventType === "uncertain"
  ).length;

  const count = (t: StutterEventType) =>
    highlighted.filter((e) => e.eventType === t).length;

  const longestMs =
    highlighted.length > 0
      ? Math.max(...highlighted.map((e) => e.durationMs))
      : 0;

  const avgConfidence =
    highlighted.length > 0
      ? highlighted.reduce((s, e) => s + e.confidence, 0) / highlighted.length
      : 0;

  // ── Recovery quality ──────────────────────────────────────────────
  // For each highlighted event, gap between event end and the next word start.
  const recoveryGaps: number[] = [];
  for (const evt of highlighted) {
    const next = words.find((w) => w.startTime >= evt.endTime - 0.05);
    if (next) {
      recoveryGaps.push((next.startTime - evt.endTime) * 1000);
    }
  }

  let recoveryQuality: StutterSummary["recoveryQuality"] = null;
  if (recoveryGaps.length > 0) {
    const median = [...recoveryGaps].sort((a, b) => a - b)[
      Math.floor(recoveryGaps.length / 2)
    ];
    if (median < 500) recoveryQuality = "quick";
    else if (median < 2000) recoveryQuality = "moderate";
    else recoveryQuality = "slow";
  }

  // ── Phonation ratio ───────────────────────────────────────────────
  let phonationRatio = 0;
  if (words.length > 1) {
    const firstStart = words[0].startTime;
    const lastEnd = words[words.length - 1].endTime;
    const totalMs = Math.max(1, (lastEnd - firstStart) * 1000);
    const speechMs = words.reduce((s, w) => s + (w.endTime - w.startTime) * 1000, 0);
    phonationRatio = Math.min(1, speechMs / totalMs);
  }

  const flowBreaks = highlighted.filter(
    (e) => e.severity === "high" || e.eventType === "block" || e.eventType === "tense_block"
  ).length;

  return {
    total: highlighted.length,
    repetitions: count("repetition"),
    prolongations: count("prolongation"),
    blocks: count("block"),
    tenseBlocks: count("tense_block"),
    hesitationSequences: count("hesitation_sequence"),
    possibleFalseStarts: count("possible_false_start"),
    uncertain,
    longestMs,
    avgConfidence,
    timeline: highlighted,
    recoveryQuality,
    phonationRatio,
    flowBreaks,
  };
}

// ─── Convenience label helper ───────────────────────────────────────────

export { STUTTER_LABELS };
