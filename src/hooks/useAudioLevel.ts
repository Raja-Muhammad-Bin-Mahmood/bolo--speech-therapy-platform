import { useRef, useCallback, useEffect, useState } from "react";

/**
 * Captures mic audio and computes RMS (root-mean-square) level
 * via an AnalyserNode, using exponential moving average for smoothness.
 */
export function useAudioLevel() {
  const [level, setLevel] = useState(0); // 0–1 normalized RMS
  const [isActive, setIsActive] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);
  const smoothRef = useRef(0);
  const dataRef = useRef(new Float32Array(0));

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ctx = new AudioContext();
      ctxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyserRef.current = analyser;

      dataRef.current = new Float32Array(analyser.fftSize);
      setIsActive(true);

      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getFloatTimeDomainData(dataRef.current);

        let sum = 0;
        for (let i = 0; i < dataRef.current.length; i++) {
          sum += dataRef.current[i] * dataRef.current[i];
        }
        const rms = Math.sqrt(sum / dataRef.current.length);

        // Exponential moving average for smoothness
        smoothRef.current = smoothRef.current * 0.7 + rms * 0.3;
        setLevel(Math.min(smoothRef.current * 3, 1)); // amplify for visual

        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      console.warn("Mic access denied:", err);
      setIsActive(false);
    }
  }, []);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    sourceRef.current?.disconnect();
    ctxRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current = null;
    sourceRef.current = null;
    analyserRef.current = null;
    setIsActive(false);
    setLevel(0);
    smoothRef.current = 0;
  }, []);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return { level, isActive, start, stop, stream: streamRef };
}