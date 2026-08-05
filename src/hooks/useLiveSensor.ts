/**
 * BOLO — useLiveSensor
 *
 * Lightweight hook that opens a dedicated mic stream and computes RMS, ZCR,
 * and Delta Energy via a simple AnalyserNode — no AudioWorklet, no FFT,
 * no classification. Designed to run in parallel with browser SpeechRecognition.
 *
 * Runs at ~30fps via requestAnimationFrame for smooth visual updates.
 */

import { useRef, useCallback, useEffect, useState } from "react";

export interface LiveSensorState {
  currentRms: number;
  currentZcr: number;
  currentDeltaEnergy: number;
  isActive: boolean;
  isReady: boolean;
}

const INITIAL: LiveSensorState = {
  currentRms: 0,
  currentZcr: 0,
  currentDeltaEnergy: 0,
  isActive: false,
  isReady: false,
};

export function useLiveSensor() {
  const [state, setState] = useState<LiveSensorState>(INITIAL);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);

  // Smoothed values for display
  const smoothRms = useRef(0);
  const prevRmsRef = useRef(0);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: 16000 });
      ctxRef.current = ctx;

      try { await ctx.resume(); } catch { /* non-critical */ }

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.85;
      source.connect(analyser);
      analyserRef.current = analyser;

      const data = new Float32Array(analyser.fftSize);

      setState((prev) => ({ ...prev, isReady: true, isActive: true }));

      let frameCount = 0;

      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getFloatTimeDomainData(data);

        // ── RMS ──
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          sumSq += data[i] * data[i];
        }
        const rms = Math.sqrt(sumSq / data.length);

        // ── ZCR ──
        let zc = 0;
        for (let i = 1; i < data.length; i++) {
          if (data[i] * data[i - 1] < 0) zc++;
        }
        const zcr = zc / (data.length - 1);

        // ── Delta Energy ──
        const deltaEnergy = prevRmsRef.current > 0
          ? rms - prevRmsRef.current
          : 0;
        prevRmsRef.current = rms;

        // Exponential moving average for smooth visual
        smoothRms.current = smoothRms.current * 0.6 + rms * 0.4;

        frameCount++;

        // Throttle React updates to ~30fps (every other rAF ~= 30 updates/s at 60fps)
        if (frameCount % 2 === 0) {
          setState({
            currentRms: Math.min(1, smoothRms.current * 2.5),
            currentZcr: Math.min(1, zcr),
            currentDeltaEnergy: Math.min(1, Math.abs(deltaEnergy) * 5),
            isActive: true,
            isReady: true,
          });
        }

        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      console.warn("🎤 Live sensor mic access denied:", err);
      setState((prev) => ({ ...prev, isActive: false, isReady: false }));
    }
  }, []);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);

    sourceRef.current?.disconnect();
    analyserRef.current?.disconnect();
    ctxRef.current?.close();

    streamRef.current?.getTracks().forEach((t) => t.stop());

    streamRef.current = null;
    ctxRef.current = null;
    sourceRef.current = null;
    analyserRef.current = null;
    smoothRms.current = 0;
    prevRmsRef.current = 0;
    rafRef.current = 0;

    setState(INITIAL);
  }, []);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return { ...state, start, stop };
}