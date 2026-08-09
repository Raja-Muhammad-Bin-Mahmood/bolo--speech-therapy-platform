/**
 * BOLO — DSP Detector Core Types
 *
 * The deterministic raw-audio pipeline. Every value in this module lives on
 * ONE injected millisecond timeline (the engine is clock-agnostic; the
 * production hook feeds it the shared session clock, the test harness feeds
 * it a virtual clock). Frames and the events they produce ALWAYS share that
 * same timeline — there is no mixing of Date.now() / performance.now() /
 * AudioContext time inside the engine.
 */

/** A single 20ms feature frame (10ms hop). All times are ms on one timeline. */
export interface AudioFrame {
  timestampMs: number;
  /** Root mean square of the frame (0..~0.5 raw amplitude). */
  rms: number;
  /** Zero crossing rate (0..1). */
  zcr: number;
  /** Spectral centroid in Hz (NOT pitch — the energy-weighted mean frequency). */
  spectralCentroid: number;
  /** Spectral bandwidth in Hz (spread of energy around the centroid). */
  spectralBandwidth: number;
  /** Spectral flux 0..1 (normalized frame-to-frame spectrum change). */
  spectralFlux: number;
  /** Voicing/activity estimate (energy above noise region + low ZCR). */
  voiced: boolean;
}

/** Robust calibration statistics (silence reference for the session). */
export interface CalibrationStats {
  noiseRmsMedian: number;
  noiseRmsP90: number;
  noiseZcrMedian: number;
  noiseZcrP90: number;
  /** Samples analysed (should be ~300 frames for a 3s calibration). */
  frameCount: number;
  /** Wall/session ms of the calibration window start. */
  startMs: number;
}

/** A detected onset (short-term energy rise) with its acoustic shape. */
export interface Onset {
  timestampMs: number;
  rms: number;
  zcr: number;
  spectralCentroid: number;
  spectralBandwidth: number;
  /** rms / preceding local energy — how abrupt the rise was. */
  strength: number;
}

export type CandidateType =
  | "possible_repetition"
  | "possible_prolongation"
  | "possible_block";

export type ProlongationKind = "fricative" | "vowel";

/** Full measured feature set of a candidate (used for scoring + debug). */
export interface CandidateFeatures {
  durationMs: number;
  meanRms: number;
  rmsVariance: number;
  meanZcr: number;
  zcrVariance: number;
  centroidMean: number;
  centroidVariance: number;
  spectralFluxMean: number;
  spectralFluxVariance: number;
  /** Repetition only — onset-to-onset gaps in ms. */
  onsetGapsMs: number[];
  /** Repetition only — mean adjacent unit similarity 0..1. */
  unitSimilarity: number;
  /** Repetition only — mean onset strength ratio. */
  onsetStrengthRatio: number;
  /** Repetition only — temporal rhythm regularity 0..1. */
  rhythmScore: number;
  /** Repetition only — number of repeated units in the chain. */
  repetitionCount: number;
  /** Block only — energy drop ratio at choke entry (0..1). */
  dropRatio: number;
  /** Block only — release peak / choke RMS ratio. */
  releaseRatio: number;
  /** Block only — pre-block speech level. */
  preBlockRms: number;
  /** Block only — pre-block ZCR. */
  preBlockZcr: number;
  /** Prolongation only — rms above the noise median (ratio). */
  rmsAboveNoise: number;
  /** Prolongation only — voiced-frame fraction 0..1. */
  voicedRatio: number;
  /** Prolongation only — fricative vs vowel (from acoustic measurements). */
  classification?: ProlongationKind;
}

/**
 * An acoustic CANDIDATE — detection ≠ classification. The detector first
 * finds a candidate from raw measurements; the SCORER then decides whether
 * it is sufficiently characteristic. A candidate can be rejected without
 * ever reaching the Detection Feed.
 */
export interface AcousticCandidate {
  id: string;
  type: CandidateType;
  startTimeMs: number;
  endTimeMs: number;
  features: CandidateFeatures;
  /** 0..1 raw characteristic score (before confirmation threshold). */
  score: number;
  /** 0..1 confidence (== score at confirmation time). */
  confidence: number;
}

/** Independent state axes — acoustic state NEVER blocks on lexical state. */
export type AcousticState = "candidate" | "confirmed" | "rejected";
export type LexicalState = "unresolved" | "resolved" | "unavailable";

export type DspEventType = "repetition" | "prolongation" | "block";

/**
 * A CONFIRMED event that bypasses Speechmatics entirely and enters the
 * Detection Feed the moment the acoustic scorer clears its threshold.
 */
export interface DspEvent {
  id: string;
  type: DspEventType;
  /** 0..1 acoustic confidence (score at confirmation). */
  confidence: number;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  source: "acoustic_dsp";
  acousticState: AcousticState; // "confirmed" at emission
  /** Lexical alignment is a SEPARATE axis — resolved only when a
   *  Speechmatics word attaches; unresolved does not delay the feed. */
  lexicalState: LexicalState;
  /** The aligned word (when lexicalState === "resolved"). */
  baseWord?: string;
  /** Word-level confidence (Speechmatics, when available). */
  lexicalConfidence?: number;
  score: number;
  features: CandidateFeatures;
  classification?: ProlongationKind;
}

/**
 * Structured diagnostic record for EVERY candidate (created, confirmed or
 * rejected). Rejected candidates are never hidden — they surface in the
 * DSP DEBUG panel and the harness table.
 */
export interface DspDiagnostic {
  id: string;
  candidateType: CandidateType;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  score: number;
  confirmed: boolean;
  /** Event type when confirmed. */
  eventType?: DspEventType;
  /** Human-readable rejection reason (present when !confirmed). */
  rejectionReason?: string;
  features: CandidateFeatures;
  /** Machine-readable log line, e.g. "REJECTED repetition:insufficient unit similarity". */
  logLine: string;
}
