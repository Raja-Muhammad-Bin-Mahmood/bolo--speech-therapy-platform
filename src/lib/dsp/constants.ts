/**
 * BOLO — DSP Detector Live Tuning Constants
 *
 * Every threshold the scorer uses is exposed here as ONE mutable object so
 * the DSP DEBUG panel can tune it live during a session — no reload. The
 * engine reads from `DSP_TUNING` on every frame (values are hot-replaced
 * in place). The test harness clones the defaults for determinism.
 *
 * These are STARTING values informed by the acoustic literature, NOT
 * blind truths — the harness prints the actual measured features for every
 * fixture so thresholds are tuned from data, not guesses (see harness.ts).
 */

export interface DspTuning {
  // ── Frame extraction ──────────────────────────────────────────────
  FRAME_MS: number; // 20ms frames
  HOP_MS: number; // 10ms hop
  /** Absolute RMS floor under which nothing counts as speech. */
  ABS_RMS_FLOOR: number;
  /** Frame rms must exceed noiseMedian × this to count as speech. */
  SPEECH_RMS_FACTOR: number;
  /** Max ZCR for a frame to count as voiced. */
  VOICED_ZCR_MAX: number;

  // ── Calibration ───────────────────────────────────────────────────
  CALIBRATION_MS: number; // "CALIBRATING..." window (exactly 3000)

  // ── Prolongation ──────────────────────────────────────────────────
  /** Hard minimum — never confirm a prolongation ≤ 450ms. */
  MIN_PROLONGATION_MS: number;
  /** Max centroid VARIANCE (Hz²) over the sustained segment. */
  CENTROID_VARIANCE_THRESHOLD: number;
  /** Max mean spectral flux over the sustained segment. */
  SPECTRAL_FLUX_THRESHOLD: number;
  /** Max allowed intra-segment energy gap (continuity tolerance). */
  PROLONGATION_GAP_TOLERANCE_MS: number;
  /** Minimum score to confirm a prolongation. */
  PROLONG_CONFIRM_FLOOR: number;
  /** Segments shorter than this are never even logged as candidates. */
  PROLONG_LOG_MIN_MS: number;
  /** Mean ZCR above this ⇒ fricative-classified prolongation. */
  FRICATIVE_ZCR_THRESHOLD: number;

  // ── Repetition ───────────────────────────────────────────────────
  /** onsetRatio = currentShortTermRms / previousLocalRms must exceed this. */
  ONSET_MULTIPLIER: number;
  /** Minimum gap between onsets (closer onsets merge). */
  ONSET_MIN_GAP_MS: number;
  /** Local-energy reference window for onset ratio. */
  ONSET_LOOKBACK_MS: number;
  /** Adjacent repeated-unit gap must be inside [MIN, MAX]. */
  MIN_REPETITION_GAP_MS: number;
  MAX_REPETITION_GAP_MS: number;
  /** Minimum unit similarity for two units to join a chain (0..1). */
  CHAIN_SIMILARITY_GATE: number;
  /** Confirm threshold for 3+ unit repetitions (product score 0..1). */
  REPETITION_CONFIRM_THRESHOLD: number;
  /** STRICTER confirm threshold for 2-unit repetitions (less evidence). */
  REPETITION_CONFIRM_THRESHOLD_2UNIT: number;
  /** 2-unit repetitions additionally require similarity ≥ this. */
  REPETITION_SIMILARITY_2UNIT_MIN: number;
  /** 2-unit repetitions require the FIRST fragment ≤ this (brief run). */
  UNIT_MAX_MS_2UNIT: number;
  /** Minimum mean onset strength ratio for a repetition chain. */
  ONSET_STRENGTH_MIN: number;
  /** Profile window (ms after onset) used for unit acoustic comparison. */
  UNIT_PROFILE_MS: number;
  /** Similarity blend weights (zcr/centroid/bandwidth/envelope). */
  SIM_WEIGHTS: { zcr: number; centroid: number; bandwidth: number; envelope: number };

  // ── Block ────────────────────────────────────────────────────────
  /** dropRatio = 1 − currentRms / recentSpeechRms must reach this. */
  BLOCK_DROP_RATIO: number;
  /** Choke must last longer than this before a release can confirm. */
  CHOKE_MIN_MS: number;
  /** releaseRatio = releasePeakRms / chokeRms must reach this. */
  BLOCK_RELEASE_RATIO: number;
  /** Speech must have occurred within this window before the drop. */
  PRE_BLOCK_CONTEXT_MS: number;
  /** Pre-block speech must exceed noiseMedian × this (real speech, not mic hiss). */
  BLOCK_PRE_SPEECH_FACTOR: number;
  /** Choke RMS must be below noiseMedian × this (true interruption). */
  CHOKE_SILENCE_FACTOR: number;
  /** Post-event cooldown (same type) to prevent double counting. */
  EVENT_COOLDOWN_MS: number;
}

export const DEFAULT_DSP_TUNING: DspTuning = {
  FRAME_MS: 20,
  HOP_MS: 10,
  ABS_RMS_FLOOR: 0.004,
  SPEECH_RMS_FACTOR: 2.5,
  VOICED_ZCR_MAX: 0.3,

  CALIBRATION_MS: 3000,

  MIN_PROLONGATION_MS: 450,
  CENTROID_VARIANCE_THRESHOLD: 22000,
  SPECTRAL_FLUX_THRESHOLD: 0.12,
  PROLONGATION_GAP_TOLERANCE_MS: 80,
  PROLONG_CONFIRM_FLOOR: 0.6,
  PROLONG_LOG_MIN_MS: 225,
  FRICATIVE_ZCR_THRESHOLD: 0.28,

  ONSET_MULTIPLIER: 1.5,
  ONSET_MIN_GAP_MS: 60,
  ONSET_LOOKBACK_MS: 150,
  MIN_REPETITION_GAP_MS: 80,
  MAX_REPETITION_GAP_MS: 450,
  CHAIN_SIMILARITY_GATE: 0.55,
  REPETITION_CONFIRM_THRESHOLD: 0.5,
  REPETITION_CONFIRM_THRESHOLD_2UNIT: 0.62,
  REPETITION_SIMILARITY_2UNIT_MIN: 0.75,
  UNIT_MAX_MS_2UNIT: 220,
  ONSET_STRENGTH_MIN: 1.8,
  UNIT_PROFILE_MS: 90,
  SIM_WEIGHTS: { zcr: 0.2, centroid: 0.3, bandwidth: 0.2, envelope: 0.3 },

  BLOCK_DROP_RATIO: 0.75,
  CHOKE_MIN_MS: 400,
  BLOCK_RELEASE_RATIO: 2.5,
  PRE_BLOCK_CONTEXT_MS: 400,
  BLOCK_PRE_SPEECH_FACTOR: 4,
  CHOKE_SILENCE_FACTOR: 1.2,
  EVENT_COOLDOWN_MS: 300,
};

/** Mutable live-tuning singleton (mutated in place by the DSP DEBUG panel). */
export const DSP_TUNING: DspTuning = { ...DEFAULT_DSP_TUNING };

/** Clone for deterministic harness runs. */
export function cloneTuning(): DspTuning {
  return {
    ...DSP_TUNING,
    SIM_WEIGHTS: { ...DSP_TUNING.SIM_WEIGHTS },
  };
}

/** Full defaults (independent of any live mutation). */
export function defaultTuning(): DspTuning {
  return {
    ...DEFAULT_DSP_TUNING,
    SIM_WEIGHTS: { ...DEFAULT_DSP_TUNING.SIM_WEIGHTS },
  };
}
