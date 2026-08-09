/**
 * BOLO — Shared "Detection Feed" vocabulary + transcript mapping
 *
 * The Detection Feed (live practice screen) renders detector events as
 * colored chips. These SAME event objects — and ONLY these — are mapped
 * onto finalized transcript words so the feed and the transcript always
 * agree. This module holds the vocabulary (labels/colors) and the pure
 * timestamp-overlap mapping. It performs NO detection, NO re-classification
 * and NO threshold/confidence changes — it only visualizes events that
 * already exist.
 */

import type { AcousticEvent, AcousticEventType } from "../hooks/useAcousticAnalysis";

// ─── Feed vocabulary (identical to the Detection Feed chips) ─────────────

export interface FeedEvent {
  id: string;
  type: AcousticEventType;
  label: string;
  color: string;
  /** seconds (session clock — same clock as Speechmatics words) */
  startTime: number;
  endTime: number;
  durationMs: number;
  /**
   * Evidence-fusion metadata (added by the fusion layer; purely additive).
   * The Detection Feed always shows EVERY raw event — these fields only
   * label how the fusion layer treated it for the transcript.
   */
  band?: "internal" | "feed" | "medium" | "strong";
  suppressed?: boolean;
  visible?: boolean;
  evidenceScore?: number;
}

export const FEED_LABELS: Record<AcousticEventType, string> = {
  block: "Block",
  repetition: "Repeat",
  prolongation: "Prolong",
  stutter: "Stutter",
  stammer: "Stammer",
  fragment: "Fragment",
};

export const FEED_COLORS: Record<AcousticEventType, string> = {
  block: "#FDBA74",
  repetition: "#FCA5A5",
  prolongation: "#F9A8D4",
  stutter: "#F87171",
  stammer: "#BD8CFF",
  fragment: "#A3A3B5",
};

/** Convert raw detector events into the feed vocabulary (no filtering). */
export function toFeedEvents(events: AcousticEvent[]): FeedEvent[] {
  return events.map((e, i) => ({
    id: `evt-${e.type}-${e.startTime.toFixed(3)}-${i}`,
    type: e.type,
    label: FEED_LABELS[e.type] ?? e.type,
    color: FEED_COLORS[e.type] ?? "#8B93A7",
    startTime: e.startTime,
    endTime: e.endTime,
    durationMs: e.durationMs,
  }));
}

// ─── Timestamp mapping (renderer-only; never creates events) ─────────────

export interface TimedSpan {
  startTime: number;
  endTime: number;
}

/** Fraction of the EVENT that falls inside the span (0..1). */
function eventOverlapRatio(evt: FeedEvent, span: TimedSpan): number {
  const evtDur = evt.endTime - evt.startTime;
  if (evtDur <= 0) return 0;
  const intersect =
    Math.min(span.endTime, evt.endTime) - Math.max(span.startTime, evt.startTime);
  return intersect > 0 ? intersect / evtDur : 0;
}

const MIN_OVERLAP_RATIO = 0.15;
/** Pre-onset attachment window after an event ends (mirrors evidenceFusion). */
const PRE_ONSET_ATTACH_S = 0.6;
/** Blocks release INTO the following word — the net is wider for them. */
const BLOCK_PRE_ONSET_S = 0.9;

/**
 * Attach each feed event to its single best-matching word/span by timestamp
 * overlap, so each event appears on exactly one word (no duplicates).
 *
 * PRE-ONSET RULE (mirrors the fusion layer): a stutter/repetition/block
 * happens BEFORE the lexical word — "s-s-s-" then "slap", "------" then
 * "cat". An event that ends just before a word onset attaches to that
 * FOLLOWING word, so the transcript mirrors the Detection Feed exactly.
 * Returns one array per span (parallel to `spans`).
 *
 * Purely additive and stable: as events and finalized words grow, an
 * existing word's annotations are never removed or reassigned.
 */
export function assignEventsToSpans<T extends TimedSpan>(
  events: FeedEvent[],
  spans: T[]
): FeedEvent[][] {
  const out: FeedEvent[][] = spans.map(() => []);
  if (events.length === 0 || spans.length === 0) return out;

  for (const evt of events) {
    let bestIdx = -1;
    let bestRatio = 0;
    for (let i = 0; i < spans.length; i++) {
      const ratio = eventOverlapRatio(evt, spans[i]);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestIdx = i;
      }
    }
    if (bestRatio >= MIN_OVERLAP_RATIO) {
      out[bestIdx].push(evt);
      continue;
    }
    // Pre-onset: the event ends just before a word onset (stutter prefix,
    // silent block). The FIRST following word owns it — never drift.
    const windowS = evt.type === "block" ? BLOCK_PRE_ONSET_S : PRE_ONSET_ATTACH_S;
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      const gap = s.startTime - evt.endTime;
      if (gap >= -0.05 && gap <= windowS) {
        out[i].push(evt);
        break;
      }
    }
  }

  for (const list of out) list.sort((a, b) => a.startTime - b.startTime);
  return out;
}
