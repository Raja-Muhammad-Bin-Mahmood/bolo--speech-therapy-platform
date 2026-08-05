import { useRef, useCallback, useEffect, useState } from "react";

interface AudioCaptureState {
  level: number; // 0–1 normalized RMS
  isActive: boolean;
  stream: MediaStream | null;
  onAudioData: ((buffer: Float32Array) => void) | null;
}

/**
 * Captures mic audio via AudioContext.
 * Provides RMS level (for SiriLine) and raw Float32 PCM data
 * (for sending over WebSocket to Speechmatics).
 */
export function useAudioCapture() {
  const [state, setState] = useState<AudioCaptureState>({
    level: 0,
    isActive: false,
    stream: null,
    onAudioData: null,
  });

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const scriptRef = useRef<ScriptProcessorNode | null>(null);
  const rafRef = useRef<number>(0);
  const smoothRef = useRef(0);
  const dataRef = useRef(new Float32Array(0));
  const onAudioDataRef = useRef<((buffer: Float32Array) => void) | null>(null);

  const setOnAudioData = useCallback((cb: ((buffer: Float32Array) => void) | null) => {
    onAudioDataRef.current = cb;
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: 16000 });
      ctxRef.current = ctx;

      // CRITICAL: getUserMedia was awaited, so we are outside the click
      // gesture. Browsers (Chrome/Safari) auto-suspend an AudioContext
      // created outside a user gesture — a suspended context never fires
      // onaudioprocess and records dead air forever. Resume unconditionally.
      try {
        await ctx.resume();
      } catch (resumeErr) {
        console.warn("AudioContext.resume() failed:", resumeErr);
      }
      console.log("AudioContext state:", ctx.state, "sampleRate:", ctx.sampleRate);

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // AnalyserNode for RMS level
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyserRef.current = analyser;
      dataRef.current = new Float32Array(analyser.fftSize);

      // ScriptProcessorNode for raw PCM data
      const script = ctx.createScriptProcessor(4096, 1, 1);
      script.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        // Debug: verify mic data is non-zero
        if (input.length > 0) {
          const sum = input.reduce((a, b) => a + Math.abs(b), 0);
          const avg = sum / input.length;
          if (avg > 0.001) {
            console.log(
              "🎤 Mic chunk — byteLength:",
              input.byteLength,
              "length:",
              input.length,
              "avg abs:",
              avg.toFixed(6),
              "first sample:",
              input[0].toFixed(6)
            );
          }
        }
        if (onAudioDataRef.current) {
          // Clone the buffer so the WS can send it
          onAudioDataRef.current(new Float32Array(input));
        }
      };
      source.connect(script);
      script.connect(ctx.destination);
      scriptRef.current = script;

      setState((prev) => ({ ...prev, isActive: true, stream }));

      // Animation frame loop for RMS level
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
        const level = Math.min(smoothRef.current * 3, 1);

        setState((prev) => ({ ...prev, level }));

        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      console.warn("Mic access denied:", err);
      setState((prev) => ({ ...prev, isActive: false }));
    }
  }, []);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    scriptRef.current?.disconnect();
    sourceRef.current?.disconnect();
    analyserRef.current?.disconnect();
    ctxRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());

    streamRef.current = null;
    ctxRef.current = null;
    sourceRef.current = null;
    analyserRef.current = null;
    scriptRef.current = null;
    onAudioDataRef.current = null;

    setState({
      level: 0,
      isActive: false,
      stream: null,
      onAudioData: null,
    });
    smoothRef.current = 0;
  }, []);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  const getAnalyser = useCallback(() => analyserRef.current, []);

  return { ...state, start, stop, setOnAudioData, getAnalyser };
}