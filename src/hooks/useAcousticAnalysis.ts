import { useRef, useCallback, useEffect, useState } from "react";
import Meyda from "meyda";

// ─── Types ──────────────────────────────────────────────────────────────

export type AcousticEventType =
  | "block"
  | "repetition"
  | "prolongation"
  | "stutter"
  | "stammer"
  /**
   * PRESERVED SHORT-FRAGMENT CANDIDATE (Phase 1 — pre-classification).
   * A 2-iteration voiced pattern ("woh-woh") sits below the repetition
   * classifier's 3-onset floor (REP_MIN_ONSETS) and was previously
   * structurally incapable of becoming ANY event. It is preserved as a
   * low-confidence `fragment` candidate with its full run/onset/gap
   * structure in `fragmentDetail`, so a LATER classification stage can
   * decide "short repetition" vs "fluent speech". It is deliberately NOT
   * a repetition/stutter: `confidence` stays below every downstream
   * classification band and the event carries structure, not a verdict.
   */
  | "fragment";

/** One short voiced run inside a preserved fragment. */
export interface FragmentRun {
  /** seconds since recording start (session clock) */
  start: number;
  end: number;
  /** run duration in ms */
  durMs: number;
  /** Mean F0 of the run (Hz; undefined when no pitch evidence) — backs the
   *  pitch-contour similarity metric. */
  meanPitch?: number;
  /** Peak RMS of the run — backs the energy-envelope consistency metric. */
  peakRms?: number;
  /** Mean MFCC vector of the run — the vocal-tract filter shape used for
   *  cross-run similarity ("woh" vs "woh" share a vector; "hel" vs "lo" do
   *  not). */
  mfccMean?: number[];
  /** Mean RMS of the run — backs the energy-envelope consistency metric. */
  meanRms?: number;
}

/**
 * Structural detail of a preserved short-fragment candidate — everything a
 * later classifier needs to distinguish a short repetition from ordinary
 * fluent speech. Purely additive metadata (only present when type ===
 * "fragment"); no consumer depends on it in this phase.
 */
export interface FragmentDetail {
  /** Number of separate brief voiced runs (2 in this phase). */
  runCount: number;
  /** Each brief voiced run with its own timing. */
  runs: FragmentRun[];
  /** Onset timestamps (session clock, seconds) — one per run. */
  onsets: number[];
  /** Onset-to-onset gaps in ms (the existing repetition classifier's metric). */
  onsetGapsMs: number[];
  /** End-of-run → start-of-next-run gaps in ms (physical inter-run silence). */
  interRunGapsMs: number[];
  /** Detector-A acoustic evidence accumulated over the fragment window. */
  evidence: {
    /** Peak RMS across the window (0..1). */
    maxRms: number;
    /** Peak ZCR across the window (0..1) — tension cue. */
    maxZcr: number;
    /** Mean spectral centroid across the window (Hz) — phoneme-ish shape. */
    meanCentroid: number;
    /** Mean spectral flatness across the window (0..1). */
    meanFlatness: number;
    /** A high-ZCR (tension) frame was observed — mirrors the repetition path's zcrAgree. */
    zcrTension: boolean;
    /** Temporal regularity proxy (0..1) — same formula as the repetition path. */
    regularity: number;
  };
}

/**
 * Detail attached to a CLASSIFIED 2-run voiced repetition ("woh-woh",
 * "r-r-red", "b-b-ball", "w-w-what"). Unlike the fricative stutter path
 * (STUTTER_SHAPE_TOL on centroid/rolloff), voiced onsets are compared with
 * voiced-appropriate evidence — MFCC vector similarity, F0 contour
 * agreement, energy envelope, duration/onset structure and voicing pattern.
 * This event only exists when the similarity gate AND the stricter 2-run
 * emission floor were BOTH cleared at detection.
 */
export interface VoicedRepetitionDetail {
  runCount: 2;
  /** Blended voiced similarity 0..1 (see voicedRunSimilarity). */
  similarity: number;
  /** Per-cue sub-scores for review/debug (mfcc/pitch/energy/duration/voicing). */
  subScores: {
    mfcc: number;
    pitch: number;
    energy: number;
    duration: number;
    voicing: number;
  };
  /** The preserved-fragment structure this classification came from. */
  fragment: FragmentDetail;
}

export interface AcousticEvent {
  type: AcousticEventType;
  /** seconds since recording start (aligned with Speechmatics clock) */
  startTime: number;
  endTime: number;
  durationMs: number;
  /** 0..1 — temporal-pattern certainty (how many signals agreed) */
  confidence: number;
  /** 0..1 — raw feature-magnitude certainty (separate evidence source) */
  acoustic: number;
  /** Detail attached ONLY to a confirmed 2-run voiced repetition (type ===
   *  "repetition" with runCount 2). Absent for 3-onset repetitions and for
   *  preserved (unclassified) fragments. */
  voicedRepetition?: VoicedRepetitionDetail;
  /** Mean adjacent-run voiced similarity (0..1) for 3-onset repetitions —
   *  soft evidence for the fusion layer's onset-shape term. Absent when
   *  per-run features were unavailable. */
  voicedSimilarity?: number;
  /**
   * Preserved-fragment structure (only when type === "fragment"). Carries
   * run/onset/gap timing + acoustic evidence so a later classifier can
   * judge the candidate. Additive — never read by this phase's consumers
   * beyond carrying it through the shared merge/feed/review pipeline.
   */
  fragmentDetail?: FragmentDetail;
  /** Which detector lane produced this event (A = worklet/Meyda analysis,
   *  B = RMS/ZCR/ΔEnergy sensor, or BOTH after the shared merge deduped a
   *  same-type event). Used by the fusion layer for cross-detector
   *  corroboration. */
  source?: "acoustic" | "sensor" | "acoustic+sensor";
  /** true when the OTHER detector emitted a same-type event overlapping
   *  this one (computed by the shared merge helper). Real agreement
   *  evidence for the fusion layer — never set by a detector itself. */
  corroborated?: boolean;
}

interface FeatureFrame {
  t: number; // seconds since start
  rms: number;
  zcr: number;
  flux: number;
  centroid: number;
  rolloff: number;
  flatness: number;
  mfcc: number; // mean MFCC energy
  /** Raw MFCC coefficient vector (13 dims from Meyda) — kept for per-run
   *  voiced-similarity (the scalar `mfcc` above is not enough to compare
   *  two vowels). */
  mfccVec: number[];
  pitch: number; // F0 in Hz, 0 when unvoiced
  voiced: boolean;
  highBand: number; // mean linear magnitude 4-8kHz
}

/** Per-run feature accumulator for the voiced-run trackers — collects the
 *  features needed to judge whether two brief runs are the SAME syllable
 *  (voiced-appropriate similarity, NOT the fricative centroid/rolloff rule). */
interface VoicedRunAcc {
  start: number;
  end: number;
  /** Element-wise sum of MFCC vectors seen during the run (null when none). */
  mfccSum: number[] | null;
  mfccCount: number;
  pitchSum: number;
  pitchCount: number;
  rmsSum: number;
  rmsCount: number;
  rmsMax: number;
  voicedFrames: number;
  totalFrames: number;
}

/** Extract the similarity-relevant descriptor from a finished run. */
function runDescriptor(r: VoicedRunAcc): {
  mfccMean?: number[];
  meanPitch?: number;
  meanRms?: number;
  peakRms?: number;
  durMs: number;
  voicedRatio: number;
} {
  const mfccMean =
    r.mfccSum && r.mfccCount > 0
      ? r.mfccSum.map((s) => s / r.mfccCount)
      : undefined;
  return {
    mfccMean,
    meanPitch: r.pitchCount > 0 ? r.pitchSum / r.pitchCount : undefined,
    meanRms: r.rmsCount > 0 ? r.rmsSum / r.rmsCount : undefined,
    peakRms: r.rmsMax,
    durMs: Math.round((r.end - r.start) * 1000),
    voicedRatio: r.totalFrames > 0 ? r.voicedFrames / r.totalFrames : 0,
  };
}

// ─── Spec-driven constants ──────────────────────────────────────────────

const SAMPLE_RATE = 16000;
const WINDOW = 512; // 32ms @16kHz
const HOP_MS = 10; // ~100 feature updates / second
const ROLLING_MS = 500; // keep last 500ms in the rolling buffer

// Repetition
const REP_GAP_MIN = 0.08;
const REP_GAP_MAX = 0.25;
const REP_MIN_ONSETS = 3;
/** Max voiced-run length (ms) to count as a stutter-like fragment */
const REP_VOICED_RUN_MAX_MS = 200;

// ── Voiced repetition similarity (2-run path: "woh-woh", "r-r-red") ──────
/**
 * Voiced-appropriate similarity gate for a 2-RUN repetition. Unlike the
 * fricative stutter path (STUTTER_SHAPE_TOL on Δcentroid+Δrolloff — built
 * for sustained noisy fricatives, not voiced onsets), two brief voiced runs
 * are judged by whether they are the SAME SYLLABLE: MFCC vector distance
 * (vocal-tract filter shape), F0 contour agreement, energy envelope
 * consistency, duration/onset structure and voicing pattern. Ordinary
 * two-syllable words ("hello", "about", "over", "wow", "rare", "a baby")
 * fail this gate because their two syllables differ in MFCC shape and/or
 * F0/energy contour — they stay preserved fragments, never repetitions.
 */
const VOICED_SIM_GATE = 0.72;
/**
 * STRICTER emission floor for a 2-run repetition. A 2-run candidate has
 * LESS evidence than the existing 3-onset path (two runs can be two
 * syllables of a fluent word), so it must NOT use the same 0.60 emission
 * floor as 3-onset repetitions — it must clear this higher bar on the
 * similarity-gated confidence or it is never emitted as a repetition.
 */
const VOICED_2RUN_EMIT_FLOOR = 0.72;
/** Similarity blend weights — voiced cues only. */
const SIM_W = {
  mfcc: 0.45,
  pitch: 0.25,
  energy: 0.15,
  duration: 0.1,
  voicing: 0.05,
} as const;

/** L2 norm of a numeric vector (used for MFCC mean normalization). */
function l2(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

/** Cosine similarity of two vectors in [0,1] (0 when either is empty). */
function cosineSim(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  const la = l2(a);
  const lb = l2(b);
  if (la <= 1e-9 || lb <= 1e-9) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot / (la * lb)));
}

/**
 * VOICED-APPROPRIATE similarity between two brief voiced runs.
 *
 * This deliberately does NOT reuse the fricative rule (STUTTER_SHAPE_TOL
 * on Δcentroid + Δrolloff). Fricatives are sustained noisy segments whose
 * spectral-shape stability is meaningful; a voiced onset lasts ~50–200ms
 * and its centroid/rolloff is dominated by formant structure that varies
 * with loudness, pitch and coarticulation — it cannot distinguish
 * "woh"-"woh" from "woh"-"wah". Instead we use:
 *   • MFCC cosine similarity (45%) — the vocal-tract filter shape, the
 *     strongest voiced-phoneme discriminator available here;
 *   • F0 contour agreement (25%) — a repetition repeats near the same
 *     pitch; two different syllables of a word usually step;
 *   • energy envelope consistency (15%) — same syllable ⇒ same loudness
 *     shape;
 *   • duration/onset structure (10%) — same brief run length;
 *   • voicing pattern (5%) — both runs fully voiced.
 * Each cue is NEUTRAL (0.5) when its feature is unavailable, so a missing
 * pitch or MFCC cannot manufacture similarity — it only weakens the blend.
 */
export function voicedRunSimilarity(
  a: {
    mfccMean?: number[];
    meanPitch?: number;
    meanRms?: number;
    peakRms?: number;
    durMs: number;
    voicedRatio?: number;
  },
  b: {
    mfccMean?: number[];
    meanPitch?: number;
    meanRms?: number;
    peakRms?: number;
    durMs: number;
    voicedRatio?: number;
  }
): { score: number; subScores: { mfcc: number; pitch: number; energy: number; duration: number; voicing: number } } {
  // MFCC cosine — the vocal-tract filter shape. Two syllables of the same
  // repeated onset ("woh"-"woh") share a shape; two syllables of a word
  // ("hel"-"lo") do not. Normalized by the MFCC mean magnitude so a quiet
  // run doesn't collapse the distance.
  const m1 = a.mfccMean;
  const m2 = b.mfccMean;
  let mfccScore = 0.5;
  if (m1 && m2 && m1.length > 0 && m1.length === m2.length) {
    const scale = Math.max(1e-6, l2(m1) * l2(m2));
    const raw = cosineSim(m1, m2);
    // Boost the raw cosine slightly for strong agreement (same vowel).
    mfccScore = Math.min(1, raw * (0.85 + 0.3 * raw));
    if (scale > 1e-6) {
      // Keep a floor tied to how much spectral content both runs carried.
      mfccScore = mfccScore * 0.85 + 0.15 * Math.min(1, scale / 50);
    }
  }

  // F0 contour agreement — a repetition repeats at (roughly) the same
  // pitch; two different syllables step. Neutral when pitch is missing.
  let pitchScore = 0.5;
  if (a.meanPitch && b.meanPitch && a.meanPitch > 40 && b.meanPitch > 40) {
    const ratio = Math.min(a.meanPitch, b.meanPitch) / Math.max(a.meanPitch, b.meanPitch);
    pitchScore = Math.max(0, Math.min(1, (ratio - 0.8) / 0.2));
  }

  // Energy envelope consistency — same loudness shape across runs.
  let energyScore = 0.5;
  if (a.peakRms && b.peakRms && a.peakRms > 0 && b.peakRms > 0) {
    const ratio = Math.min(a.peakRms, b.peakRms) / Math.max(a.peakRms, b.peakRms);
    energyScore = Math.max(0, Math.min(1, (ratio - 0.6) / 0.4));
  }

  // Duration / onset structure — both runs are brief AND similar in length.
  const durDiffRatio =
    Math.max(1, a.durMs + b.durMs) > 0
      ? Math.abs(a.durMs - b.durMs) / Math.max(1, a.durMs + b.durMs)
      : 0;
  const durationScore = Math.max(0, Math.min(1, 1 - durDiffRatio * 2));

  // Voicing pattern — both runs must be fully voiced.
  const v1 = a.voicedRatio ?? 1;
  const v2 = b.voicedRatio ?? 1;
  const voicingScore = Math.max(0, Math.min(1, Math.min(v1, v2) * 1.2));

  const score =
    SIM_W.mfcc * mfccScore +
    SIM_W.pitch * pitchScore +
    SIM_W.energy * energyScore +
    SIM_W.duration * durationScore +
    SIM_W.voicing * voicingScore;

  return {
    score: Math.max(0, Math.min(1, score)),
    subScores: {
      mfcc: mfccScore,
      pitch: pitchScore,
      energy: energyScore,
      duration: durationScore,
      voicing: voicingScore,
    },
  };
}

// Block
const BLOCK_MIN_MS = 200;
const BLOCK_RELEASE_RATIO = 2.2;

// Prolongation (voiced: mmmmm)
const PROLONG_MIN_MS = 400;

// Stutter (fricative bursts: s-s-s-s-)
const STUTTER_BURST_MIN_MS = 25;
const STUTTER_BURST_MAX_MS = 250;
const STUTTER_GAP_MIN_MS = 40;
const STUTTER_GAP_MAX_MS = 220;
const STUTTER_MIN_BURSTS = 3;
const STUTTER_WINDOW_MS = 600;
/**
 * Max spectral-shape delta (normalized Δcentroid + Δrolloff) allowed
 * between bursts of the SAME stutter pattern. A real repetition repeats
 * ONE phoneme ("s-s-s-") — near-identical shapes. A fluent word like
 * "conversation" alternates /v/ /s/ /ʃ/ — very different shapes — and
 * must be rejected here, at the detector, before fusion even runs.
 */
const STUTTER_SHAPE_TOL = 0.45;
/**
 * Emission recall floor (was 0.75 — regularity-tuned, so IRREGULAR real
 * stutters never emitted). The fusion layer's fused evidence score now
 * gates visibility, so the base detector can afford recall-oriented
 * emission: irregular patterns (bursts at 60–220ms gaps instead of the
 * 80ms ideal) still emit and let the evidence layer judge them.
 */
const EMIT_FLOOR = 0.6;
/**
 * Repetition suppressor: how long after a stutter/stammer the onset
 * tracker stays silent (was 150ms — it killed real mid-sentence stutters
 * that land shortly after another event).
 */
const STUTTER_OVERLAP_COOLDOWN_S = 0.05;

// Stammer (sustained fricative: sssssssslap)
const STAMMER_MIN_MS = 150;
const STAMMER_MAX_MS = 600;
/** How long to wait for the voiced release after a fricative run (was 150ms). */
const STAMMER_RELEASE_WINDOW_MS = 300;
/** A fricative hold at least this long with strong high-band energy is a
 *  real stammer even when no voiced release arrives within the window
 *  (the release can land after ASR/analyser lag, or the speaker trails off). */
const STAMMER_HOLD_MIN_MS = 450;

const HI_FLOOR = 0.008;
const HI_BASELINE_FACTOR = 3;
const FRICATIVE_CENTROID_MIN = 2200;

// Fast-restart window for onsets
const FAST_RESTART_MAX = 0.5;

// RMS/ZCR
const RMS_BASELINE_ALPHA = 0.05;
const RMS_VOICE_FACTOR = 3;
const RMS_VOICE_FLOOR = 0.006;
const ZCR_VOICE_MAX = 0.3;
const ZCR_TENSION = 0.25;

// ─── Meyda global config (must be set before extract) ───────────────────

Meyda.sampleRate = SAMPLE_RATE;

// ─── Pitch via autocorrelation ──────────────────────────────────────────

function estimatePitch(buf: Float32Array): number {
  const minLag = Math.floor(SAMPLE_RATE / 400);
  const maxLag = Math.floor(SAMPLE_RATE / 60);
  let bestLag = -1;
  let bestScore = Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < buf.length - lag; i += 2) {
      const d = buf[i] - buf[i + lag];
      s += d * d;
    }
    if (s < bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }
  if (bestLag <= 0 || bestScore === Infinity) return 0;
  const norm = bestScore / Math.max(1e-9, buf.length - bestLag);
  if (norm > 0.15) return 0;
  return SAMPLE_RATE / bestLag;
}

// ─── Hook ───────────────────────────────────────────────────────────────

export function useAcousticAnalysis(
  getAnalyser: () => AnalyserNode | null,
  active: boolean
) {
  const [events, setEvents] = useState<AcousticEvent[]>([]);
  const eventsRef = useRef<AcousticEvent[]>([]);

  // Fixed-size rolling circular buffer of feature frames
  const ringRef = useRef<FeatureFrame[]>([]);

  // Reusable buffers (zero allocation in the hot loop)
  const windowBufRef = useRef(new Float32Array(WINDOW));
  const freqBufRef = useRef(new Float32Array(WINDOW / 2));
  const prevFreqBufRef = useRef(new Float32Array(WINDOW / 2));

  const stateRef = useRef({
    startTime: 0,
    baseline: 0.004,
    lastHop: 0,
    prevVoiced: false,

    // Repetition / fast-restart onset tracker
    onsets: [] as number[],
    voicingOnRuns: [] as { start: number; end: number }[],
    /** Feature accumulators for the voiced-run trackers — every brief voiced
     *  run collects MFCC/F0/energy so a 2-run pattern can be judged with
     *  voiced-appropriate similarity instead of the fricative shape rule. */
    voicedRunAccs: [] as VoicedRunAcc[],

    // Preserved short-fragment candidate (Phase 1 — pre-classification).
    // Armed when a 2nd brief voiced run appears inside the repetition gap
    // window; finalized once no 3rd in-range onset can arrive. A 2-run
    // pattern ("woh-woh") can never reach REP_MIN_ONSETS=3, so without this
    // it is discarded with zero trace. Holds REFERENCES to the live run
    // objects (voicingOnRuns entries are mutated in place as runs extend).
    pendingFragment: null as {
      run1: { start: number; end: number };
      run2: { start: number; end: number };
    } | null,

    // Block tracker
    blockStart: 0,
    blockZcrAcc: 0,
    blockCount: 0,
    prevRms: 0,

    // Prolongation tracker
    prolongStart: 0,
    pitchRing: [] as number[],

    // Stutter (fricative burst pattern) — each burst carries its spectral
    // shape (centroid/rolloff at the falling edge) for cross-burst
    // phoneme-consistency checks ("s-s-s-" vs the /v/ /s/ /ʃ/ of "conversation").
    fricStart: 0,
    prevFric: false,
    fricBursts: [] as {
      start: number;
      end: number;
      durMs: number;
      strength: number;
      centroid: number;
      rolloff: number;
    }[],
    hiBaseline: 0.004,

    // Stammer (sustained fricative hold — deferred confirm)
    pendingStammer: null as {
      start: number;
      end: number;
      durMs: number;
      strength: number;
    } | null,
    pendingStammerTick: 0,

    // Event de-dupe — PER TYPE (a global cooldown ate real multi-type
    // clusters: a stutter followed by a block 200ms later disappeared).
    lastEmitByType: {} as Partial<Record<AcousticEventType, number>>,
    lastStutterEnd: 0,
  });

  // ── Main tick: runs at rAF cadence, gates to ~10ms hops ────────────
  const tick = useCallback(() => {
    const analyser = getAnalyser();
    if (analyser) {
      const now = performance.now();
      const s = stateRef.current;
      if (!s.startTime) s.startTime = now;
      const t = (now - s.startTime) / 1000;

      if (t - s.lastHop >= HOP_MS / 1000) {
        s.lastHop = t;
        analyseFrame(analyser, t);
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [getAnalyser]);

  function analyseFrame(analyser: AnalyserNode, t: number) {
    const buf = windowBufRef.current;
    analyser.getFloatTimeDomainData(buf);

    const feat = Meyda.extract(
      [
        "rms",
        "zcr",
        "spectralCentroid",
        "spectralRolloff",
        "spectralFlatness",
        "mfcc",
        "amplitudeSpectrum",
      ],
      buf
    ) as any;

    // Spectral flux (manual — Meyda's extractor has a bug)
    const freq = freqBufRef.current;
    analyser.getFloatFrequencyData(freq);
    const prevFreq = prevFreqBufRef.current;
    let flux = 0;
    for (let i = 0; i < freq.length; i++) {
      const d = freq[i] - prevFreq[i];
      if (d > 0) flux += d;
    }
    flux /= Math.max(1, freq.length);
    prevFreqBufRef.current = freq;
    freqBufRef.current = prevFreq;

    const s = stateRef.current;

    // Adaptive noise baseline
    const rms = feat?.rms ?? 0;
    if (rms < s.baseline * 2) {
      s.baseline =
        s.baseline * (1 - RMS_BASELINE_ALPHA) + rms * RMS_BASELINE_ALPHA;
    }
    const voiceThresh = Math.max(
      RMS_VOICE_FLOOR,
      s.baseline * RMS_VOICE_FACTOR + RMS_VOICE_FLOOR
    );

    const zcr = feat?.zcr ?? 0;
    const voiced = rms > voiceThresh && zcr < ZCR_VOICE_MAX;
    const pitch = voiced ? estimatePitch(buf) : 0;

    // ── High-band energy (4-8kHz) — from amplitudeSpectrum ────────
    const ampSpec: Float32Array | undefined = feat?.amplitudeSpectrum;
    let highBand = 0;
    if (ampSpec && ampSpec.length > 0) {
      // fftSize/2 bins → nyquist (8kHz at 16k sample rate).
      // 4kHz = half of nyquist = half the bins.
      const hiStart = Math.floor(ampSpec.length * 0.5);
      let sum = 0;
      let count = 0;
      for (let i = hiStart; i < ampSpec.length; i++) {
        sum += Math.abs(ampSpec[i]);
        count++;
      }
      highBand = count > 0 ? sum / count : 0;
    }

    // Adaptive high-band baseline
    if (highBand < s.hiBaseline * 1.5) {
      s.hiBaseline =
        s.hiBaseline * (1 - RMS_BASELINE_ALPHA) + highBand * RMS_BASELINE_ALPHA;
    }

    const frame: FeatureFrame = {
      t,
      rms,
      zcr,
      flux,
      centroid: feat?.spectralCentroid ?? 0,
      rolloff: feat?.spectralRolloff ?? 0,
      flatness: feat?.spectralFlatness ?? 0,
      mfcc: Array.isArray(feat?.mfcc)
        ? feat.mfcc.reduce((a: number, b: number) => a + Math.abs(b), 0) /
          feat.mfcc.length
        : 0,
      mfccVec: Array.isArray(feat?.mfcc) ? [...feat.mfcc] : [],
      pitch,
      voiced,
      highBand,
    };

    // Push into rolling ring; prune older than 500ms
    const ring = ringRef.current;
    ring.push(frame);
    while (ring.length > 0 && t - ring[0].t > ROLLING_MS / 1000) ring.shift();

    runTemporalEngine(t, frame, voiceThresh);
  }

  // ── Temporal engine ───────────────────────────────────────────────
  function runTemporalEngine(t: number, f: FeatureFrame, voiceThresh: number) {
    const s = stateRef.current;

    // ── Fricative detection ───────────────────────────────────────
    const fricative =
      f.highBand > Math.max(HI_FLOOR, s.hiBaseline * HI_BASELINE_FACTOR) &&
      f.centroid > FRICATIVE_CENTROID_MIN &&
      !f.voiced;

    // ── 1) Stutter + Stammer (fricative analysis) ─────────────────
    if (fricative) {
      if (!s.prevFric) {
        s.fricStart = t;
      }
    } else if (s.prevFric) {
      // Fricative falling edge — classify the run
      const runDurMs = (t - s.fricStart) * 1000;
      const burstStrength =
        runDurMs > 0
          ? Math.min(1, f.highBand / Math.max(0.01, s.hiBaseline * 6))
          : 0;

      // Spectral shape at the falling edge (centroid/rolloff). A repeated
      // stutter phoneme repeats a near-identical shape across bursts; the
      // /v/ /s/ /ʃ/ onsets inside a fluent word differ strongly and must
      // break the pattern here.
      const normCentroid = f.centroid / Math.max(1, 8000);
      const normRolloff = f.rolloff / Math.max(1, 8000);

      if (runDurMs >= STUTTER_BURST_MIN_MS && runDurMs <= STUTTER_BURST_MAX_MS) {
        // Short burst — candidate for stutter pattern
        const bursts = s.fricBursts;
        const lastBurst = bursts.length > 0 ? bursts[bursts.length - 1] : null;
        const gapMs = lastBurst
          ? (s.fricStart - lastBurst.end) * 1000
          : Infinity;

        // ── PHONEME-CONSISTENCY GATE ─────────────────────────────
        // Same-phoneme repetition (s-s-s-) keeps the pattern; a burst whose
        // spectral shape differs sharply from the previous burst is a
        // DIFFERENT phoneme — the start of a fluent word, not a stutter
        // ("conversation" = /v/ /s/ /ʃ/). Break the pattern and begin fresh.
        const shapeDelta =
          lastBurst && normCentroid > 0 && lastBurst.centroid > 0
            ? Math.abs(normCentroid - lastBurst.centroid) +
              Math.abs(normRolloff - lastBurst.rolloff)
            : 0;
        const sameShape =
          !lastBurst || shapeDelta <= STUTTER_SHAPE_TOL;

        if (
          lastBurst &&
          gapMs >= STUTTER_GAP_MIN_MS &&
          gapMs <= STUTTER_GAP_MAX_MS &&
          sameShape
        ) {
          bursts.push({
            start: s.fricStart,
            end: t,
            durMs: Math.round(runDurMs),
            strength: burstStrength,
            centroid: normCentroid,
            rolloff: normRolloff,
          });

          // Pattern complete? ≥3 bursts within 600ms window
          if (bursts.length >= STUTTER_MIN_BURSTS) {
            const firstBurst = bursts[0];
            const spanMs = (t - firstBurst.start) * 1000;
            if (spanMs <= STUTTER_WINDOW_MS) {
              const gaps: number[] = [];
              for (let i = 1; i < bursts.length; i++) {
                gaps.push((bursts[i].start - bursts[i - 1].end) * 1000);
              }
              const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
              const regularity = Math.max(0, 1 - Math.abs(avgGap - 80) / 100);
              const burstFactor = Math.min(1, (bursts.length - 2) / 4);
              const strengthAvg =
                bursts.reduce((a, b) => a + b.strength, 0) / bursts.length;
              const shapeConsistent =
                bursts.reduce((a, b) => a + b.centroid, 0) / bursts.length;

              // Regularity still boosts confidence, but irregular real
              // stutters (bursts at 60–220ms gaps) now clear the recall
              // floor instead of being filtered out before fusion runs.
              const temporal =
                0.5 +
                0.2 * regularity +
                0.15 * burstFactor +
                0.1 * strengthAvg +
                0.05 * shapeConsistent;
              const acoustic = 0.5 + 0.3 * burstFactor + 0.2 * strengthAvg;

              emitEvent("stutter", firstBurst.start, t, temporal, acoustic);

              // Keep only the last burst for overlap continuity
              s.fricBursts = [bursts[bursts.length - 1]];
              s.lastStutterEnd = t;
            }
          }
        } else {
          // Gap too large, OR a shape change (different phoneme) — start a
          // fresh pattern. A shape change alone resets: the new burst may be
          // the first of a NEW repetition of that phoneme.
          if (lastBurst && gapMs > STUTTER_GAP_MAX_MS) {
            bursts.length = 0;
          }
          if (!sameShape && bursts.length > 0) {
            // Keep the new burst only — the old pattern (different phoneme)
            // must not seed the new one.
            bursts.length = 0;
          }
          bursts.push({
            start: s.fricStart,
            end: t,
            durMs: Math.round(runDurMs),
            strength: burstStrength,
            centroid: normCentroid,
            rolloff: normRolloff,
          });
          if (bursts.length > 10) bursts.shift();
        }
      } else if (
        runDurMs >= STAMMER_MIN_MS &&
        runDurMs <= STAMMER_MAX_MS
      ) {
        // Sustained fricative — candidate stammer (deferred confirm)
        s.pendingStammer = {
          start: s.fricStart,
          end: t,
          durMs: Math.round(runDurMs),
          strength: burstStrength,
        };
        s.pendingStammerTick = t;
      }
      // Runs < 25ms or > 600ms — ignore
    }

    // ── Stammer confirmation (release into voicing) ───────────────
    if (
      s.pendingStammer &&
      (f.voiced || t - s.pendingStammerTick > STAMMER_RELEASE_WINDOW_MS / 1000)
    ) {
      const p = s.pendingStammer;
      const longHold = p.durMs >= STAMMER_HOLD_MIN_MS && p.strength >= 0.7;
      if (f.voiced || longHold) {
        const durNorm = Math.min(1, p.durMs / 400);
        const temporal = 0.5 + 0.3 * durNorm + 0.2 * p.strength;
        const acoustic = 0.5 + 0.25 * durNorm + 0.25 * p.strength;
        emitEvent("stammer", p.start, t, temporal, acoustic);
        s.lastStutterEnd = t; // suppress adjacent repetition
      }
      s.pendingStammer = null;
    }

    s.prevFric = fricative;

    // ── 2) Onset detection + Repetition (voiced rising edge) ──────
    const onset = f.voiced && !s.prevVoiced;
    if (onset) {
      s.onsets.push(t);
      s.voicingOnRuns.push({ start: t, end: t });
      // A new brief voiced run starts a fresh feature accumulator (MFCC/F0/
      // energy) — the raw material for voiced-appropriate similarity between
      // runs ("woh-woh" vs "woh-wah").
      s.voicedRunAccs.push({
        start: t,
        end: t,
        mfccSum: null,
        mfccCount: 0,
        pitchSum: 0,
        pitchCount: 0,
        rmsSum: 0,
        rmsCount: 0,
        rmsMax: 0,
        voicedFrames: 0,
        totalFrames: 0,
      });
      s.onsets = s.onsets.filter((o) => t - o <= FAST_RESTART_MAX + 0.05);
      s.voicingOnRuns = s.voicingOnRuns.filter(
        (r) => t - r.start <= FAST_RESTART_MAX + 0.05
      );
      s.voicedRunAccs = s.voicedRunAccs.filter(
        (r) => t - r.start <= FAST_RESTART_MAX + 0.05
      );
    }

    // Track end of the current voiced run + accumulate per-run features
    // (MFCC vector, pitch, RMS) — only within the brief-run window; a long
    // run is a prolongation candidate, not a repetition fragment.
    if (f.voiced && s.voicingOnRuns.length > 0) {
      const lastRun = s.voicingOnRuns[s.voicingOnRuns.length - 1];
      lastRun.end = t;
      const acc = s.voicedRunAccs[s.voicedRunAccs.length - 1];
      if (acc && (t - acc.start) * 1000 <= REP_VOICED_RUN_MAX_MS) {
        acc.end = t;
        acc.totalFrames++;
        if (f.voiced) acc.voicedFrames++;
        acc.rmsSum += f.rms;
        acc.rmsCount++;
        acc.rmsMax = Math.max(acc.rmsMax, f.rms);
        if (f.pitch > 0) {
          acc.pitchSum += f.pitch;
          acc.pitchCount++;
        }
        if (f.mfccVec.length > 0) {
          if (!acc.mfccSum) acc.mfccSum = f.mfccVec.slice();
          else {
            for (let i = 0; i < f.mfccVec.length; i++) {
              acc.mfccSum[i] = (acc.mfccSum[i] ?? 0) + f.mfccVec[i];
            }
          }
          acc.mfccCount++;
        }
      }
    }

    // ── Preserved short-fragment candidate (Phase 1 — pre-classification).
    //    A 2-iteration voiced pattern ("woh-woh") sits below the repetition
    //    classifier's 3-onset floor and was previously discarded with zero
    //    trace. The moment a SECOND brief voiced run appears inside the
    //    repetition gap window, arm a candidate; finalize it as a
    //    low-confidence `fragment` once no 3rd in-range onset can arrive.
    //    It is deliberately NOT classified (never a repetition/stutter) —
    //    `fragmentDetail` carries the structure a later stage judges.
    if (
      s.pendingFragment &&
      (onset || t - s.pendingFragment.run2.start >= REP_GAP_MAX)
    ) {
      // A 3rd onset just arrived in range → the repetition classifier owns
      // this cluster; drop the pending fragment (no double counting).
      if (onset && t - s.pendingFragment.run2.start <= REP_GAP_MAX) {
        s.pendingFragment = null;
      } else {
        // No 3rd in-range onset can arrive — finalize the 2-run candidate.
        const p = s.pendingFragment;
        s.pendingFragment = null;

        // Re-validate the existing conditions on the FINAL run boundaries
        // (the run objects are live — their end times have since extended).
        const firstRun = p.run1;
        const secondRun = p.run2;
        if (
          (secondRun.start - firstRun.end) * 1000 >= REP_GAP_MIN &&
          (secondRun.start - firstRun.end) * 1000 <= REP_GAP_MAX &&
          (firstRun.end - firstRun.start) * 1000 <= REP_VOICED_RUN_MAX_MS &&
          (secondRun.end - secondRun.start) * 1000 <= REP_VOICED_RUN_MAX_MS
        ) {
          const windowFrames = ringRef.current.filter(
            (fr) => fr.t >= p.run1.start && fr.t <= t
          );
          const maxRms = windowFrames.reduce(
            (m, fr) => Math.max(m, fr.rms),
            0
          );
          const maxZcr = windowFrames.reduce(
            (m, fr) => Math.max(m, fr.zcr),
            0
          );
          const centroidSum = windowFrames.reduce(
            (acc, fr) => acc + fr.centroid,
            0
          );
          const flatnessSum = windowFrames.reduce(
            (acc, fr) => acc + fr.flatness,
            0
          );
          const onsetGap = secondRun.start - firstRun.start;
          const avgGap = onsetGap;
          const regularity = 1 - Math.min(1, Math.abs(avgGap - 0.165) / 0.1);
          const zcrAgree = windowFrames.some((fr) => fr.zcr > ZCR_TENSION);

          // ── VOICED SIMILARITY (2-run path) ─────────────────────────
          // Resolve the feature accumulators for the two brief voiced runs
          // (they were collected during the run; the acc list is pruned by
          // FAST_RESTART_MAX, so find them by onset match).
          const acc1 = s.voicedRunAccs.find(
            (a) => Math.abs(a.start - firstRun.start) < 0.02
          );
          const acc2 = s.voicedRunAccs.find(
            (a) => Math.abs(a.start - secondRun.start) < 0.02
          );
          const desc1 = acc1 ? runDescriptor(acc1) : null;
          const desc2 = acc2 ? runDescriptor(acc2) : null;

          const sim =
            desc1 && desc2
              ? voicedRunSimilarity(
                  { ...desc1, voicedRatio: desc1.voicedRatio },
                  { ...desc2, voicedRatio: desc2.voicedRatio }
                )
              : { score: 0, subScores: { mfcc: 0, pitch: 0, energy: 0, duration: 0, voicing: 0 } };

          const runs: FragmentRun[] = [
            {
              start: firstRun.start,
              end: firstRun.end,
              durMs: Math.round((firstRun.end - firstRun.start) * 1000),
              meanPitch: desc1?.meanPitch,
              peakRms: desc1?.peakRms,
              mfccMean: desc1?.mfccMean,
              meanRms: desc1?.meanRms,
            },
            {
              start: secondRun.start,
              end: secondRun.end,
              durMs: Math.round((secondRun.end - secondRun.start) * 1000),
              meanPitch: desc2?.meanPitch,
              peakRms: desc2?.peakRms,
              mfccMean: desc2?.mfccMean,
              meanRms: desc2?.meanRms,
            },
          ];

          const fragmentDetail: FragmentDetail = {
            runCount: 2,
            runs,
            onsets: [firstRun.start, secondRun.start],
            onsetGapsMs: [Math.round(onsetGap * 1000)],
            interRunGapsMs: [Math.round((secondRun.start - firstRun.end) * 1000)],
            evidence: {
              maxRms,
              maxZcr,
              meanCentroid:
                windowFrames.length > 0 ? centroidSum / windowFrames.length : 0,
              meanFlatness:
                windowFrames.length > 0 ? flatnessSum / windowFrames.length : 0,
              zcrTension: zcrAgree,
              regularity: Math.max(0, Math.min(1, regularity)),
            },
          };

          // ── 2-RUN CLASSIFICATION — STRICTER THAN 3-ONSET ──────────
          // A 2-run candidate has LESS evidence than a 3-onset repetition
          // (two runs could be two syllables of a fluent word), so it must
          // clear BOTH the voiced-similarity gate (same syllable, using
          // voiced-appropriate cues) AND a HIGHER emission floor than the
          // 3-onset path's 0.60. Ordinary two-syllable words ("hello",
          // "about", "over", "wow", "rare", "a baby") fail the similarity
          // gate and stay preserved fragments — they never become
          // repetitions, so ordinary fluent speech is not broadened into
          // a stutter.
          const simGated =
            sim.score >= VOICED_SIM_GATE &&
            sim.subScores.mfcc >= 0.55; // MFCC must genuinely agree — a
          // good pitch/energy alone must not manufacture a repetition.
          const confidence =
            simGated
              ? Math.min(1, 0.5 + 0.3 * sim.score + 0.2 * regularity)
              : 0.4;

          if (
            simGated &&
            confidence >= VOICED_2RUN_EMIT_FLOOR &&
            t - (s.lastEmitByType.repetition ?? 0) >= 0.25
          ) {
            // Classified 2-run voiced repetition. Confidence reflects the
            // similarity-gated evidence — it genuinely clears the emission
            // floor (it is NOT the preserved-fragment 0.40 cap).
            s.lastEmitByType.repetition = t;
            const evt: AcousticEvent = {
              type: "repetition",
              startTime: firstRun.start,
              endTime: secondRun.end,
              durationMs: Math.round((secondRun.end - firstRun.start) * 1000),
              confidence: Math.min(1, confidence),
              acoustic: Math.min(1, 0.5 + 0.4 * sim.score),
              // Top-level similarity — consumed by the fusion layer's
              // onset-shape term and the interruption gate's STRICTER 2-run
              // branch (voicedRunCount 2 + this score are what prove the
              // two runs are the same syllable).
              voicedSimilarity: sim.score,
              voicedRepetition: {
                runCount: 2,
                similarity: sim.score,
                subScores: sim.subScores,
                fragment: fragmentDetail,
              },
              source: "acoustic",
            };
            eventsRef.current = [...eventsRef.current, evt];
            setEvents(eventsRef.current);
          } else {
            // Below the similarity gate or the stricter floor — preserve the
            // fragment (with the similarity structure) for the feed/review
            // so the evidence is never lost. It stays low-confidence and
            // never becomes a visible repetition.
            emitFragment({
              startTime: firstRun.start,
              endTime: secondRun.end,
              runCount: 2,
              runs,
              onsets: [firstRun.start, secondRun.start],
              onsetGapsMs: [Math.round(onsetGap * 1000)],
              interRunGapsMs: [Math.round((secondRun.start - firstRun.end) * 1000)],
              evidence: fragmentDetail.evidence,
            });
          }
        }
      }
    }

    // ── Arm the candidate when a 2nd brief voiced run appears inside the
    //    repetition gap window (only Detector A; Detector B is untouched).
    if (
      onset &&
      !s.pendingFragment &&
      s.voicingOnRuns.length >= 2 &&
      s.lastStutterEnd + STUTTER_OVERLAP_COOLDOWN_S <
        s.voicingOnRuns[s.voicingOnRuns.length - 2].start
    ) {
      const firstRun = s.voicingOnRuns[s.voicingOnRuns.length - 2];
      const secondRun = s.voicingOnRuns[s.voicingOnRuns.length - 1];
      const run1Brief =
        firstRun.end >= firstRun.start &&
        (firstRun.end - firstRun.start) * 1000 <= REP_VOICED_RUN_MAX_MS;
      if (
        run1Brief &&
        secondRun.start - firstRun.end >= REP_GAP_MIN &&
        secondRun.start - firstRun.end <= REP_GAP_MAX
      ) {
        s.pendingFragment = { run1: firstRun, run2: secondRun };
      }
    }

    // Repetition: ≥3 onsets spaced 80–250ms apart, brief runs. The stutter
    // overlap suppressor only waits out the 50ms cooldown — a real
    // mid-sentence stutter shortly after another event must still emit.
    if (s.onsets.length >= REP_MIN_ONSETS) {
      const gaps: number[] = [];
      for (let i = 1; i < s.onsets.length; i++) {
        gaps.push(s.onsets[i] - s.onsets[i - 1]);
      }
      const allInRange = gaps.every(
        (g) => g >= REP_GAP_MIN && g <= REP_GAP_MAX
      );
      const runsBrief = s.voicingOnRuns.every(
        (r) => (r.end - r.start) * 1000 <= REP_VOICED_RUN_MAX_MS
      );
      const noStutterOverlap = s.onsets[0] > s.lastStutterEnd + STUTTER_OVERLAP_COOLDOWN_S;

      if (allInRange && runsBrief && noStutterOverlap) {
        // A confirmed ≥3-onset repetition subsumes the 2-run candidate.
        s.pendingFragment = null;
        const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const regularity = 1 - Math.min(1, Math.abs(avgGap - 0.165) / 0.1);
        const zcrAgree = ringRef.current.some(
          (fr) => fr.t >= s.onsets[0] && fr.zcr > ZCR_TENSION
        );
        const temporal = 0.55 + 0.3 * regularity + (zcrAgree ? 0.15 : 0);
        // Adjacent-run voiced similarity — the SAME voiced-appropriate
        // evidence as the 2-run path (MFCC/F0/energy/duration/voicing), so
        // the fusion layer sees a real onset-shape signal for 3-onset
        // repetitions too ("r-r-red" repeats /r/; fluent "about" does not).
        // Absent features → neutral, so it can only weaken the event.
        const threeAccs = s.voicedRunAccs.filter(
          (a) => a.start >= s.onsets[0] - 0.02 && a.start <= s.onsets[s.onsets.length - 1] + 0.02
        );
        let voicedSimilarity: number | undefined;
        if (threeAccs.length >= 2) {
          let sum = 0;
          let n = 0;
          for (let i = 1; i < threeAccs.length; i++) {
            sum += voicedRunSimilarity(
              { ...runDescriptor(threeAccs[i - 1]), voicedRatio: runDescriptor(threeAccs[i - 1]).voicedRatio },
              { ...runDescriptor(threeAccs[i]), voicedRatio: runDescriptor(threeAccs[i]).voicedRatio }
            ).score;
            n++;
          }
          voicedSimilarity = n > 0 ? sum / n : undefined;
        }
        emitEvent(
          "repetition",
          s.onsets[0],
          s.onsets[s.onsets.length - 1],
          temporal,
          Math.min(1, 0.5 + avgGap / 0.25),
          voicedSimilarity
        );
        s.onsets = [s.onsets[s.onsets.length - 1]];
        s.voicingOnRuns = [s.voicingOnRuns[s.voicingOnRuns.length - 1]];
      }
    }

    // ── 3) Silent block ──────────────────────────────────────────
    const blocked =
      !f.voiced && f.rms < voiceThresh * 0.5 && f.zcr > ZCR_TENSION * 0.9;
    if (blocked) {
      if (s.blockStart === 0) {
        s.blockStart = t;
        s.blockZcrAcc = 0;
        s.blockCount = 0;
      }
      s.blockZcrAcc += f.zcr;
      s.blockCount++;
    } else if (s.blockStart > 0) {
      const durMs = (t - s.blockStart) * 1000;
      const avgZcr = s.blockZcrAcc / Math.max(1, s.blockCount);
      const released = f.rms > voiceThresh * BLOCK_RELEASE_RATIO;
      if (durMs >= BLOCK_MIN_MS && released && avgZcr > ZCR_TENSION) {
        const durationSig = Math.min(1, durMs / 600);
        const zcrSig = Math.min(1, avgZcr / 0.5);
        const releaseSig = Math.min(1, f.rms / (voiceThresh * 4));
        const temporal = 0.4 + 0.3 * durationSig + 0.2 * zcrSig + 0.1 * releaseSig;
        emitEvent("block", s.blockStart, t, temporal, 0.5 + 0.3 * zcrSig + 0.2 * releaseSig);
      }
      s.blockStart = 0;
      s.blockZcrAcc = 0;
      s.blockCount = 0;
    }

    // ── 4) Prolongation (voiced): stable pitch ≥400ms ────────────
    if (f.voiced && f.pitch > 0) {
      if (s.prolongStart === 0) {
        s.prolongStart = t;
        s.pitchRing = [];
      }
      s.pitchRing.push(f.pitch);
      if (s.pitchRing.length > 30) s.pitchRing.shift();
      const durMs = (t - s.prolongStart) * 1000;
      if (durMs >= PROLONG_MIN_MS) {
        const mean =
          s.pitchRing.reduce((a, b) => a + b, 0) / s.pitchRing.length;
        const variance =
          s.pitchRing.reduce((a, b) => a + (b - mean) ** 2, 0) /
          s.pitchRing.length;
        const stability = Math.max(0, 1 - Math.sqrt(variance) / Math.max(mean, 1));
        const temporal = 0.45 + 0.35 * stability + 0.2 * Math.min(1, durMs / 800);
        if (temporal >= 0.7) {
          emitEvent("prolongation", s.prolongStart, t, temporal, 0.5 + 0.3 * stability);
        }
      }
    } else if (s.prolongStart > 0) {
      s.prolongStart = 0;
      s.pitchRing = [];
    }

    s.prevVoiced = f.voiced;
    s.prevRms = f.rms;
  }

  // ── Emit with de-dupe ──────────────────────────────────────────
  function emitEvent(
    type: AcousticEventType,
    startTime: number,
    endTime: number,
    temporal: number,
    acoustic: number,
    voicedSimilarity?: number
  ) {
    const s = stateRef.current;
    // Recall-oriented emission floor (0.60): the detector's job is to
    // CATCH candidates — the fusion layer's fused evidence score decides
    // visibility. Regularity-tuned floors (0.75) made irregular real
    // stutters never emit at all.
    if (temporal < EMIT_FLOOR) return;

    // Per-type de-dupe: no two events of the SAME type within 250ms.
    // (Was a global 250ms cooldown that ate real multi-type clusters —
    // a stutter followed by a block 200ms later simply disappeared.)
    const lastForType = s.lastEmitByType[type] ?? 0;
    if (endTime - lastForType < 0.25) return;
    s.lastEmitByType[type] = endTime;

    const evt: AcousticEvent = {
      type,
      startTime,
      endTime,
      durationMs: Math.round((endTime - startTime) * 1000),
      confidence: Math.min(1, temporal),
      acoustic: Math.min(1, acoustic),
      ...(voicedSimilarity !== undefined
        ? { voicedSimilarity: Math.max(0, Math.min(1, voicedSimilarity)) }
        : {}),
      source: "acoustic",
    };
    eventsRef.current = [...eventsRef.current, evt];
    setEvents(eventsRef.current);
  }

  /**
   * Emit a PRESERVED short-fragment candidate. Unlike `emitEvent`, this
   * intentionally BYPASSES the 0.60 emission floor — a preserved candidate
   * must survive even at low confidence (it is pre-classification evidence,
   * not a verdict). Confidence is capped at 0.40 so it can never cross any
   * downstream classification/visibility band (fusion floor 0.70, script
   * matcher 0.75, interruption gate pass floor). `fragmentDetail` carries
   * the full structure a later classification stage judges.
   */
  function emitFragment(input: {
    startTime: number;
    endTime: number;
    runCount: number;
    runs: FragmentRun[];
    onsets: number[];
    onsetGapsMs: number[];
    interRunGapsMs: number[];
    evidence: FragmentDetail["evidence"];
  }) {
    const s = stateRef.current;
    const lastForType = s.lastEmitByType.fragment ?? 0;
    if (input.endTime - lastForType < 0.25) return;
    s.lastEmitByType.fragment = input.endTime;

    const evt: AcousticEvent = {
      type: "fragment",
      startTime: input.startTime,
      endTime: input.endTime,
      durationMs: Math.round((input.endTime - input.startTime) * 1000),
      confidence: 0.4, // deliberately below every classification band
      acoustic: 0.4,
      fragmentDetail: {
        runCount: input.runCount,
        runs: input.runs,
        onsets: input.onsets,
        onsetGapsMs: input.onsetGapsMs,
        interRunGapsMs: input.interRunGapsMs,
        evidence: input.evidence,
      },
      source: "acoustic",
    };
    eventsRef.current = [...eventsRef.current, evt];
    setEvents(eventsRef.current);
  }

  const rafRef = useRef(0);

  useEffect(() => {
    if (!active) {
      eventsRef.current = [];
      setEvents([]);
      ringRef.current = [];
      stateRef.current = {
        startTime: 0,
        baseline: 0.004,
        lastHop: 0,
        prevVoiced: false,
        onsets: [],
        voicingOnRuns: [],
        voicedRunAccs: [],
        pendingFragment: null,
        blockStart: 0,
        blockZcrAcc: 0,
        blockCount: 0,
        prevRms: 0,
        prolongStart: 0,
        pitchRing: [],
        fricStart: 0,
        prevFric: false,
        fricBursts: [],
        hiBaseline: 0.004,
        pendingStammer: null,
        pendingStammerTick: 0,
        lastEmitByType: {},
        lastStutterEnd: 0,
      };
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, tick]);

  return { events, getEvents: () => eventsRef.current };
}