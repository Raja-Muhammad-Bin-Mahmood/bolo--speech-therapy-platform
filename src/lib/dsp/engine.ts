/**
 * BOLO — Deterministic Acoustic Disfluency Detector (core engine)
 *
 * Raw microphone PCM → frame extractor → feature frames → candidate
 * detectors (prolongation / repetition / block) → scorer → event store.
 *
 * KEY PRINCIPLES (mission):
 *   • Detection ≠ classification. Every abnormal pattern first becomes an
 *     AcousticCandidate; the SCORER then confirms or rejects it. Rejected
 *     candidates never reach the Detection Feed but are never hidden from
 *     diagnostics.
 *   • Confirmed events bypass Speechmatics entirely (source "acoustic_dsp").
 *   • ONE clock: the engine is clock-agnostic and uses the injected
 *     millisecond timeline for BOTH frames and events. The production hook
 *     feeds the shared session clock; the harness feeds a virtual clock.
 *   • Thresholds are live-tunable (DSP_TUNING) and the harness prints the
 *     actual measured features so thresholds are tuned from data.
 *
 * The engine is a plain class with NO React, NO globals, NO I/O — fully
 * deterministic given identical PCM + tuning + clock.
 */

import { FrameExtractor, SAMPLE_RATE, samplesToMs, type RawFrame } from "./features";
import type {
  AcousticCandidate,
  AudioFrame,
  CalibrationStats,
  CandidateFeatures,
  DspDiagnostic,
  DspEvent,
  Onset,
} from "./types";
import { type DspTuning } from "./constants";

let uid = 0;
function nextId(prefix: string): string {
  return `${prefix}-${(++uid).toString(36)}-${Date.now().toString(36)}`;
}

function medianSorted(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p90Sorted(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length));
  return sorted[idx];
}

/** Internal per-unit accumulator for the repetition chain. */
interface Unit {
  onsetMs: number;
  endMs: number;
  /** Time of the last SPEECH frame inside the unit (sound, excl. gap). */
  soundEndMs: number;
  onsetStrength: number;
  zcrSum: number;
  centSum: number;
  bwSum: number;
  profileCount: number; // frames inside the profile window
  env: number[]; // rms per frame of the unit
}

interface SegAcc {
  startMs: number;
  lastActiveMs: number;
  /** Rolling per-frame history of the segment (capped ~600ms). */
  rmsArr: number[];
  zcrArr: number[];
  centArr: number[];
  fluxArr: number[];
  voicedCount: number;
  /** Already confirmed (stable core found) — never re-evaluate or reject. */
  confirmed: boolean;
}

/** Aggregate statistics over a sub-range of the segment history. */
function windowStats(
  seg: SegAcc,
  startIdx: number
): {
  n: number;
  meanRms: number;
  rmsVar: number;
  meanZcr: number;
  zcrVar: number;
  centMean: number;
  centVar: number;
  fluxMean: number;
  fluxVar: number;
  voicedRatio: number;
} {
  const n = seg.rmsArr.length - startIdx;
  let rmsSum = 0,
    rmsSq = 0,
    zcrSum = 0,
    zcrSq = 0,
    centSum = 0,
    centSq = 0,
    fluxSum = 0,
    fluxSq = 0;
  for (let i = startIdx; i < seg.rmsArr.length; i++) {
    const r = seg.rmsArr[i];
    const z = seg.zcrArr[i];
    const c = seg.centArr[i];
    const f = seg.fluxArr[i];
    rmsSum += r;
    rmsSq += r * r;
    zcrSum += z;
    zcrSq += z * z;
    centSum += c;
    centSq += c * c;
    fluxSum += f;
    fluxSq += f * f;
  }
  const meanRms = rmsSum / n;
  const meanZcr = zcrSum / n;
  const centMean = centSum / n;
  const fluxMean = fluxSum / n;
  return {
    n,
    meanRms,
    rmsVar: Math.max(0, rmsSq / n - meanRms * meanRms),
    meanZcr,
    zcrVar: Math.max(0, zcrSq / n - meanZcr * meanZcr),
    centMean,
    centVar: Math.max(0, centSq / n - centMean * centMean),
    fluxMean,
    fluxVar: Math.max(0, fluxSq / n - fluxMean * fluxMean),
    voicedRatio: seg.voicedCount / Math.max(1, seg.rmsArr.length),
  };
}

type BlockPhase = "idle" | "choke";

export class DspEngine {
  private extractor = new FrameExtractor();
  private frames: AudioFrame[] = [];
  private adaptiveFloor = 0.004;
  private cal: CalibrationStats | null = null;
  private calPhase: "idle" | "collecting" = "idle";
  private calSamples: number[] = [];
  private calStartMs = 0;

  // Prolongation
  private seg: SegAcc | null = null;

  // Repetition
  private onsets: Onset[] = [];
  private unit: Unit | null = null;
  private chain: Unit[] = [];
  private chainSims: number[] = []; // adjacent similarities inside chain
  private localRmsRing: number[] = [];
  private prevFrame: AudioFrame | null = null;
  private lastUnitEndMs: number | null = null;

  // Block
  private blockPhase: BlockPhase = "idle";
  private preBlock: { rms: number; zcr: number; timeMs: number } | null = null;
  private recentSpeechRms = 0;
  private lastSpeechMs = 0;
  private chokeStartMs = 0;
  private chokeMinRms = Infinity;
  private sawSpeechThisSession = false;

  /** Confirmed events (feed-ready, session timeline via the hook). */
  public readonly events: DspEvent[] = [];
  /** Every candidate verdict (created → confirmed/rejected). */
  public readonly diagnostics: DspDiagnostic[] = [];
  public readonly candidates: AcousticCandidate[] = [];

  private lastEmitByType: Partial<Record<string, number>> = {};
  private lastBlockRejectLog = 0;

  private tuning: DspTuning;
  private log: (line: string) => void;

  constructor(
    tuning: DspTuning,
    log: (line: string) => void = (l) => console.info(`[BOLO·dsp] ${l}`)
  ) {
    this.tuning = tuning;
    this.log = log;
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /** Feed raw PCM. `startTimeMs` = time of `samples[0]` on the timeline. */
  pushPcm(samples: Float32Array, startTimeMs: number): void {
    if (this.calPhase === "collecting") {
      for (let i = 0; i < samples.length; i++) this.calSamples.push(samples[i]);
    }
    const raws: RawFrame[] = [];
    this.extractor.push(samples, startTimeMs, raws);
    for (const raw of raws) this.onFrame(raw);
  }

  /** Feed one pre-extracted frame (used by tests that bypass PCM). */
  pushFrame(frame: AudioFrame): void {
    this.onFrame(frame);
  }

  /** Begin the manual 3-second calibration window. */
  beginCalibration(): void {
    this.calPhase = "collecting";
    this.calSamples = [];
    this.calStartMs = this.frames.length > 0 ? this.frames[this.frames.length - 1].timestampMs : 0;
  }

  /** End calibration and compute robust noise statistics. */
  endCalibration(): CalibrationStats | null {
    this.calPhase = "idle";
    const rmsArr: number[] = [];
    const zcrArr: number[] = [];
    // Compute per-frame stats over the buffered silence window
    const hop = Math.round((this.tuning.HOP_MS / 1000) * SAMPLE_RATE);
    const frameLen = Math.round((this.tuning.FRAME_MS / 1000) * SAMPLE_RATE);
    const buf = new Float32Array(Math.min(frameLen, this.calSamples.length));
    for (let i = 0; i + frameLen <= this.calSamples.length; i += hop) {
      for (let j = 0; j < frameLen; j++) buf[j] = this.calSamples[i + j];
      let sumSq = 0;
      let zc = 0;
      for (let j = 0; j < frameLen; j++) {
        sumSq += buf[j] * buf[j];
        if (j > 0 && buf[j] * buf[j - 1] < 0) zc++;
      }
      rmsArr.push(Math.sqrt(sumSq / frameLen));
      zcrArr.push(zc / Math.max(1, frameLen - 1));
    }
    if (rmsArr.length < 5) return null;
    rmsArr.sort((a, b) => a - b);
    zcrArr.sort((a, b) => a - b);
    const stats: CalibrationStats = {
      noiseRmsMedian: medianSorted(rmsArr),
      noiseRmsP90: p90Sorted(rmsArr),
      noiseZcrMedian: medianSorted(zcrArr),
      noiseZcrP90: p90Sorted(zcrArr),
      frameCount: rmsArr.length,
      startMs: this.calStartMs,
    };
    this.cal = stats;
    this.adaptiveFloor = stats.noiseRmsMedian;
    this.log(`CALIBRATION complete — noiseRms median=${stats.noiseRmsMedian.toFixed(4)} p90=${stats.noiseRmsP90.toFixed(4)} · noiseZcr median=${stats.noiseZcrMedian.toFixed(3)} p90=${stats.noiseZcrP90.toFixed(3)} (${stats.frameCount} frames)`);
    return stats;
  }

  get calibration(): CalibrationStats | null {
    return this.cal;
  }

  get isCalibrating(): boolean {
    return this.calPhase === "collecting";
  }

  /** Live noise-referenced exposure values (req 4). */
  rmsAboveNoise(rms: number): number {
    return rms / Math.max(this.cal?.noiseRmsMedian ?? this.adaptiveFloor, 1e-6);
  }
  snrLikeRatio(rms: number): number {
    return rms / Math.max(this.cal?.noiseRmsP90 ?? this.adaptiveFloor * 2, 1e-6);
  }
  zcrAboveNoise(zcr: number): number {
    return zcr / Math.max(this.cal?.noiseZcrMedian ?? 0.02, 1e-6);
  }

  /** Rolling frame history (≈200 frames / 2s at 10ms hops). */
  recentFrames(maxMs = 2000): AudioFrame[] {
    if (this.frames.length === 0) return [];
    const cutoff = this.frames[this.frames.length - 1].timestampMs - maxMs;
    return this.frames.filter((f) => f.timestampMs >= cutoff);
  }

  reset(): void {
    this.extractor.reset();
    this.frames = [];
    this.adaptiveFloor = 0.004;
    this.cal = null;
    this.calPhase = "idle";
    this.calSamples = [];
    this.seg = null;
    this.onsets = [];
    this.unit = null;
    this.chain = [];
    this.chainSims = [];
    this.localRmsRing = [];
    this.prevFrame = null;
    this.lastUnitEndMs = null;
    this.blockPhase = "idle";
    this.preBlock = null;
    this.recentSpeechRms = 0;
    this.lastSpeechMs = 0;
    this.chokeStartMs = 0;
    this.chokeMinRms = Infinity;
    this.sawSpeechThisSession = false;
    this.lastEmitByType = {};
    this.lastBlockRejectLog = 0;
    this.events.length = 0;
    this.diagnostics.length = 0;
    this.candidates.length = 0;
  }

  // ─── Frame intake ──────────────────────────────────────────────────────

  private onFrame(raw: RawFrame): void {
    const t = this.tuning;
    const noiseRef = this.cal?.noiseRmsMedian ?? this.adaptiveFloor;
    const speechGate = Math.max(t.ABS_RMS_FLOOR, noiseRef * t.SPEECH_RMS_FACTOR);

    const frame: AudioFrame = {
      timestampMs: raw.timestampMs,
      rms: raw.rms,
      zcr: raw.zcr,
      spectralCentroid: raw.spectralCentroid,
      spectralBandwidth: raw.spectralBandwidth,
      spectralFlux: raw.spectralFlux,
      voiced: raw.rms > speechGate && raw.zcr < t.VOICED_ZCR_MAX,
    };

    // Adaptive floor (only tracked while quiet — pre-calibration reference)
    if (raw.rms < this.adaptiveFloor * 2) {
      this.adaptiveFloor = this.adaptiveFloor * 0.95 + raw.rms * 0.05;
      this.adaptiveFloor = Math.max(t.ABS_RMS_FLOOR, this.adaptiveFloor);
    }

    // 2-second rolling frame history
    this.frames.push(frame);
    while (this.frames.length > 0) {
      const oldest = this.frames[0];
      if (frame.timestampMs - oldest.timestampMs <= 2000) break;
      this.frames.shift();
    }

    this.runProlongation(frame, speechGate);
    this.runRepetition(frame, speechGate);
    this.runBlock(frame, speechGate);

    this.prevFrame = frame;
  }

  // ─── PROLONGATION (sustained stable segment) ──────────────────────────

  private runProlongation(frame: AudioFrame, speechGate: number): void {
    const t = this.tuning;
    const isSpeech = frame.rms > speechGate;

    if (isSpeech) {
      if (this.seg && frame.timestampMs - this.seg.lastActiveMs > t.PROLONGATION_GAP_TOLERANCE_MS) {
        this.closeSeg(this.seg.lastActiveMs);
        this.seg = null;
      }
      if (!this.seg) {
        this.seg = {
          startMs: frame.timestampMs,
          lastActiveMs: frame.timestampMs,
          rmsArr: [],
          zcrArr: [],
          centArr: [],
          fluxArr: [],
          voicedCount: 0,
          confirmed: false,
        };
      }
      const s = this.seg;
      s.lastActiveMs = frame.timestampMs;
      s.rmsArr.push(frame.rms);
      s.zcrArr.push(frame.zcr);
      s.centArr.push(frame.spectralCentroid);
      s.fluxArr.push(frame.spectralFlux);
      if (frame.voiced) s.voicedCount++;
      // Keep up to ~12s of segment history (early-confirm uses the trailing
      // 450ms window; close-time evaluation uses the FULL segment so a long
      // fluent sentence is judged as a whole, not just its stable tail).
      if (s.rmsArr.length > 1200) {
        s.rmsArr.shift();
        s.zcrArr.shift();
        s.centArr.shift();
        s.fluxArr.shift();
      }

      // ── Early-confirm: as soon as a stable trailing core (≥450ms) exists,
      //    confirm IMMEDIATELY. A real prolongation releases into the word
      //    ("ssssssstop") — waiting for the segment to end would let the
      //    release corrupt the stability measurement and reject the event.
      if (!s.confirmed) {
        const durationMs = s.lastActiveMs - s.startMs;
        if (durationMs >= t.MIN_PROLONGATION_MS && s.rmsArr.length >= 45) {
          const startIdx = Math.max(0, s.rmsArr.length - 45);
          const st = windowStats(s, startIdx);
          if (
            st.centVar < t.CENTROID_VARIANCE_THRESHOLD &&
            st.fluxMean < t.SPECTRAL_FLUX_THRESHOLD
          ) {
            this.evaluateProlongationSegment(s, st, s.lastActiveMs, true);
            if (s.confirmed) return;
          }
        }
      }
    } else if (this.seg) {
      if (frame.timestampMs - this.seg.lastActiveMs > t.PROLONGATION_GAP_TOLERANCE_MS) {
        this.closeSeg(this.seg.lastActiveMs);
        this.seg = null;
      }
    }
  }

  private closeSeg(endMs: number): void {
    const seg = this.seg;
    if (!seg || seg.rmsArr.length < 4) return;
    if (!seg.confirmed) {
      // Ordinary syllables (< the log floor) are not prolongation candidates
      // and are silently dropped — only segments long enough to be one are
      // scored and logged.
      if (endMs - seg.startMs < this.tuning.PROLONG_LOG_MIN_MS) return;
      this.evaluateProlongationSegment(seg, windowStats(seg, 0), endMs, false);
    }
  }

  /** Score a prolongation segment and confirm or reject it. */
  private evaluateProlongationSegment(
    seg: SegAcc,
    st: ReturnType<typeof windowStats>,
    endMs: number,
    early: boolean
  ): void {
    const t = this.tuning;
    const durationMs = endMs - seg.startMs;
    const features: CandidateFeatures = {
      durationMs: Math.round(durationMs),
      meanRms: st.meanRms,
      rmsVariance: st.rmsVar,
      meanZcr: st.meanZcr,
      zcrVariance: st.zcrVar,
      centroidMean: st.centMean,
      centroidVariance: st.centVar,
      spectralFluxMean: st.fluxMean,
      spectralFluxVariance: st.fluxVar,
      onsetGapsMs: [],
      unitSimilarity: 0,
      onsetStrengthRatio: 0,
      rhythmScore: 0,
      repetitionCount: 0,
      dropRatio: 0,
      releaseRatio: 0,
      preBlockRms: 0,
      preBlockZcr: 0,
      rmsAboveNoise: this.rmsAboveNoise(st.meanRms),
      voicedRatio: st.voicedRatio,
    };

    if (durationMs <= t.MIN_PROLONGATION_MS) {
      this.rejectCandidate(
        "possible_prolongation",
        seg.startMs,
        endMs,
        0,
        features,
        `duration=${Math.round(durationMs)}ms < ${t.MIN_PROLONGATION_MS}ms`
      );
      return;
    }

    // Spectral stability — the signal must remain the SAME speech segment
    const reasons: string[] = [];
    if (st.centVar >= t.CENTROID_VARIANCE_THRESHOLD) {
      reasons.push(`centroid variance=${st.centVar.toFixed(0)} ≥ ${t.CENTROID_VARIANCE_THRESHOLD}`);
    }
    if (st.fluxMean >= t.SPECTRAL_FLUX_THRESHOLD) {
      reasons.push(`spectral flux=${st.fluxMean.toFixed(3)} ≥ ${t.SPECTRAL_FLUX_THRESHOLD}`);
    }
    if (reasons.length > 0) {
      this.rejectCandidate("possible_prolongation", seg.startMs, endMs, 0, features, reasons.join(" · "));
      return;
    }

    // Scorer — characteristic score from the measured features
    const durNorm = Math.min(1, durationMs / 900);
    const centScore = 1 - Math.min(1, st.centVar / t.CENTROID_VARIANCE_THRESHOLD);
    const fluxScore = 1 - Math.min(1, st.fluxMean / t.SPECTRAL_FLUX_THRESHOLD);
    const rmsScore = Math.min(1, this.rmsAboveNoise(st.meanRms) / 8);
    const score = Math.min(
      1,
      0.35 * durNorm + 0.3 * centScore + 0.2 * fluxScore + 0.15 * rmsScore
    );

    const classification: "fricative" | "vowel" =
      st.meanZcr >= t.FRICATIVE_ZCR_THRESHOLD ? "fricative" : "vowel";
    features.classification = classification;

    if (score >= t.PROLONG_CONFIRM_FLOOR) {
      seg.confirmed = true;
      this.confirm("prolongation", seg.startMs, endMs, score, features, classification);
    } else {
      this.rejectCandidate(
        "possible_prolongation",
        seg.startMs,
        endMs,
        score,
        features,
        `${early ? "stable core but " : ""}score=${score.toFixed(2)} < ${t.PROLONG_CONFIRM_FLOOR}`
      );
    }
  }

  // ─── REPETITION (repeated acoustic units) ─────────────────────────────

  private runRepetition(frame: AudioFrame, speechGate: number): void {
    const t = this.tuning;
    const isSpeech = frame.rms > speechGate;

    // Local energy reference (preceding ONSET_LOOKBACK_MS)
    this.localRmsRing.push(frame.rms);
    while (this.localRmsRing.length > Math.ceil(t.ONSET_LOOKBACK_MS / t.HOP_MS) + 2) {
      this.localRmsRing.shift();
    }
    const prevLocal =
      this.localRmsRing.slice(0, Math.max(1, this.localRmsRing.length - 1)).reduce((a, b) => a + b, 0) /
      Math.max(1, this.localRmsRing.length - 1);

    // Onset detection — short-term energy rises significantly vs local energy
    const lastOnset = this.onsets.length > 0 ? this.onsets[this.onsets.length - 1] : null;
    const gapSinceLast =
      lastOnset != null ? frame.timestampMs - lastOnset.timestampMs : Infinity;
    const rising = this.prevFrame ? frame.rms >= this.prevFrame.rms : true;
    const onset =
      isSpeech &&
      rising &&
      frame.rms > prevLocal * t.ONSET_MULTIPLIER &&
      gapSinceLast >= t.ONSET_MIN_GAP_MS;

    if (onset) {
      const strength = frame.rms / Math.max(prevLocal, 1e-4);
      const ons: Onset = {
        timestampMs: frame.timestampMs,
        rms: frame.rms,
        zcr: frame.zcr,
        spectralCentroid: frame.spectralCentroid,
        spectralBandwidth: frame.spectralBandwidth,
        strength,
      };
      this.onsets.push(ons);
      this.onsets = this.onsets.filter((o) => frame.timestampMs - o.timestampMs <= 1600);

      this.completeUnit(ons.timestampMs);
      this.startUnit(ons);
    } else if (this.unit && !isSpeech) {
      // Speech decayed — the unit is complete (the chain stays open until a
      // long silence or a dissimilar unit closes it).
      this.completeUnit(frame.timestampMs);
    }

    // Accumulate the current frame into the active unit (its acoustic shape
    // and RMS envelope are the raw material for unit-similarity scoring).
    if (this.unit) {
      const u = this.unit;
      u.endMs = frame.timestampMs;
      if (isSpeech) u.soundEndMs = frame.timestampMs;
      const inProfile = frame.timestampMs - u.onsetMs <= t.UNIT_PROFILE_MS;
      if (inProfile) {
        u.zcrSum += frame.zcr;
        u.centSum += frame.spectralCentroid;
        u.bwSum += frame.spectralBandwidth;
        u.profileCount++;
      }
      u.env.push(frame.rms);
      if (u.env.length > 60) u.env.shift(); // cap at ~600ms
    }

    // ── Chain timeout: a long silence ends the disfluency episode. Any
    //    chain of ≥2 repeated units that has not been extended since then
    //    is now final and scored. This keeps 3-unit chains alive across the
    //    short micro-gaps between repeated fragments.
    if (
      !this.unit &&
      this.chain.length >= 2 &&
      this.lastUnitEndMs != null &&
      frame.timestampMs - this.lastUnitEndMs > t.CHAIN_TIMEOUT_MS
    ) {
      this.closeChain(this.chain[this.chain.length - 1].endMs);
      this.chain = [];
      this.chainSims = [];
    }
  }

  private startUnit(ons: Onset): void {
    this.unit = {
      onsetMs: ons.timestampMs,
      endMs: ons.timestampMs,
      soundEndMs: ons.timestampMs,
      onsetStrength: ons.strength,
      zcrSum: 0,
      centSum: 0,
      bwSum: 0,
      profileCount: 0,
      env: [],
    };
  }

  /** Close the current unit; decide chain membership (chain stays open). */
  private completeUnit(endMs: number): void {
    const t = this.tuning;
    const unit = this.unit;
    if (!unit) return;
    unit.endMs = endMs;
    this.lastUnitEndMs = endMs;

    const prev = this.chain.length > 0 ? this.chain[this.chain.length - 1] : null;
    if (prev) {
      const gapMs = unit.onsetMs - prev.onsetMs;
      const sim = this.unitSimilarity(prev, unit);
      if (sim >= t.CHAIN_SIMILARITY_GATE && gapMs >= t.MIN_REPETITION_GAP_MS && gapMs <= t.MAX_REPETITION_GAP_MS) {
        // Same repeated acoustic unit — extend the chain
        this.chain.push(unit);
        this.chainSims.push(sim);
      } else {
        // Different unit / out-of-range gap — the previous chain is complete
        this.closeChain(unit.onsetMs);
        this.chain = [unit];
        this.chainSims = [];
      }
    } else {
      this.chain = [unit];
      this.chainSims = [];
    }

    this.unit = null;
  }

  /** Evaluate a finished chain of ≥2 repeated units → confirm or reject. */
  private closeChain(endMs: number): void {
    const t = this.tuning;
    const chain = this.chain;
    const sims = this.chainSims;
    if (chain.length < 2) return;

    const count = chain.length;
    const gaps: number[] = [];
    for (let i = 1; i < count; i++) gaps.push(chain[i].onsetMs - chain[i - 1].onsetMs);
    const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const absDev = gaps.reduce((a, b) => a + Math.abs(b - meanGap), 0) / gaps.length;
    const rhythmScore = Math.max(0, Math.min(1, 1 - absDev / 140));

    const unitSim = sims.length > 0 ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;
    const meanStrength = chain.reduce((a, u) => a + u.onsetStrength, 0) / count;
    const strengthScore = Math.min(1, meanStrength / 3);
    const countScore = count >= 3 ? 1 : 0.8;

    const score = Math.min(
      1,
      rhythmScore * unitSim * strengthScore * countScore
    );

    const features: CandidateFeatures = {
      durationMs: Math.round(endMs - chain[0].onsetMs),
      meanRms: 0,
      rmsVariance: 0,
      meanZcr: 0,
      zcrVariance: 0,
      centroidMean: 0,
      centroidVariance: 0,
      spectralFluxMean: 0,
      spectralFluxVariance: 0,
      onsetGapsMs: gaps.map((g) => Math.round(g)),
      unitSimilarity: unitSim,
      onsetStrengthRatio: meanStrength,
      rhythmScore,
      repetitionCount: count,
      dropRatio: 0,
      releaseRatio: 0,
      preBlockRms: 0,
      preBlockZcr: 0,
      rmsAboveNoise: 0,
      voicedRatio: 0,
    };

    const startMs = chain[0].onsetMs;

    // ── Scorer ──────────────────────────────────────────────────────
    const reasons: string[] = [];
    if (unitSim < t.CHAIN_SIMILARITY_GATE) {
      reasons.push(`insufficient unit similarity (${unitSim.toFixed(2)})`);
    }
    if (meanStrength < t.ONSET_STRENGTH_MIN) {
      reasons.push(`weak onset strength (${meanStrength.toFixed(1)}x)`);
    }
    if (rhythmScore < 0.25) {
      reasons.push(`irregular rhythm (gaps=${gaps.join("/")}ms)`);
    }

    if (count === 2) {
      // LESS evidence — stricter gate + brief-fragment requirement
      const firstDur = chain[0].soundEndMs - chain[0].onsetMs;
      if (unitSim < t.REPETITION_SIMILARITY_2UNIT_MIN) {
        reasons.push(`2-unit similarity ${unitSim.toFixed(2)} < ${t.REPETITION_SIMILARITY_2UNIT_MIN}`);
      }
      if (firstDur > t.UNIT_MAX_MS_2UNIT) {
        reasons.push(`first fragment too long (${Math.round(firstDur)}ms > ${t.UNIT_MAX_MS_2UNIT}ms)`);
      }
      if (reasons.length === 0 && score < t.REPETITION_CONFIRM_THRESHOLD_2UNIT) {
        reasons.push(`score=${score.toFixed(2)} < ${t.REPETITION_CONFIRM_THRESHOLD_2UNIT} (2-unit floor)`);
      }
    } else if (reasons.length === 0 && score < t.REPETITION_CONFIRM_THRESHOLD) {
      reasons.push(`score=${score.toFixed(2)} < ${t.REPETITION_CONFIRM_THRESHOLD}`);
    }

    if (reasons.length > 0) {
      this.rejectCandidate(
        "possible_repetition",
        startMs,
        endMs,
        score,
        features,
        reasons.join(" · ")
      );
      return;
    }

    this.confirm("repetition", startMs, endMs, score, features);
  }

  /** Acoustic similarity between two repeated units (0..1). */
  private unitSimilarity(a: Unit, b: Unit): number {
    const t = this.tuning;
    const w = t.SIM_WEIGHTS;
    const az = a.profileCount > 0 ? a.zcrSum / a.profileCount : 0;
    const bz = b.profileCount > 0 ? b.zcrSum / b.profileCount : 0;
    const ac = a.profileCount > 0 ? a.centSum / a.profileCount : 0;
    const bc = b.profileCount > 0 ? b.centSum / b.profileCount : 0;
    const ab = a.profileCount > 0 ? a.bwSum / a.profileCount : 0;
    const bb = b.profileCount > 0 ? b.bwSum / b.profileCount : 0;

    const zcrSim = 1 - Math.min(1, Math.abs(az - bz) / 0.25);
    const centSim = 1 - Math.min(1, Math.abs(ac - bc) / 1800);
    const bwSim = 1 - Math.min(1, Math.abs(ab - bb) / 1400);
    const envSim = this.envelopeSimilarity(a.env, b.env);

    return Math.max(
      0,
      Math.min(1, w.zcr * zcrSim + w.centroid * centSim + w.bandwidth * bwSim + w.envelope * envSim)
    );
  }

  /** Pearson correlation of two RMS envelopes resampled to 8 bins (0..1). */
  private envelopeSimilarity(envA: number[], envB: number[]): number {
    const resample = (env: number[]): number[] => {
      const out = new Array(8).fill(0);
      if (env.length === 0) return out;
      for (let b = 0; b < 8; b++) {
        const s = Math.floor((b * env.length) / 8);
        const e = Math.max(s + 1, Math.floor(((b + 1) * env.length) / 8));
        let sum = 0;
        for (let i = s; i < e && i < env.length; i++) sum += env[i];
        out[b] = sum / Math.max(1, e - s);
      }
      return out;
    };
    const a = resample(envA);
    const b = resample(envB);
    const ma = a.reduce((x, y) => x + y, 0) / 8;
    const mb = b.reduce((x, y) => x + y, 0) / 8;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < 8; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) * (a[i] - ma);
      db += (b[i] - mb) * (b[i] - mb);
    }
    if (da <= 1e-9 || db <= 1e-9) return 0.5; // flat envelopes — neutral
    const r = num / Math.sqrt(da * db);
    return Math.max(0, Math.min(1, (r + 1) / 2));
  }

  // ─── BLOCK (pre-block → choke → release) ─────────────────────────────

  private runBlock(frame: AudioFrame, speechGate: number): void {
    const t = this.tuning;
    const noiseRef = this.cal?.noiseRmsMedian ?? this.adaptiveFloor;
    const isSpeech = frame.rms > speechGate;

    if (isSpeech) {
      // Update the recent-speech reference
      this.recentSpeechRms = this.recentSpeechRms * 0.85 + frame.rms * 0.15;
      if (this.recentSpeechRms <= 0) this.recentSpeechRms = frame.rms;
      this.lastSpeechMs = frame.timestampMs;
      this.preBlock = { rms: frame.rms, zcr: frame.zcr, timeMs: frame.timestampMs };
      this.sawSpeechThisSession = true;

      if (this.blockPhase === "choke") {
        // ── RELEASE — energy returns to speech ──────────────────────
        this.blockPhase = "idle";
        const chokeRms = this.chokeMinRms === Infinity ? frame.rms : this.chokeMinRms;
        const releaseRatio = frame.rms / Math.max(chokeRms, 1e-6);
        const chokeDurMs = frame.timestampMs - this.chokeStartMs;
        const features: CandidateFeatures = this.blankFeatures();
        features.durationMs = Math.round(chokeDurMs);
        features.dropRatio = 1 - chokeRms / Math.max(this.recentSpeechRms, 1e-6);
        features.releaseRatio = releaseRatio;
        features.preBlockRms = this.preBlock?.rms ?? 0;
        features.preBlockZcr = this.preBlock?.zcr ?? 0;
        features.rmsAboveNoise = this.rmsAboveNoise(frame.rms);

        const reasons: string[] = [];
        if (chokeDurMs <= t.CHOKE_MIN_MS) {
          reasons.push(`choke ${Math.round(chokeDurMs)}ms ≤ ${t.CHOKE_MIN_MS}ms`);
        }
        if (releaseRatio < t.BLOCK_RELEASE_RATIO) {
          reasons.push(`weak release (${releaseRatio.toFixed(1)}x < ${t.BLOCK_RELEASE_RATIO}x)`);
        }
        if (reasons.length > 0) {
          this.rejectCandidate("possible_block", this.chokeStartMs, frame.timestampMs, 0, features, reasons.join(" · "));
          return;
        }
        const durScore = Math.min(1, chokeDurMs / 800);
        const score = Math.min(1, 0.5 + 0.3 * durScore + 0.2 * Math.min(1, releaseRatio / 4));
        this.confirm("block", this.chokeStartMs, frame.timestampMs, score, features);
      }
      return;
    }

    // ── Low energy — drop / choke tracking ──────────────────────────
    const recent = Math.max(this.recentSpeechRms, 1e-6);
    const dropRatio = 1 - frame.rms / recent;
    const contextOk =
      this.preBlock != null && frame.timestampMs - this.preBlock.timeMs <= t.PRE_BLOCK_CONTEXT_MS;
    const preLevelOk =
      (this.preBlock?.rms ?? 0) > Math.max(noiseRef * t.BLOCK_PRE_SPEECH_FACTOR, t.ABS_RMS_FLOOR * 4);
    // A true choke is an INTERRUPTION of phonation — the signal must reach
    // near-silence, not merely fall below the speech level. Residual energy
    // (room tone, breath) disqualifies it: that is a normal pause.
    const nearSilence = frame.rms < noiseRef * t.CHOKE_SILENCE_FACTOR;

    if (this.blockPhase === "idle") {
      if (dropRatio >= t.BLOCK_DROP_RATIO && contextOk && preLevelOk && nearSilence) {
        this.blockPhase = "choke";
        this.chokeStartMs = frame.timestampMs;
        this.chokeMinRms = frame.rms;
      } else if (
        dropRatio >= t.BLOCK_DROP_RATIO &&
        this.sawSpeechThisSession &&
        frame.timestampMs - this.lastSpeechMs > t.CHOKE_MIN_MS &&
        frame.timestampMs - this.lastBlockRejectLog > 1000
      ) {
        // A long low-energy interval after speech but without the required
        // drop-from-recent context — a NORMAL pause, explicitly rejected.
        this.lastBlockRejectLog = frame.timestampMs;
        const features = this.blankFeatures();
        features.durationMs = Math.round(frame.timestampMs - this.lastSpeechMs);
        features.dropRatio = dropRatio;
        features.preBlockRms = this.preBlock?.rms ?? 0;
        features.preBlockZcr = this.preBlock?.zcr ?? 0;
        features.rmsAboveNoise = this.rmsAboveNoise(frame.rms);
        this.rejectCandidate(
          "possible_block",
          this.lastSpeechMs,
          frame.timestampMs,
          0,
          features,
          !nearSilence
            ? `not an interruption (residual energy ${frame.rms.toFixed(4)} ≥ ${(noiseRef * t.CHOKE_SILENCE_FACTOR).toFixed(4)})`
            : contextOk
              ? `no pre-block speech context`
              : "drop below threshold"
        );
      }
    } else {
      // In choke — track the minimum (silence level) and timeout guard
      this.chokeMinRms = Math.min(this.chokeMinRms, frame.rms);
      if (frame.timestampMs - this.chokeStartMs > 3000) {
        // Abandon a choke that never releases (trailing silence at end of session)
        const features = this.blankFeatures();
        features.durationMs = Math.round(frame.timestampMs - this.chokeStartMs);
        features.dropRatio = 1 - this.chokeMinRms / recent;
        this.rejectCandidate("possible_block", this.chokeStartMs, frame.timestampMs, 0, features, "choke never released");
        this.blockPhase = "idle";
      }
    }
  }

  private blankFeatures(): CandidateFeatures {
    return {
      durationMs: 0,
      meanRms: 0,
      rmsVariance: 0,
      meanZcr: 0,
      zcrVariance: 0,
      centroidMean: 0,
      centroidVariance: 0,
      spectralFluxMean: 0,
      spectralFluxVariance: 0,
      onsetGapsMs: [],
      unitSimilarity: 0,
      onsetStrengthRatio: 0,
      rhythmScore: 0,
      repetitionCount: 0,
      dropRatio: 0,
      releaseRatio: 0,
      preBlockRms: 0,
      preBlockZcr: 0,
      rmsAboveNoise: 0,
      voicedRatio: 0,
    };
  }

  // ─── Candidate lifecycle ──────────────────────────────────────────────

  private rejectCandidate(
    type: AcousticCandidate["type"],
    startMs: number,
    endMs: number,
    score: number,
    features: CandidateFeatures,
    reason: string
  ): void {
    const cand: AcousticCandidate = {
      id: nextId("cand"),
      type,
      startTimeMs: Math.round(startMs),
      endTimeMs: Math.round(endMs),
      features,
      score,
      confidence: score,
    };
    this.candidates.push(cand);
    const diag: DspDiagnostic = {
      id: cand.id,
      candidateType: type,
      startTimeMs: cand.startTimeMs,
      endTimeMs: cand.endTimeMs,
      durationMs: features.durationMs,
      score,
      confirmed: false,
      rejectionReason: reason,
      features,
      logLine: `REJECTED ${type.replace("possible_", "")}:${reason}`,
    };
    this.diagnostics.push(diag);
    this.log(diag.logLine);
  }

  private confirm(
    eventType: DspEvent["type"],
    startMs: number,
    endMs: number,
    score: number,
    features: CandidateFeatures,
    classification?: "fricative" | "vowel"
  ): void {
    const t = this.tuning;
    const end = Math.max(endMs, startMs + 1);
    // Same-type cooldown — prevents double counting one physical event
    const last = this.lastEmitByType[eventType] ?? -Infinity;
    if (startMs - last < t.EVENT_COOLDOWN_MS) {
      this.rejectCandidate(
        `possible_${eventType}` as AcousticCandidate["type"],
        startMs,
        end,
        score,
        features,
        `cooldown — ${eventType} already emitted ${Math.round(startMs - last)}ms ago`
      );
      return;
    }
    this.lastEmitByType[eventType] = startMs;

    const evt: DspEvent = {
      id: nextId(`evt-${eventType}`),
      type: eventType,
      confidence: Math.min(1, Math.max(0, score)),
      startTimeMs: Math.round(startMs),
      endTimeMs: Math.round(end),
      durationMs: Math.round(end - startMs),
      source: "acoustic_dsp",
      acousticState: "confirmed",
      lexicalState: "unresolved",
      score,
      features,
      classification,
    };
    this.events.push(evt);

    const diag: DspDiagnostic = {
      id: evt.id,
      candidateType: `possible_${eventType}` as AcousticCandidate["type"],
      startTimeMs: evt.startTimeMs,
      endTimeMs: evt.endTimeMs,
      durationMs: evt.durationMs,
      score,
      confirmed: true,
      eventType,
      features,
      logLine: `CONFIRMED ${eventType}:score=${score.toFixed(2)} (${this.describe(evt)})`,
    };
    this.diagnostics.push(diag);
    this.log(diag.logLine);
  }

  private describe(evt: DspEvent): string {
    const f = evt.features;
    switch (evt.type) {
      case "repetition":
        return `onset times:${f.onsetGapsMs.length > 0 ? this.lastOnsetsDesc(evt) : "?"} gaps:${f.onsetGapsMs.join("/")}ms unit similarity:${f.unitSimilarity.toFixed(2)} repetition score:${evt.score.toFixed(2)}`;
      case "prolongation":
        return `duration:${f.durationMs}ms centroid variance:${f.centroidVariance.toFixed(4)} spectral flux:${f.spectralFluxMean.toFixed(3)} RMS above noise:${f.rmsAboveNoise.toFixed(1)}x (${f.classification ?? "?"})`;
      case "block":
        return `drop:${(f.dropRatio * 100).toFixed(0)}% choke:${f.durationMs}ms release:${f.releaseRatio.toFixed(1)}x`;
    }
  }

  private lastOnsetsDesc(_evt: DspEvent): string {
    return this.onsets
      .slice(-6)
      .map((o) => Math.round(o.timestampMs))
      .join(" ");
  }

  /** Drain remaining buffers at session end (emit trailing candidates). */
  finish(): void {
    const raws: RawFrame[] = [];
    this.extractor.flush(raws);
    for (const raw of raws) this.onFrame(raw);
    if (this.seg) {
      this.closeSeg(this.seg.lastActiveMs);
      this.seg = null;
    }
    if (this.unit) {
      this.completeUnit(this.unit.endMs);
    }
    if (this.chain.length >= 2) {
      this.closeChain(this.chain[this.chain.length - 1].endMs);
      this.chain = [];
      this.chainSims = [];
    }
    // Abandon any un-released choke (end-of-session silence)
    if (this.blockPhase === "choke") {
      const features = this.blankFeatures();
      features.durationMs = Math.round(this.chokeStartMs - this.lastSpeechMs);
      features.dropRatio = 1 - this.chokeMinRms / Math.max(this.recentSpeechRms, 1e-6);
      this.rejectCandidate("possible_block", this.chokeStartMs, this.chokeStartMs + features.durationMs, 0, features, "choke never released");
      this.blockPhase = "idle";
    }
  }
}

/** Re-export for callers that need sample-rate math. */
export { SAMPLE_RATE, samplesToMs };
