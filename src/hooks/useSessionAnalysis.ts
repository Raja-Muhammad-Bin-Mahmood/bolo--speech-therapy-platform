import { useMemo } from "react";
import type { TranscriptChunk } from "./useSpeechmaticsWS";
import type { AcousticEvent, AcousticEventType } from "./useAcousticAnalysis";
import { detectPauses, type PauseEvent, type FinalWordLike } from "../lib/pauseDetector";

// ─── Types ──────────────────────────────────────────────────────────────

export type DisfluencyTag = "filler" | AcousticEventType;

export interface TaggedWord {
  word: string;
  startTime: number;
  endTime: number;
  confidence: number;
  utterance: number;
  tag: DisfluencyTag | null;
  /** Fused evidence score (0..1) — how many detectors agreed */
  fused: number;
}

export interface SessionScore {
  /** 0-100 composite ring score */
  score: number;
  fluencyPenalty: number;
  pacingPenalty: number;
  clarityPenalty: number;
  totalWords: number;
  fillers: number;
  blocks: number;
  repetitions: number;
  prolongations: number;
  stutters: number;
  stammers: number;
  disfluencyRate: number;
  wpm: number;
  avgConfidence: number;
  /** Sliding pace engine (5s window) */
  pace: {
    wpm: number;
    zone: "green" | "yellow" | "orange" | "red";
    trend: "accelerating" | "steady" | "slowing";
    label: string;
  };
  /** Human-readable WHY each metric changed */
  reasons: string[];
  /** Pause statistics */
  pauses: {
    total: number;
    thinking: number;
    awkward: number;
    severe: number;
    totalMs: number;
    longestMs: number;
    avgMs: number;
  };
}

// ─── Filler set ─────────────────────────────────────────────────────────
//
// Phase-2 precision pass: only TRUE filler interjections are dictionary
// fillers. Content words ("like", "well", "right", "okay", "actually",
// "basically", "literally", …) carry real meaning and were inflating the
// filler count / disfluency rate / top-filler stat for anyone who simply
// uses those words conversationally. They are no longer bare fillers.

const TRUE_FILLERS = new Set([
  "um", "uh", "ah", "er", "hmm", "mm", "hm",
  "uhh", "umm", "erm", "ahh", "uhm", "mhm",
]);

/**
 * Discourse markers ("well", "right", "okay", "so", "you know") are only
 * filler-like when they stand ALONE (a bare interjection at a pause) —
 * "well, I think…" is a discourse opener, not a disfluency. So a marker
 * only counts as filler when the neighbouring words are ALSO in the
 * true-filler / marker set (an interjection run like "well, um, well").
 */
const DISCOURSE_MARKERS = new Set([
  "like", "well", "right", "okay", "ok", "so", "yeah", "yep",
  "you know", "you see", "sort of", "kind of", "i mean",
  "actually", "basically", "literally", "so yeah", "anyway",
]);

function isFiller(word: string, neighbors: string[] = []): boolean {
  const clean = word.toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (TRUE_FILLERS.has(clean)) return true;
  if (!DISCOURSE_MARKERS.has(clean)) return false;
  // Marker stands alone OR inside a run of markers/fillers → filler.
  const cleanNeighbors = neighbors.map((n) =>
    n.toLowerCase().replace(/[^a-z ]/g, "").trim()
  );
  return cleanNeighbors.every(
    (n) => TRUE_FILLERS.has(n) || DISCOURSE_MARKERS.has(n)
  );
}

// ─── Fusion constants — confidence removed per spec ─────────────────────

const W_TEMPORAL = 0.5;
const W_ACOUSTIC = 0.35;
const W_DURATION = 0.15;
const FUSION_THRESHOLD = 0.75;

/**
 * Fuse all evidence for a candidate disfluency.
 * Speechmatics confidence has been REMOVED from this formula (was causing
 * clarity 0% for perfectly spoken words where ASR had low confidence).
 */
export function fuseEvidence(
  temporal: number,
  acoustic: number,
  durationMs: number
): number {
  const duration = Math.min(1, durationMs / 500);
  return (
    W_TEMPORAL * temporal +
    W_ACOUSTIC * acoustic +
    W_DURATION * duration
  );
}

// ─── Overlap check ─────────────────────────────────────────────────────

function overlaps(aS: number, aE: number, bS: number, bE: number, threshold = 0.3): boolean {
  const intersect = Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
  const aDur = aE - aS;
  if (aDur === 0) return false;
  return intersect / aDur >= threshold;
}

// ─── Timeline builder ─────────────────────────────────────────────────

export interface TimelineSegment {
  id: string;
  type: "word" | DisfluencyTag;
  text?: string;
  startTime: number;
  endTime: number;
  utterance: number;
  confidence?: number;
}

export function buildTimeline(
  transcripts: TranscriptChunk[],
  acousticEvents: AcousticEvent[]
): {
  segments: TimelineSegment[];
  wordTags: Map<string, DisfluencyTag>;
  taggedWords: TaggedWord[];
  pauseEvents: PauseEvent[];
} {
  const wordTags = new Map<string, DisfluencyTag>();
  const taggedWords: TaggedWord[] = [];
  const segments: TimelineSegment[] = [];
  let segId = 0;

  // Collect finalised words for pause detection
  const finalWords: FinalWordLike[] = [];

  // All finalized word texts in stream order (for the filler context check)
  const finalTexts: string[] = [];

  for (const chunk of transcripts) {
    if (!chunk.isFinal) continue;

    for (const w of chunk.words) {
      const wText = (w as any).text || w.word || "";
      if (!wText) continue;
      finalTexts.push(wText);
    }
  }

  // Helper: neighbours of the current word index (true fillers / markers)
  // for the discourse-marker context check.
  const neighborsAt = (idx: number): string[] => {
    const out: string[] = [];
    if (idx > 0) out.push(finalTexts[idx - 1]);
    if (idx < finalTexts.length - 1) out.push(finalTexts[idx + 1]);
    return out;
  };

  let wordIdx = 0;
  for (const chunk of transcripts) {
    if (!chunk.isFinal) continue;
    const utterance = chunk.utterance ?? 0;

    for (const w of chunk.words) {
      const wText = (w as any).text || w.word || "";
      if (!wText) continue;
      const confidence = (w as any).confidence ?? 0.9;
      const isFillerWord = isFiller(wText, neighborsAt(wordIdx));
      wordIdx++;

      finalWords.push({
        word: wText,
        startTime: w.startTime,
        endTime: w.endTime,
        utterance,
        confidence,
      });

      // ── Fusion: do any acoustic events overlap this word? ───────
      let tag: DisfluencyTag | null = null;
      let fused = 0;
      let bestFused = 0;

      if (!isFillerWord) {
        for (const ae of acousticEvents) {
          if (overlaps(w.startTime, w.endTime, ae.startTime, ae.endTime)) {
            // No Speechmatics confidence factor — only temporal + acoustic + duration
            const f = fuseEvidence(
              ae.confidence,
              ae.acoustic,
              ae.durationMs
            );
            if (f > bestFused) {
              bestFused = f;
              if (f >= FUSION_THRESHOLD) tag = ae.type;
            }
          }
        }
        fused = bestFused;
      } else {
        // Fillers are dictionary-confirmed
        tag = "filler";
        fused = 0.6 + confidence * 0.4;
      }

      segments.push({
        id: `seg-${segId++}`,
        type: tag ?? "word",
        text: wText,
        startTime: w.startTime,
        endTime: w.endTime,
        utterance,
        confidence,
      });

      taggedWords.push({
        word: wText,
        startTime: w.startTime,
        endTime: w.endTime,
        confidence,
        utterance,
        tag,
        fused,
      });

      const key = `${Math.round(w.startTime * 1000)}-${Math.round(w.endTime * 1000)}`;
      if (tag) wordTags.set(key, tag);
    }
  }

  // ── Pause detection on all finalised words ──────────────────
  const pauseEvents = detectPauses(finalWords, 0).pauses;

  // Insert non-overlapping acoustic events into the timeline
  for (const ae of acousticEvents) {
    const overlapsWord = segments.some(
      (s) => s.startTime <= ae.endTime && s.endTime >= ae.startTime
    );
    if (!overlapsWord) {
      segments.push({
        id: `acoustic-${segId++}`,
        type: ae.type,
        startTime: ae.startTime,
        endTime: ae.endTime,
        utterance: 0,
      });
    }
  }
  segments.sort((a, b) => a.startTime - b.startTime);

  return { segments, wordTags, taggedWords, pauseEvents };
}

// ─── Pace engine ─────────────────────────────────────────────────────

function computePace(taggedWords: TaggedWord[]): SessionScore["pace"] {
  if (taggedWords.length < 4) {
    return {
      wpm: 0,
      zone: "green",
      trend: "steady",
      label: "Keep talking — pace updates as you go.",
    };
  }
  const lastEnd = taggedWords[taggedWords.length - 1].endTime;
  const windowStart = lastEnd - 5;
  const inWindow = taggedWords.filter((w) => w.endTime >= windowStart);
  const windowSeconds = Math.max(1, lastEnd - inWindow[0].startTime);
  const wpm = Math.round((inWindow.length / windowSeconds) * 60);

  let zone: SessionScore["pace"]["zone"] = "green";
  if (wpm < 120 || wpm > 160) zone = "yellow";
  if (wpm < 95 || wpm > 185) zone = "orange";
  if (wpm < 75 || wpm > 210) zone = "red";

  let trend: SessionScore["pace"]["trend"] = "steady";
  let label = `Great pace — ${wpm} WPM is inside the 120–160 target band.`;
  if (wpm > 160) {
    trend = "accelerating";
    label = `You accelerated during this section — ${wpm} WPM. Slow to 120–160.`;
  } else if (wpm < 120) {
    trend = "slowing";
    label = `You slowed down here — ${wpm} WPM. Aim for 120–160.`;
  }
  return { wpm, zone, trend, label };
}

// ─── Pure score calculator (Phase 5, shared engine) ─────────────────────

export function computeSessionScore(
  taggedWords: TaggedWord[],
  acousticEvents: AcousticEvent[],
  pauseEvents: PauseEvent[] = []
): SessionScore {
  const totalWords = taggedWords.length;

  let fillers = 0;
  for (const tw of taggedWords) {
    if (tw.tag === "filler") fillers++;
  }

  const blocks = acousticEvents.filter((e) => e.type === "block").length;
  const repetitions = acousticEvents.filter((e) => e.type === "repetition").length;
  const prolongations = acousticEvents.filter((e) => e.type === "prolongation").length;
  const stutters = acousticEvents.filter((e) => e.type === "stutter").length;
  const stammers = acousticEvents.filter((e) => e.type === "stammer").length;

  const totalDisfluencies = fillers + blocks + repetitions + prolongations + stutters + stammers;

  // Fluency penalty (max 60)
  const disfluencyRate = totalWords > 0 ? (totalDisfluencies / totalWords) * 100 : 0;
  const fluencyPenalty = Math.min(60, disfluencyRate * 3);

  // Pacing penalty (max 20)
  const pace = computePace(taggedWords);
  const distFromBand =
    pace.wpm < 120 ? 120 - pace.wpm : pace.wpm > 160 ? pace.wpm - 160 : 0;
  const pacingPenalty = Math.min(20, distFromBand * 0.4);

  // Clarity penalty (max 20) — NOW from disfluency types, NOT ASR confidence!
  // Each stutter/stammer/block hurts clarity directly, not the recognition score.
  const clarityPenalty = Math.min(
    20,
    stutters * 1.5 + stammers * 1.5 + blocks * 3 + prolongations * 1.5 + repetitions * 1
  );

  // Composite score (floor 0)
  const score = Math.max(0, Math.round(100 - fluencyPenalty - pacingPenalty - clarityPenalty));

  // ── Pause stats ──────────────────────────────────────────────
  const scoreablePauses = pauseEvents.filter((p) => p.type !== "natural");
  const pauseStats = {
    total: scoreablePauses.length,
    thinking: scoreablePauses.filter((p) => p.type === "thinking").length,
    awkward: scoreablePauses.filter((p) => p.type === "awkward").length,
    severe: scoreablePauses.filter((p) => p.type === "severe").length,
    totalMs: scoreablePauses.reduce((s, p) => s + p.durationMs, 0),
    longestMs: scoreablePauses.length > 0
      ? Math.max(...scoreablePauses.map((p) => p.durationMs))
      : 0,
    avgMs: scoreablePauses.length > 0
      ? Math.round(scoreablePauses.reduce((s, p) => s + p.durationMs, 0) / scoreablePauses.length)
      : 0,
  };

  // ── Human-readable reasons ──────────────────────────────────
  const reasons: string[] = [];
  if (fluencyPenalty > 0) {
    const parts: string[] = [];
    if (fillers > 0) parts.push(`${fillers} fillers`);
    if (stutters > 0) parts.push(`${stutters} stutters`);
    if (stammers > 0) parts.push(`${stammers} stammers`);
    if (blocks > 0) parts.push(`${blocks} blocks`);
    if (repetitions > 0) parts.push(`${repetitions} repetitions`);
    if (prolongations > 0) parts.push(`${prolongations} prolongations`);
    reasons.push(
      `Fluency −${Math.round(fluencyPenalty)}: ${parts.join(", ")}.`
    );
  }
  if (pacingPenalty > 0) {
    reasons.push(
      `Pace −${Math.round(pacingPenalty)}: ${pace.label}`
    );
  }
  if (clarityPenalty > 0) {
    // Clarity reasons based on disfluency types, not ASR confidence
    const clarityParts: string[] = [];
    if (stutters > 0) clarityParts.push(`${stutters} stutters`);
    if (stammers > 0) clarityParts.push(`${stammers} stammers`);
    if (blocks > 0) clarityParts.push(`${blocks} blocks`);
    if (repetitions > 0) clarityParts.push(`${repetitions} repetitions`);
    if (prolongations > 0) clarityParts.push(`${prolongations} prolongations`);
    reasons.push(
      `Clarity −${Math.round(clarityPenalty)}: ${clarityParts.join(", ")} interfered with clarity.`
    );
  }

  // Add pause reasons for awkward/severe pauses
  const awkwardPauses = pauseEvents.filter((p) => p.type === "awkward" || p.type === "severe" || p.type === "hesitation_sequence");
  for (const p of awkwardPauses.slice(0, 3)) {
    reasons.push(p.reason.join(" "));
  }

  if (reasons.length === 0) {
    reasons.push("No significant issues detected — keep it up!");
  }

  // avgConfidence is kept as metadata only — NEVER used in penalty or reasons
  const totalConf = taggedWords.reduce((s, tw) => s + tw.confidence, 0);
  const avgConfidence = totalWords > 0 ? totalConf / totalWords : 1;

  return {
    score,
    fluencyPenalty,
    pacingPenalty,
    clarityPenalty,
    totalWords,
    fillers,
    blocks,
    repetitions,
    prolongations,
    stutters,
    stammers,
    disfluencyRate: Math.round(disfluencyRate),
    wpm: pace.wpm,
    avgConfidence: Math.round(avgConfidence * 100) / 100,
    pace,
    reasons,
    pauses: pauseStats,
  };
}

// ─── React hook version ────────────────────────────────────────────────

export function useSessionAnalysis(
  transcripts: TranscriptChunk[],
  acousticEvents: AcousticEvent[]
) {
  return useMemo(() => {
    const { segments, wordTags, taggedWords, pauseEvents } = buildTimeline(transcripts, acousticEvents);
    const score = computeSessionScore(taggedWords, acousticEvents, pauseEvents);
    return { segments, wordTags, taggedWords, score, pauseEvents };
  }, [transcripts, acousticEvents]);
}

// ─── Convenience for finalising after session ends ─────────────────────

export function finalizeSessionScore(
  transcripts: TranscriptChunk[],
  acousticEvents: AcousticEvent[]
): SessionScore {
  const { taggedWords, pauseEvents } = buildTimeline(transcripts, acousticEvents);
  return computeSessionScore(taggedWords, acousticEvents, pauseEvents);
}