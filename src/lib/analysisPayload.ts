/**
 * BOLO — Shared Analysis Payload Builder (FREE / SCRIPT / CLOSER)
 *
 * The `/analysis` screen renders whatever payload is carried on
 * `location.state`. This builder produces that payload with the EXACT same
 * structure the Free Speech reference implementation produces at session
 * end — so Script Mode and Closer Mode hand the after-session screen the
 * same data contract (scores, tagged words, timeline, pause events,
 * confidence series, filler breakdown, recovery annotations, the SAVED
 * live transcript token array, structured disfluency data, markers).
 *
 * Only the presentation changes per mode; the underlying event/token model
 * is shared. `script` is an optional mode-specific addition (Script Mode
 * shows the intact script with its purple annotations).
 */
import type { TranscriptChunk } from "../hooks/useSpeechmaticsWS";
import type { AcousticEvent } from "../hooks/useAcousticAnalysis";
import {
  buildTimeline,
  finalizeSessionScore,
} from "../hooks/useSessionAnalysis";
import type { RecoveredAnnotation } from "./recoveryTypes";
import type { TranscriptToken } from "./transcriptTokens";
import type { SessionDisfluency } from "./sessionDisfluencies";
import type { SessionMarker } from "./manualAnnotations";
import type { PaceReport } from "./paceEngine";

export type AnalysisMode = "free" | "script" | "closer";

/** Script Mode's mode-specific payload — the intact script + the per-script
 *  token annotations (the SAME classification the live pager showed). */
export interface ScriptAnnotationPayload {
  title: string;
  text: string;
  tokens: string[];
  details: { state: string; disfluency: string | null }[];
}

export interface AnalysisPayloadOptions {
  sessionId: string;
  topic: string;
  mode: AnalysisMode;
  /** PRIMARY final-word timeline (Deepgram finals + SM fallback merged). */
  finalTranscripts: TranscriptChunk[];
  /** RAW DSP-lane events (worklet) — the same list the live feed rendered. */
  acousticEvents: AcousticEvent[];
  /** RAW RMS/ZCR/ΔEnergy sensor events (stutter/stammer lane). */
  sensorEvents: AcousticEvent[];
  /** The deduped merged pool the live view used (feed + transcript agree). */
  allAcoustic: AcousticEvent[];
  recoveryAnnotations: RecoveredAnnotation[];
  /** The SAVED live transcript token array (single source of truth). */
  finalTokens: TranscriptToken[];
  finalHiddenKeys: string[];
  finalDisfluencies: SessionDisfluency[];
  markers: SessionMarker[];
  paceReport: PaceReport;
  script?: ScriptAnnotationPayload | null;
}

export type AnalysisPayload = ReturnType<typeof buildAnalysisPayload>;

export function buildAnalysisPayload(opts: AnalysisPayloadOptions) {
  const {
    sessionId,
    topic,
    mode,
    finalTranscripts,
    acousticEvents,
    sensorEvents,
    allAcoustic,
    recoveryAnnotations: recoveredAnnotations,
    finalTokens,
    finalHiddenKeys,
    finalDisfluencies,
    markers,
    paceReport,
    script = null,
  } = opts;

  const finalScore = finalizeSessionScore(finalTranscripts, allAcoustic);
  const { taggedWords, segments, pauseEvents, wordTags } = buildTimeline(
    finalTranscripts,
    allAcoustic
  );

  // ── Confidence timeline — average word confidence per 2s bucket ──────
  const lastEnd =
    taggedWords.length > 0 ? Math.max(...taggedWords.map((w) => w.endTime)) : 0;
  const bucket = 2;
  const buckets = Math.max(1, Math.ceil(lastEnd / bucket));
  const series = Array.from({ length: buckets }, () => ({ sum: 0, count: 0 }));
  for (const w of taggedWords) {
    const idx = Math.min(buckets - 1, Math.floor(w.startTime / bucket));
    series[idx].sum += w.confidence;
    series[idx].count++;
  }
  const confidenceTimeline = series.map((b, i) => ({
    t: i * bucket,
    value: b.count > 0 ? Math.round((b.sum / b.count) * 100) : null,
  }));

  // ── Filler breakdown ─────────────────────────────────────────────────
  const fillerCounts: Record<string, number> = {};
  for (const w of taggedWords) {
    if (w.tag !== "filler") continue;
    const key = w.word.toLowerCase().replace(/[^a-z]/g, "");
    if (!key) continue;
    fillerCounts[key] = (fillerCounts[key] ?? 0) + 1;
  }
  const topFiller =
    Object.entries(fillerCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
    "none";

  // ── Phrase bursts — split the word stream at flagged (scoreable) pauses ──
  const flaggedEnds = pauseEvents
    .filter((p) => p.shouldColor)
    .map((p) => p.endTime);
  let maxBurst = 0;
  let curBurst = 0;
  let pIdx = 0;
  for (const w of taggedWords) {
    while (
      pIdx < flaggedEnds.length &&
      w.startTime >= flaggedEnds[pIdx] - 0.005
    ) {
      maxBurst = Math.max(maxBurst, curBurst);
      curBurst = 0;
      pIdx++;
    }
    curBurst++;
  }
  maxBurst = Math.max(maxBurst, curBurst);
  const burstCount = flaggedEnds.length + (taggedWords.length > 0 ? 1 : 0);
  const avgWordsPerBurst =
    burstCount > 0
      ? Math.round((taggedWords.length / burstCount) * 10) / 10
      : 0;

  return {
    topic,
    mode,
    clarityScore: Math.max(0, Math.round(100 - finalScore.clarityPenalty)),
    fluencyScore: Math.max(0, Math.round(100 - finalScore.fluencyPenalty)),
    overallScore: finalScore.score,
    totalWords: finalScore.totalWords,
    disfluentWords: taggedWords.filter((w) => w.tag).length,
    disfluencyRate: finalScore.disfluencyRate,
    longestPhrase: maxBurst,
    avgWordsPerBurst,
    topFiller,
    fillerWords: fillerCounts,
    stutters: finalScore.stutters,
    stammers: finalScore.stammers,
    pauses: finalScore.pauses,
    wpm: finalScore.wpm,
    paceZone: finalScore.pace.zone,
    paceLabel: finalScore.pace.label,
    reasons: finalScore.reasons,
    paceReport,
    // ── Annotated review payload ──
    taggedWords,
    segments,
    wordTags: Array.from(wordTags.entries()),
    pauseEvents,
    confidenceTimeline,
    avgConfidence: finalScore.avgConfidence,
    // ── Existing detector events (feed + transcript must agree) ──
    acousticEvents,
    sensorEvents,
    // ── Recovery annotations (Stage 3) for the annotated review ──
    recoveredAnnotations,
    // ── AFTER-SESSION TRANSCRIPT (single source of truth) ──
    transcriptTokens: finalTokens,
    transcriptHiddenKeys: finalHiddenKeys,
    // ── AFTER-SESSION DISFLUENCY DATA (structured, never lost) ──
    sessionDisfluencies: finalDisfluencies,
    // ── MANUAL MARKERS + mode-specific script payload ──
    sessionId,
    markers,
    script,
  };
}
