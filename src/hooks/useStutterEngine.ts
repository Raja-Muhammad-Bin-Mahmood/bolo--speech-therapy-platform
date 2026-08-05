/**
 * BOLO — useStutterEngine
 *
 * Consumes raw AudioWorklet candidates + Speechmatics transcripts and
 * produces fused StutterEvents with annotations for live rendering
 * and a summary for the review panel.
 */
import { useMemo } from "react";
import type { StutterCandidate, StutterEvent, StutterSummary } from "../lib/stutterTypes";
import type { TranscriptChunk } from "./useSpeechmaticsWS";
import { fuseStutterEvents, type FinalWord } from "../lib/stutterFusion";

export function useStutterEngine(
  transcripts: TranscriptChunk[],
  candidates: StutterCandidate[],
  active: boolean
): {
  events: StutterEvent[];
  annotations: Map<string, StutterEvent>;
  summary: StutterSummary;
} {
  return useMemo(() => {
    if (!active && transcripts.length === 0) {
      return { events: [], annotations: new Map(), summary: emptySummary() };
    }

    // Collect all finalized words, deduped by key
    const words: FinalWord[] = [];
    const seen = new Set<string>();
    for (const chunk of transcripts) {
      if (!chunk.isFinal) continue;
      for (const w of chunk.words) {
        const text = (w as any).text || w.word || "";
        if (!text) continue;
        const key = `${Math.round(w.startTime * 1000)}-${Math.round(w.endTime * 1000)}-${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        words.push({
          text,
          startTime: w.startTime,
          endTime: w.endTime,
          confidence: (w as any).confidence ?? 0.9,
          utterance: chunk.utterance,
        });
      }
    }

    if (words.length === 0 && candidates.length === 0) {
      return { events: [], annotations: new Map(), summary: emptySummary() };
    }

    return fuseStutterEvents({ candidates, words });
  }, [transcripts, candidates, active]);
}

function emptySummary(): StutterSummary {
  return {
    total: 0,
    repetitions: 0,
    prolongations: 0,
    blocks: 0,
    tenseBlocks: 0,
    hesitationSequences: 0,
    uncertain: 0,
    longestMs: 0,
    avgConfidence: 0,
    timeline: [],
    recoveryQuality: null,
    phonationRatio: 0,
    flowBreaks: 0,
  };
}