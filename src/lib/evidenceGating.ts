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
 *
 * Attribution follows the mission rule: an event is attached to the FIRST
 * word whose window [word.start − 600ms, word.end + 200ms] fits it
 * (pre-onset attachment, never overlap-only, never drifting).
 */
import type { AcousticEvent } from "../hooks/useAcousticAnalysis";
import type { RecoveredAnnotation } from "./recoveryTypes";
import type { FeedEvent } from "./feedEvents";
import type { ScoredEvent } from "./evidenceFusion";
import { attributedWordIndex, type WordLike } from "./evidenceFusion";

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
 * The event must ALSO be attributed to THIS word via the pre-onset first-word
 * window — a visible event that belongs to a different word never tags here.
 */
export function visibleTagFor(
  type: string,
  startTime: number,
  scored: ScoredEvent[],
  words?: WordLike[]
): TagVerdict {
  const key = `${startTime.toFixed(3)}-${type}`;
  const s = scored.find((x) => x.key === key);
  if (!s) return { keep: false };
  if (!s.visible) return { keep: false };
  if (words && words.length > 0) {
    const idx = attributedWordIndex(s.event, words);
    if (idx < 0) return { keep: false };
    const w = words[idx];
    if (Math.abs(w.startTime - startTime) > 0.001) return { keep: false };
  }
  return { keep: true, type: s.event.type };
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
 * same type is attributed to it (pre-onset first-word window). Used by the
 * review transcript so the same fusion gate applies everywhere.
 */
export function visibleTagForWord(
  word: { startTime: number; endTime: number; tag?: string | null },
  scored: ScoredEvent[],
  words?: WordLike[]
): boolean {
  if (!word.tag) return false;
  if (scored.length === 0) return true; // no fusion data → keep as-is
  const wordList = words ?? [];
  for (const s of scored) {
    if (!s.visible || s.event.type !== word.tag) continue;
    if (wordList.length > 0) {
      const idx = attributedWordIndex(s.event, wordList);
      if (idx < 0) continue;
      if (Math.abs(wordList[idx].startTime - word.startTime) > 0.001) continue;
      return true;
    }
    // Fallback (no word list): timestamp overlap
    const intersect =
      Math.max(0, Math.min(word.endTime, s.event.endTime) - Math.max(word.startTime, s.event.startTime));
    if (intersect > 0) return true;
  }
  return false;
}
