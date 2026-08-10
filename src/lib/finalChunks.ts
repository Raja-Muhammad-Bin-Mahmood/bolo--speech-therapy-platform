/**
 * BOLO — Shared Final-Word Timeline Builders (ONE pipeline for ALL modes)
 *
 * Faithful extraction of the exact logic the Free Speech reference
 * implementation (RecordingSession) uses to turn the PRIMARY Deepgram
 * finals (+ Speechmatics fallback) into the final-word timeline that feeds
 * `useSessionAnalysis`. Script Mode and Closer Mode consume the SAME
 * builders so every mode scores, tags and presents identical data — there
 * is exactly ONE detection/timeline implementation.
 */
import type { TranscriptChunk } from "../hooks/useSpeechmaticsWS";
import type { DeepgramFinalWord } from "../hooks/useDeepgramWS";

/**
 * Deepgram FINAL words → TranscriptChunk[] on the shared session clock.
 * New utterance whenever there's a >1.5s gap from the previous word end
 * (the same sentence-grouping rule the session timeline uses).
 */
export function buildDgFinalChunks(
  dgFinals: DeepgramFinalWord[]
): TranscriptChunk[] {
  const finals: TranscriptChunk[] = [];
  const dgSorted = [...dgFinals].sort((a, b) => a.startTimeMs - b.startTimeMs);
  let curUtterance = 0;
  dgSorted.forEach((w, i) => {
    const startSec = w.startTimeMs / 1000;
    const endSec = w.endTimeMs / 1000;
    if (i > 0 && startSec - dgSorted[i - 1].endTimeMs / 1000 > 1.5) {
      curUtterance += 1;
    }
    finals.push({
      text: w.word,
      isFinal: true,
      isPartial: false,
      words: [
        {
          word: w.word,
          startTime: startSec,
          endTime: endSec,
          confidence: w.confidence,
        },
      ],
      utterance: curUtterance,
      startTime: startSec,
      endTime: endSec,
    });
  });
  return finals;
}

/**
 * Merge Speechmatics finals into the SAME timeline when they DON'T collide
 * with a Deepgram word (fallback only — Deepgram wins overlapping slots).
 */
export function mergeFinalChunks(
  dgChunks: TranscriptChunk[],
  smTranscripts: TranscriptChunk[]
): TranscriptChunk[] {
  const smFinals = smTranscripts.filter((c) => c.isFinal);
  if (dgChunks.length === 0) return smFinals;
  const dgSpans = dgChunks.flatMap((c) =>
    c.words.map((w) => [w.startTime, w.endTime] as [number, number])
  );
  const merged = [...dgChunks];
  for (const chunk of smFinals) {
    const words = chunk.words.filter((w) => {
      const s = w.startTime ?? 0;
      const e = w.endTime ?? s;
      const collides = dgSpans.some(
        ([ds, de]) => Math.min(e, de) - Math.max(s, ds) > 0.05
      );
      return !collides;
    });
    if (words.length > 0) {
      merged.push({ ...chunk, words });
    }
  }
  return merged.sort(
    (a, b) => (a.words[0]?.startTime ?? 0) - (b.words[0]?.startTime ?? 0)
  );
}
