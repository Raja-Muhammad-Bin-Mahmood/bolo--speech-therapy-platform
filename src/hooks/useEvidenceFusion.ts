/**
 * BOLO — useEvidenceFusion
 *
 * ONE shared hook for Script / Free Speech / Debate modes. It:
 *   • scores every raw acoustic event with the Evidence Fusion layer
 *     (the base detector output is NEVER modified — we only read it)
 *   • reports the live verdicts to the developer tuning panel
 *   • builds the gated word-tags for the visible transcript
 *   • writes structured fusion logs (candidate / word / decision) so the
 *     team can always answer "why was this shown or suppressed?"
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
  attributedWordIndex,
  type EvidenceWeights,
  type ScoredEvent,
  type WordLike,
} from "../lib/evidenceFusion";
import { logFusionBatch, type LoggableScored } from "../lib/fusionLog";
import { useEvidenceTuning } from "../context/EvidenceTuningContext";

export interface FusionGates {
  /** Full fusion verdicts (feed, review and dev panel all use these). */
  scored: ScoredEvent[];
  /** Deduped finalized words — used by attribution-aware renderers. */
  words: WordLike[];
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
    return { scored, words };
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

  // Structured fusion log (bounded ring, console-mirrored). Logs every
  // finalized word + every scored candidate with its attachment decision,
  // suppression reason and visible/hidden result. Idempotent (words deduped
  // by key; candidates carry stable keys).
  useEffect(() => {
    if (gates.scored.length === 0 && gates.words.length === 0) return;
    const scored: LoggableScored[] = gates.scored.map((s) => ({
      key: s.key,
      event: {
        type: s.event.type,
        startTime: s.event.startTime,
        endTime: s.event.endTime,
        durationMs: s.event.durationMs,
        confidence: s.event.confidence,
      },
      evidenceScore: s.evidenceScore,
      band: s.band,
      refinedType: s.refinedType,
      matchedWord: s.matchedWord,
      attachmentPosition: s.attachmentPosition,
      attachmentReason: s.attachmentReason,
      visible: s.visible,
      suppressionReasons: s.suppressionReasons,
      agreement: s.agreement,
    }));
    logFusionBatch(gates.words, scored);
  }, [gates.scored, gates.words]);

  return gates;
}

/**
 * Build the gated tag map for finalized words: wordKey → tag.
 * Contains ONLY tags that passed the fusion layer AND are attributed to
 * that exact word (pre-onset first-word window) — a suppressed event's
 * key is simply absent, so the word renders as a plain word. This is a
 * drop-in for the raw analysis.wordTags used by the transcript renderers.
 */
export function buildVisibleTags(
  transcripts: TranscriptChunk[],
  scored: ScoredEvent[],
  words?: WordLike[]
): Map<string, DisfluencyTag> {
  const out = new Map<string, DisfluencyTag>();
  if (scored.length === 0) return out;

  const visible = scored.filter((s) => s.visible);
  if (visible.length === 0) return out;

  const wordList: WordLike[] = words ?? wordsFromTranscripts(transcripts);

  for (const chunk of transcripts) {
    if (!chunk.isFinal) continue;
    for (const w of chunk.words) {
      const ww = w as { text?: string; word?: string; startTime: number; endTime: number };
      const key = `${Math.round(ww.startTime * 1000)}-${Math.round(ww.endTime * 1000)}`;

      // Strongest visible event ATTRIBUTED to this word (pre-onset window).
      let best: ScoredEvent | null = null;
      for (const s of visible) {
        const idx = attributedWordIndex(s.event, wordList);
        if (idx < 0) continue;
        if (Math.abs(wordList[idx].startTime - ww.startTime) > 0.001) continue;
        if (!best || s.evidenceScore > best.evidenceScore) best = s;
      }
      if (best) {
        // Map the mission classification back onto the render vocabulary.
        // `hesitation_sequence` never comes from a single detector event
        // (no acoustic type maps to it), so fall back to the raw type.
        const refined = best.refinedType;
        const tag: DisfluencyTag =
          refined === "uncertain" || refined === "hesitation_sequence"
            ? best.event.type
            : refined;
        out.set(key, tag);
      }
    }
  }
  return out;
}
