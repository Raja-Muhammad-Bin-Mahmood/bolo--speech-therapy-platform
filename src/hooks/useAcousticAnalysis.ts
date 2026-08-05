import { useRef, useCallback, useEffect, useState } from "react";
import Meyda from "meyda";

// ─── Types ──────────────────────────────────────────────────────────────

export type AcousticEventType =
  | "block"
  | "repetition"
  | "prolongation"
  | "stutter"
  | "stammer";

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
  pitch: number; // F0 in Hz, 0 when unvoiced
  voiced: boolean;
  highBand: number; // mean linear magnitude 4-8kHz
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

// Stammer (sustained fricative: sssssssslap)
const STAMMER_MIN_MS = 150;
const STAMMER_MAX_MS = 600;
const STAMMER_RELEASE_WINDOW_MS = 150; // wait for voiced release to confirm

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

    // Block tracker
    blockStart: 0,
    blockZcrAcc: 0,
    blockCount: 0,
    prevRms: 0,

    // Prolongation tracker
    prolongStart: 0,
    pitchRing: [] as number[],

    // Stutter (fricative burst pattern)
    fricStart: 0,
    prevFric: false,
    fricBursts: [] as { start: number; end: number; durMs: number; strength: number }[],
    hiBaseline: 0.004,

    // Stammer (sustained fricative hold — deferred confirm)
    pendingStammer: null as {
      start: number;
      end: number;
      durMs: number;
      strength: number;
    } | null,
    pendingStammerTick: 0,

    // Event de-dupe
    lastEmit: 0,
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

      if (runDurMs >= STUTTER_BURST_MIN_MS && runDurMs <= STUTTER_BURST_MAX_MS) {
        // Short burst — candidate for stutter pattern
        const bursts = s.fricBursts;
        const lastBurst = bursts.length > 0 ? bursts[bursts.length - 1] : null;
        const gapMs = lastBurst
          ? (s.fricStart - lastBurst.end) * 1000
          : Infinity;

        if (
          lastBurst &&
          gapMs >= STUTTER_GAP_MIN_MS &&
          gapMs <= STUTTER_GAP_MAX_MS
        ) {
          bursts.push({
            start: s.fricStart,
            end: t,
            durMs: Math.round(runDurMs),
            strength: burstStrength,
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

              const temporal =
                0.5 + 0.25 * regularity + 0.15 * burstFactor + 0.1 * strengthAvg;
              const acoustic = 0.5 + 0.3 * burstFactor + 0.2 * strengthAvg;

              emitEvent("stutter", firstBurst.start, t, temporal, acoustic);

              // Keep only the last burst for overlap continuity
              s.fricBursts = [bursts[bursts.length - 1]];
              s.lastStutterEnd = t;
            }
          }
        } else {
          // Gap too large — start a fresh pattern
          if (lastBurst && gapMs > STUTTER_GAP_MAX_MS) {
            bursts.length = 0;
          }
          bursts.push({
            start: s.fricStart,
            end: t,
            durMs: Math.round(runDurMs),
            strength: burstStrength,
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
      if (f.voiced) {
        const p = s.pendingStammer;
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
    if (f.voiced && !s.prevVoiced) {
      s.onsets.push(t);
      s.voicingOnRuns.push({ start: t, end: t });
      s.onsets = s.onsets.filter((o) => t - o <= FAST_RESTART_MAX + 0.05);
      s.voicingOnRuns = s.voicingOnRuns.filter(
        (r) => t - r.start <= FAST_RESTART_MAX + 0.05
      );
    }

    // Track end of the current voiced run
    if (f.voiced && s.voicingOnRuns.length > 0) {
      const lastRun = s.voicingOnRuns[s.voicingOnRuns.length - 1];
      lastRun.end = t;
    }

    // Repetition: ≥3 onsets spaced 80–250ms apart, brief runs, no stutter overlap
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
      const noStutterOverlap = s.onsets[0] > s.lastStutterEnd + 0.15;

      if (allInRange && runsBrief && noStutterOverlap) {
        const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const regularity = 1 - Math.min(1, Math.abs(avgGap - 0.165) / 0.1);
        const zcrAgree = ringRef.current.some(
          (fr) => fr.t >= s.onsets[0] && fr.zcr > ZCR_TENSION
        );
        const temporal = 0.55 + 0.3 * regularity + (zcrAgree ? 0.15 : 0);
        emitEvent(
          "repetition",
          s.onsets[0],
          s.onsets[s.onsets.length - 1],
          temporal,
          Math.min(1, 0.5 + avgGap / 0.25)
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
    acoustic: number
  ) {
    const s = stateRef.current;
    if (temporal < 0.75) return;

    // Global de-dupe: no two events within 250ms
    if (endTime - s.lastEmit < 0.25) return;
    s.lastEmit = endTime;

    const evt: AcousticEvent = {
      type,
      startTime,
      endTime,
      durationMs: Math.round((endTime - startTime) * 1000),
      confidence: Math.min(1, temporal),
      acoustic: Math.min(1, acoustic),
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
        lastEmit: 0,
        lastStutterEnd: 0,
      };
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, tick]);

  return { events, getEvents: () => eventsRef.current };
}