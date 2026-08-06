/**
 * BOLO — useEvidenceFusion
 *
 * ONE shared hook for Script / Free Speech / Debate modes. It:
 *   • scores every raw acoustic event with the Evidence Fusion layer
 *     (the base detector output is NEVER modified — we only read it)
 *   • reports the live verdicts to the developer tuning panel
 *   • builds the gated word-tags for the visible transcript
 *
 * Slider changes in the dev panel flow through the context and take
 * effect on the very next render — no reload, no rebuild.
 */
import { useEffect, useMemo } from "react";
import type { AcousticEvent } from "./useAcousticAnalysis";
import type { TranscriptChunk } from "./useSpeechmaticsWS";
import type { PauseEvent } from "../lib/pauseDetector";
import type { DisfluencyTag } from "./useSessionAnalysis";
import {
  scoreAcousticEvents,
  wordsFromTranscripts,
  type EvidenceWeights,
  type ScoredEvent,
} from "../lib/evidenceFusion";
import { useEvidenceTuning } from "../context/EvidenceTuningContext";

export interface FusionGates {
  /** Full fusion verdicts (feed, review and dev panel all use these). */
  scored: ScoredEvent[];
}

/**
 * Score every raw acoustic event against the finalized transcript + pause
 * context with the given weights. Pure — the detector output is never
 * modified, only interpreted.
 */
export function useEvidenceFusion(
  transcripts: TranscriptChunk[],
  acousticEvents: AcousticEvent[],
  pauses: PauseEvent[],
  weights: EvidenceWeights
): FusionGates {
  return useMemo(() => {
    const words = wordsFromTranscripts(transcripts);
    const scored = scoreAcousticEvents(acousticEvents, { words, pauses }, weights);
    return { scored };
  }, [transcripts, acousticEvents, pauses, weights]);
}

/**
 * Convenience wrapper that reads weights + reporting from the live tuning
 * context — the version every page should use. `report` pushes the latest
 * scored events to the dev panel's live readout.
 */
export function useLiveEvidenceFusion(
  transcripts: TranscriptChunk[],
  acousticEvents: AcousticEvent[],
  pauses: PauseEvent[]
): FusionGates {
  const { weights, reportScored } = useEvidenceTuning();
  const gates = useEvidenceFusion(transcripts, acousticEvents, pauses, weights);

  // Report to the dev panel (deduped in the context).
  // Must run in an effect, NOT during render — calling reportScored inside
  // a useMemo would setState on EvidenceTuningProvider mid-render and trip
  // React's "Cannot update a component while rendering a different component"
  // warning.
  useEffect(() => {
    if (gates.scored.length > 0) reportScored(gates.scored);
  }, [gates.scored, reportScored]);

  return gates;
}

/**
 * Build the gated tag map for finalized words: wordKey → tag.
 * Contains ONLY tags that passed the fusion layer — a suppressed event's
 * key is simply absent, so the word renders as a plain word. This is a
 * drop-in for the raw analysis.wordTags used by the transcript renderers.
 */
export function buildVisibleTags(
  transcripts: TranscriptChunk[],
  scored: ScoredEvent[]
): Map<string, DisfluencyTag> {
  const out = new Map<string, DisfluencyTag>();
  if (scored.length === 0) return out;

  const visible = scored.filter((s) => s.visible);

  for (const chunk of transcripts) {
    if (!chunk.isFinal) continue;
    for (const w of chunk.words) {
      const ww = w as { text?: string; word?: string; startTime: number; endTime: number };
      const key = `${Math.round(ww.startTime * 1000)}-${Math.round(ww.endTime * 1000)}`;

      // Strongest visible event overlapping this word
      let best: ScoredEvent | null = null;
      for (const s of visible) {
        const intersect =
          Math.max(0, Math.min(ww.endTime, s.event.endTime) - Math.max(ww.startTime, s.event.startTime));
        if (intersect <= 0) continue;
        if (!best || s.evidenceScore > best.evidenceScore) best = s;
      }
      if (best) out.set(key, best.event.type as DisfluencyTag);
    }
  }
  return out;
}
