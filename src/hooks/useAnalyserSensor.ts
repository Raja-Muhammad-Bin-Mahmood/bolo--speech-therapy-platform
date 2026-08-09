/**
 * BOLO — useAnalyserSensor
 *
 * Reads RMS, ZCR and ΔEnergy straight from a SHARED AnalyserNode (no second
 * mic stream — it taps the same audio the app is already recording) and runs
 * a lightweight tension detector on those SAME values:
 *
 *   • STUTTER  — ≥3 tight energy bursts (RMS spikes) with elevated ZCR,
 *                spaced 60–260ms apart inside an 800ms window. A sudden ΔE
 *                spike (plosive onset, acoustic rule PLOSIVE_BURST) also
 *                registers as a burst.
 *   • STAMMER  — sustained high RMS + elevated ZCR (fricative / tense hold)
 *                lasting 200–650ms.
 *
 * The meters on the left and the detection feed are one and the same signal —
 * the visible physics genuinely drive the detector.
 */

import { useRef, useCallback, useEffect, useState } from "react";
import type { LiveSensorState } from "./useLiveSensor";
import type { AcousticEvent } from "./useAcousticAnalysis";
import { diag } from "../lib/diagnosticLog";

// ─── Live meter state (compatible with SensorSidebar / TelemetryPanel) ───

interface AnalyserSensorState extends LiveSensorState {
  /** Unscaled values exposed for the developer telemetry rail. */
  rawRms: number;
  rawZcr: number;
  rawDeltaEnergy: number;
}

const INITIAL: AnalyserSensorState = {
  currentRms: 0,
  currentZcr: 0,
  currentDeltaEnergy: 0,
  rawRms: 0,
  rawZcr: 0,
  rawDeltaEnergy: 0,
  isActive: false,
  isReady: false,
};

// ─── Detection tuning (conservative — false positives are worse than misses)

const RMS_FLOOR = 0.004; // absolute noise-floor floor
const BURST_RMS_FACTOR = 3.2; // burst peak vs adaptive noise floor
const BURST_ZCR_MIN = 0.1; // bursts must be noisy (plosive/fricative-like)
const BURST_MIN_MS = 30;
const BURST_MAX_MS = 220;
const GAP_MIN_MS = 60;
const GAP_MAX_MS = 260;
const MIN_BURSTS = 3;
const STUTTER_WINDOW_MS = 800;

const STAMMER_RMS_FACTOR = 2.6; // sustained tension vs noise floor
const STAMMER_ZCR_MIN = 0.16; // fricative / tight-larynx hold
const STAMMER_MIN_MS = 200;
const STAMMER_MAX_MS = 650;

/**
 * Fricative shape confirmation for the burst machine. Detector B only has
 * RMS/ZCR/ΔE — no spectral centroid — so we approximate a fricative onset
 * with high ZCR (noise-like) + a sharp ΔE spike. This is the burst-level
 * fricative gate: a pure loud-plosive burst ("k", "t", "p" — low ZCR,
 * high ΔE) no longer registers as a stutter fragment. A real repeated
 * fricative ("s-s-s-") has noisy high-ZCR bursts and passes.
 */
const BURST_FRICATIVE_ZCR_MIN = 0.22;
const BURST_DELTA_SPIKE_MIN = 0.01;
/** How many frames inside the burst must show the fricative shape. */
const BURST_SHAPE_MIN_FRAMES = 1;

const COOLDOWN_MS = 300; // no two sensor events within 300ms
const ROLLING_MS = 800; // rolling frame window
const VOICE_FLOOR = 0.006; // absolute minimum for "speech" RMS

interface SensorFrame {
  t: number;
  rms: number;
  zcr: number;
  delta: number;
}

export function useAnalyserSensor(
  getAnalyser: () => AnalyserNode | null,
  active: boolean
) {
  const [state, setState] = useState<AnalyserSensorState>(INITIAL);
  const [events, setEvents] = useState<AcousticEvent[]>([]);
  const eventsRef = useRef<AcousticEvent[]>([]);

  const rafRef = useRef(0);
  const frameCountRef = useRef(0);
  const dataRef = useRef(new Float32Array(0));
  const startRef = useRef(0);
  const prevRmsRef = useRef(0);
  const floorRef = useRef(RMS_FLOOR);
  const lastEmitRef = useRef(0);

  // Rolling window of recent frames
  const ringRef = useRef<SensorFrame[]>([]);

  // Burst (stutter) state machine
  const burstRef = useRef<{ start: number; end: number; durMs: number }[]>([]);
  const burstStartRef = useRef(0);
  const inBurstRef = useRef(false);
  /** Fricative-shape frame counter for the current burst (see burst gate). */
  const shapeFramesRef = useRef(0);

  // Stammer (sustained tension) state machine
  const stammerStartRef = useRef(0);
  const stammerPeakRef = useRef(0);

  // ── Detection core ────────────────────────────────────────────────────
  const detect = useCallback(
    (t: number, rms: number, zcr: number, delta: number) => {
      const floor = Math.max(RMS_FLOOR, floorRef.current);
      const voiceRms = Math.max(VOICE_FLOOR, floor * 2.2);

      // ── Burst machine (stutter pattern) ─────────────────────────────
      // A burst is a loud, noisy onset — OR a sudden ΔE spike (plosive
      // onset, acoustic rule PLOSIVE_BURST). Since Detector B has no
      // spectral centroid, the burst must ALSO show a fricative shape
      // (high ZCR + sharp ΔE) — a pure loud plosive burst ("k", "t", "p")
      // must not register as a stutter fragment, or any word with ≥3
      // consonant onsets would false-positive.
      const inBurst =
        (rms > Math.max(voiceRms * 1.4, floor * BURST_RMS_FACTOR) &&
          zcr > BURST_ZCR_MIN) ||
        delta > floor * 3; // PLOSIVE_BURST: ΔE > 3 × E_floor

      if (inBurst) {
        if (!inBurstRef.current) {
          burstStartRef.current = t;
          shapeFramesRef.current = 0;
        }
        inBurstRef.current = true;
        // Fricative shape confirmation: the burst frame must be noisy
        // (high ZCR) AND carry a sharp energy rise. ΔE spikes on their own
        // (plosives, mic pops) never count toward the stutter pattern.
        if (zcr > BURST_FRICATIVE_ZCR_MIN && delta > BURST_DELTA_SPIKE_MIN) {
          shapeFramesRef.current++;
        }
      } else if (inBurstRef.current) {
        inBurstRef.current = false;
        const durMs = (t - burstStartRef.current) * 1000;

        const durOkB = durMs >= BURST_MIN_MS && durMs <= BURST_MAX_MS;
        const shapeOkB = shapeFramesRef.current >= BURST_SHAPE_MIN_FRAMES;
        diag("sensor-burst", {
          stage: "end",
          at: +t.toFixed(3),
          startTime: +burstStartRef.current.toFixed(3),
          durMs: Math.round(durMs),
          minMs: BURST_MIN_MS,
          maxMs: BURST_MAX_MS,
          shapeFrames: shapeFramesRef.current,
          shapeMin: BURST_SHAPE_MIN_FRAMES,
          rms: +rms.toFixed(4),
          zcr: +zcr.toFixed(3),
          delta: +delta.toFixed(4),
          floor: +floor.toFixed(4),
          accepted: durOkB && shapeOkB,
        });
        if (durOkB && shapeOkB) {
          const bursts = burstRef.current;
          const last = bursts.length > 0 ? bursts[bursts.length - 1] : null;
          const gapMs = last
            ? (burstStartRef.current - last.end) * 1000
            : Infinity;

          if (last && gapMs >= GAP_MIN_MS && gapMs <= GAP_MAX_MS) {
            bursts.push({
              start: burstStartRef.current,
              end: t,
              durMs: Math.round(durMs),
            });
            diag("sensor-stutter", {
              stage: "burst-append",
              at: +t.toFixed(3),
              burstCount: bursts.length,
              burstDurMs: Math.round(durMs),
              gapMs: Math.round(gapMs),
              shapeFrames: shapeFramesRef.current,
            });

            if (bursts.length >= MIN_BURSTS) {
              const spanMs = (t - bursts[0].start) * 1000;
              if (spanMs <= STUTTER_WINDOW_MS) {
                diag("sensor-stutter", {
                  stage: "emit",
                  startTime: +bursts[0].start.toFixed(3),
                  endTime: +t.toFixed(3),
                  burstCount: bursts.length,
                  spanMs: Math.round(spanMs),
                  windowMs: STUTTER_WINDOW_MS,
                });
                emitEvent("stutter", bursts[0].start, t);
                burstRef.current = [bursts[bursts.length - 1]];
              } else {
                diag("sensor-stutter", {
                  stage: "span-too-wide",
                  startTime: +bursts[0].start.toFixed(3),
                  endTime: +t.toFixed(3),
                  burstCount: bursts.length,
                  spanMs: Math.round(spanMs),
                  windowMs: STUTTER_WINDOW_MS,
                });
              }
            }
          } else {
            // Gap too big or first burst — (re)start the pattern
            if (last && gapMs > GAP_MAX_MS) burstRef.current = [];
            burstRef.current = [
              ...burstRef.current,
              {
                start: burstStartRef.current,
                end: t,
                durMs: Math.round(durMs),
              },
            ];
            if (burstRef.current.length > 6) burstRef.current.shift();
          }
        } else {
          // Run too short/long for a stutter burst — discard the pattern
          burstRef.current = [];
        }
      }

      // ── Stammer machine (sustained tense hold) ──────────────────────
      const tense = rms > voiceRms * 1.15 && zcr > STAMMER_ZCR_MIN;
      if (tense) {
        if (stammerStartRef.current === 0) {
          stammerStartRef.current = t;
          diag("sensor-stammer", {
            stage: "hold-open",
            at: +t.toFixed(3),
            rms: +rms.toFixed(4),
            voiceRms: +voiceRms.toFixed(4),
            rmsGate: +(voiceRms * 1.15).toFixed(4),
            zcr: +zcr.toFixed(3),
            zcrMin: STAMMER_ZCR_MIN,
          });
        }
        stammerPeakRef.current = Math.max(stammerPeakRef.current, rms);
      } else if (stammerStartRef.current > 0) {
        const durMs = (t - stammerStartRef.current) * 1000;
        const sustained =
          stammerPeakRef.current > voiceRms * STAMMER_RMS_FACTOR * 0.6;
        diag("sensor-stammer", {
          stage: "hold-end",
          startTime: +stammerStartRef.current.toFixed(3),
          endTime: +t.toFixed(3),
          durMs: Math.round(durMs),
          minMs: STAMMER_MIN_MS,
          maxMs: STAMMER_MAX_MS,
          peakRms: +stammerPeakRef.current.toFixed(4),
          sustainedGate: +(voiceRms * STAMMER_RMS_FACTOR * 0.6).toFixed(4),
          sustained,
          emit: durMs >= STAMMER_MIN_MS && durMs <= STAMMER_MAX_MS && sustained,
        });
        if (durMs >= STAMMER_MIN_MS && durMs <= STAMMER_MAX_MS && sustained) {
          emitEvent("stammer", stammerStartRef.current, t);
        }
        stammerStartRef.current = 0;
        stammerPeakRef.current = 0;
      }
    },
    []
  );

  // ── Emit with de-dupe ────────────────────────────────────────────────
  const emitEvent = useCallback(
    (type: "stutter" | "stammer", start: number, end: number) => {
      if (end - lastEmitRef.current < COOLDOWN_MS / 1000) return;
      lastEmitRef.current = end;
      const evt: AcousticEvent = {
        type,
        startTime: start,
        endTime: end,
        durationMs: Math.round((end - start) * 1000),
        confidence: 0.85,
        acoustic: 0.8,
        source: "sensor",
      };
      eventsRef.current = [...eventsRef.current, evt];
      setEvents(eventsRef.current);
    },
    []
  );

  // ── Main rAF loop ────────────────────────────────────────────────────
  const tick = useCallback(() => {
    const analyser = getAnalyser();
    if (analyser) {
      const now = performance.now();
      if (!startRef.current) startRef.current = now;
      const t = (now - startRef.current) / 1000;

      const buf = dataRef.current;
      if (buf.length !== analyser.fftSize) {
        dataRef.current = new Float32Array(analyser.fftSize);
      }
      analyser.getFloatTimeDomainData(buf);

      // RMS
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
      const rms = Math.sqrt(sumSq / buf.length);

      // ZCR
      let zc = 0;
      for (let i = 1; i < buf.length; i++) {
        if (buf[i] * buf[i - 1] < 0) zc++;
      }
      const zcr = zc / Math.max(1, buf.length - 1);

      // ΔEnergy
      const delta = prevRmsRef.current > 0 ? rms - prevRmsRef.current : 0;
      prevRmsRef.current = rms;

      // Adaptive noise floor (tracked only while quiet)
      if (rms < floorRef.current * 2) {
        floorRef.current = floorRef.current * 0.95 + rms * 0.05;
      }
      floorRef.current = Math.max(RMS_FLOOR, floorRef.current);

      // Rolling window
      const ring = ringRef.current;
      ring.push({ t, rms, zcr, delta });
      while (ring.length > 0 && (t - ring[0].t) * 1000 > ROLLING_MS) {
        ring.shift();
      }

      detect(t, rms, zcr, delta);

      // Throttle React updates to ~30fps
      frameCountRef.current++;
      if (frameCountRef.current % 2 === 0) {
        setState({
          currentRms: Math.min(1, rms * 2.5),
          currentZcr: Math.min(1, zcr),
          currentDeltaEnergy: Math.min(1, Math.abs(delta) * 5),
          rawRms: rms,
          rawZcr: zcr,
          rawDeltaEnergy: delta,
          isActive: true,
          isReady: true,
        });
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [getAnalyser, detect]);

  // ── Lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) {
      eventsRef.current = [];
      setEvents([]);
      ringRef.current = [];
      burstRef.current = [];
      burstStartRef.current = 0;
      inBurstRef.current = false;
      shapeFramesRef.current = 0;
      stammerStartRef.current = 0;
      stammerPeakRef.current = 0;
      startRef.current = 0;
      prevRmsRef.current = 0;
      floorRef.current = RMS_FLOOR;
      lastEmitRef.current = 0;
      frameCountRef.current = 0;
      setState(INITIAL);
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, tick]);

  // Cleanup on unmount
  useEffect(() => {
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return {
    ...state,
    events,
    getEvents: () => eventsRef.current,
  };
}
