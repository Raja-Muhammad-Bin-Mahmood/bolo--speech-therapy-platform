/**
 * BOLO — recoveryRender helpers
 *
 * Pure functions that turn RecoveredAnnotations into renderable items for
 * the three transcript surfaces (Script / Free Speech / Debate). They are
 * the SAME annotation logic everywhere — only the display container differs.
 *
 * Rendering rule (spec):
 *   <span class="stutter-annotation">b-b-b-</span>boy
 *   <span class="stutter-annotation">ssssss</span>slap
 *
 * An "attached" annotation wraps the prefix + base word; a "recovered" one
 * inserts the fragment before the following word; an "unresolved" one shows
 * a conservative placeholder. Never invents words, never duplicates.
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
