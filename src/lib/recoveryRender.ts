/**
 * BOLO — recoveryRender helpers
 *
 * Pure functions that turn RecoveredAnnotations into renderable items for
 * the three transcript surfaces (Script / Free Speech / Debate). They are
 * the SAME annotation logic everywhere — only the display container differs.
 *
 * Rendering rule (mission — "NEVER lose the intended word"):
 *   sssssslap  →  slap + "Prolong" badge   (recovered → the INTENDED word)
 *   b-b-b-boy  →  boy  + "Stutter" badge   (recovered → the INTENDED word)
 *   ------cat  →  [Block] cat              (unresolved block stays visible)
 *
 * The transcript NEVER shows raw phonetic characters ("ssss", "b-b-b-").
 * A recovered annotation inserts the LEXICAL WORD (recoveredText) inline;
 * an unresolved block inserts a "[Block]" marker — the intended word must
 * never disappear from the transcript.
 */
import type { RecoveredAnnotation } from "./recoveryTypes";
import { assignRecoveredToSpans } from "./recoveryTypes";
import type { FeedEvent } from "./feedEvents";

export interface TimedSpan {
  startTime: number;
  endTime: number;
}

/**
 * Build a render-ready list of items for a transcript word stream.
 * Each word carries its base text + any attached annotation; standalone
 * annotations (recovered/unresolved with no word) are inserted inline by
 * timestamp so the transcript stays aligned and nothing duplicates.
 *
 * Recovery annotations are attached to the word they precede (pre-onset
 * first-word window), so a recovered "slap" renders inline where the
 * stutter happened and never duplicates a later Speechmatics token.
 */
export function buildRecoveredItems<T extends TimedSpan>(
  recs: RecoveredAnnotation[],
  spans: T[]
): {
  /** Parallel to `spans`: the annotation attached to each word (or null) */
  attachedByIndex: (RecoveredAnnotation | null)[];
  /** Standalone annotations to insert inline, sorted by startTime */
  standalone: RecoveredAnnotation[];
} {
  const { attachedBySpan, standalone } = assignRecoveredToSpans(recs, spans);
  const sortedStandalone = [...standalone].sort((a, b) => a.startTime - b.startTime);
  return { attachedByIndex: attachedBySpan, standalone: sortedStandalone };
}

/** True when the feed event list has grown/changed (for stable memo keys). */
export function feedEventsChanged(a: FeedEvent[], b: FeedEvent[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return true;
  }
  return false;
}
