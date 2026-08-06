/**
 * BOLO — Evidence Gating for Visible Transcripts
 *
 * The transcript annotation layer. Takes the fusion verdicts produced by
 * the Evidence Fusion layer and decides what may become VISIBLE:
 *
 *   • a word-level disfluency color/tag  → only when the event is visible
 *   • a recovery annotation (StutterSpan) → only when the event is visible
 *
 * The base detector is untouched; raw events always stay in the Detection
 * Feed and the Review Screen. Only the transcript rendering is filtered —
 * weak/uncertain events are suppressed, the transcript stays readable,
 * alignment is preserved and no placeholder words are ever invented.
 */
import type { AcousticEvent } from "../hooks/useAcousticAnalysis";
import type { RecoveredAnnotation } from "./recoveryTypes";
import type { FeedEvent } from "./feedEvents";
import type { ScoredEvent } from "./evidenceFusion";

/** A transcript-visible tag decision: keep the tag or downgrade to plain word. */
export type TagVerdict =
  | { keep: true; type: string }
  | { keep: false };

/**
 * Should a word-level disfluency tag (block / repetition / prolongation /
 * stutter / stammer) become visible on this word?
 *
 * `scored` is the per-event fusion verdict keyed by `${start.toFixed(3)}-${type}`;
 * an event with no verdict is treated as NOT visible (conservative default).
 */
export function visibleTagFor(
  type: string,
  startTime: number,
  scored: ScoredEvent[]
): TagVerdict {
  const key = `${startTime.toFixed(3)}-${type}`;
  const s = scored.find((x) => x.key === key);
  if (!s) return { keep: false };
  return s.visible ? { keep: true, type: s.event.type } : { keep: false };
}

/**
 * Apply fusion verdicts to an AcousticEvent so the Recovery engine can
 * decide whether to render its annotation visibly. Returns null when the
 * event must be suppressed from the transcript.
 */
export function visibleEventFor(
  evt: AcousticEvent,
  scored: ScoredEvent[]
): AcousticEvent | null {
  const key = `${evt.startTime.toFixed(3)}-${evt.type}`;
  const s = scored.find((x) => x.key === key);
  if (!s) return null;
  return s.visible ? evt : null;
}

/**
 * Apply fusion verdicts to recovery annotations. An annotation whose
 * source event was suppressed is kept OUT of the visible transcript
 * (still present in the feed + review). Attached annotations on a
 * strongly-confident event pass through unchanged.
 */
export function visibleRecoveredFor(
  recs: RecoveredAnnotation[],
  scored: ScoredEvent[]
): RecoveredAnnotation[] {
  if (scored.length === 0) return recs;
  const byKey = new Map(scored.map((s) => [s.key, s]));
  return recs.filter((r) => {
    const s = byKey.get(`${r.startTime.toFixed(3)}-${r.type}`);
    if (!s) return true; // no verdict — leave as-is (conservative: keep)
    return s.visible;
  });
}

/**
 * Filter feed events for INLINE transcript chips: only events that passed
 * the fusion layer appear beside transcript words. The Detection Feed
 * (which renders ALL raw events) is a separate surface and stays complete.
 */
export function visibleFeedEventsFor(
  feed: FeedEvent[],
  scored: ScoredEvent[]
): FeedEvent[] {
  if (scored.length === 0) return [];
  const byKey = new Map(scored.map((s) => [s.key, s]));
  return feed.filter((f) => {
    const s = byKey.get(`${f.startTime.toFixed(3)}-${f.type}`);
    if (!s) return false; // no verdict → not visible in transcript
    return s.visible;
  });
}

/**
 * Review-screen helper: should a tagged word KEEP its visible disfluency
 * color? The word keeps its tag only when a visible scored event of the
 * same type overlaps it. Used by the review transcript so the same fusion
 * gate applies everywhere (visible annotations / suppressed candidates are
 * still listed in the evidence panel below).
 */
export function visibleTagForWord(
  word: { startTime: number; endTime: number; tag?: string | null },
  scored: ScoredEvent[]
): boolean {
  if (!word.tag) return false;
  if (scored.length === 0) return true; // no fusion data → keep as-is
  for (const s of scored) {
    if (!s.visible || s.event.type !== word.tag) continue;
    const intersect =
      Math.max(0, Math.min(word.endTime, s.event.endTime) - Math.max(word.startTime, s.event.startTime));
    if (intersect > 0) return true;
  }
  return false;
}
