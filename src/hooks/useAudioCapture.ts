import { useRef, useCallback, useEffect, useState } from "react";
import type { StutterCandidate } from "../lib/stutterTypes";

interface AudioCaptureState {
  level: number; // 0–1 normalized RMS
  isActive: boolean;
  stream: MediaStream | null;
  /** True when the AudioWorklet loaded and is running the DSP lane. */
  stutterSupported: boolean;
  /** Candidates since the session started (session-relative time, updated live). */
  stutterCandidates: StutterCandidate[];
  onAudioData: ((buffer: Float32Array) => void) | null;
}

/**
 * Captures mic audio via AudioContext.
 *
 * PRIMARY lane: AudioWorklet-based processing:
 *   - Runs stutter DSP off the main thread.
 *   - Forwards PCM chunks to the Speechmatics WebSocket callback.
 *   - Posts candidate stutter events.
 *
 * FALLBACK: ScriptProcessorNode (when AudioWorklet unsupported).
 *   - PCM streaming only, no stutter detection.
 *
 * Provides RMS level (for SiriLine / ReactiveWaveform) via a shared AnalyserNode.
 */
export function useAudioCapture() {
  const [state, setState] = useState<AudioCaptureState>({
    level: 0,
    isActive: false,
    stream: null,
    stutterSupported: false,
    stutterCandidates: [],
    onAudioData: null,
  });

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // Worklet refs
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const stutterSupportedRef = useRef(false);

  // Fallback ScriptProcessor ref
  const scriptRef = useRef<ScriptProcessorNode | null>(null);

  // RMS animation frame
  const rafRef = useRef<number>(0);
  const smoothRef = useRef(0);
  const dataRef = useRef(new Float32Array(0));

  // PCM forwarding
  const onAudioDataRef = useRef<((buffer: Float32Array) => void) | null>(null);

  // ── Stutter clock alignment ──────────────────────────────────────────
  // asrT0 = worklet-relative time when the first PCM chunk was forwarded
  // after the page signalled readiness. All candidate timestamps are
  // shifted by this value to produce session-relative time.
  const asrT0Ref = useRef<number | null>(null);
  const pinPendingRef = useRef(false);
  const pendingCandidatesRaw = useRef<
    { evt: StutterCandidate; rawStart: number }[]
  >([]);
  const candidatesRef = useRef<StutterCandidate[]>([]);

  // ── Start ──────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: 16000 });
      ctxRef.current = ctx;

      // Resume (context created outside user gesture after async gap)
      try {
        await ctx.resume();
      } catch {
        // non-critical
      }

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // AnalyserNode for RMS level (shared between both lanes)
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyserRef.current = analyser;
      dataRef.current = new Float32Array(analyser.fftSize);

      // ── Try AudioWorklet ─────────────────────────────────────
      let workletUsed = false;
      try {
        const url = new URL(
          "/audio/stutter-detector.worklet.js",
          window.location.origin
        );
        await ctx.audioWorklet.addModule(url.href);

        const workletNode = new AudioWorkletNode(ctx, "bolo-stutter-detector", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
          channelCountMode: "explicit",
        });

        workletNode.port.onmessage = (ev: MessageEvent) => {
          const msg = ev.data;
          if (!msg || typeof msg !== "object") return;

          if (msg.type === "pcm") {
            self.current._handlePcmMessage(msg);
          } else if (msg.type === "candidate" && msg.evt) {
            self.current._handleCandidateMessage(msg.evt);
          }
        };

        source.connect(workletNode);
        workletNodeRef.current = workletNode;
        stutterSupportedRef.current = true;
        workletUsed = true;

        console.log("🎧 AudioWorklet lane ACTIVE — stutter DSP on audio thread");
      } catch (workletErr) {
        console.warn(
          "AudioWorklet unavailable — falling back to ScriptProcessorNode:",
          workletErr
        );
      }

      // ── Fallback: ScriptProcessorNode for PCM ────────────────
      if (!workletUsed) {
        const script = ctx.createScriptProcessor(4096, 1, 1);
        script.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0);
          if (onAudioDataRef.current) {
            onAudioDataRef.current(new Float32Array(input));
          }
        };
        source.connect(script);
        script.connect(ctx.destination);
        scriptRef.current = script;
      }

      setState((prev) => ({
        ...prev,
        isActive: true,
        stream,
        stutterSupported: stutterSupportedRef.current,
      }));

      // Animation frame for RMS level
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getFloatTimeDomainData(dataRef.current);
        let sum = 0;
        for (let i = 0; i < dataRef.current.length; i++) {
          sum += dataRef.current[i] * dataRef.current[i];
        }
        const rms = Math.sqrt(sum / dataRef.current.length);
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

  // ══════════════════════════════════════════════════════════════════
  // Message handlers (use ref-bound this for ergonomics in closures)
  // ══════════════════════════════════════════════════════════════════

  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const self = useRef({ _handlePcmMessage() {}, _handleCandidateMessage() {} });
  self.current._handlePcmMessage = (msg: { t: number; buffer: Float32Array }) => {
    // Pin clock on first PCM after pinClock() was called
    if (pinPendingRef.current) {
      asrT0Ref.current = msg.t;
      pinPendingRef.current = false;

      // Flush pending candidates that arrived before alignment
      const raw = pendingCandidatesRaw.current;
      const asrT0 = asrT0Ref.current;
      for (const r of raw) {
        const sessionStart = r.rawStart - asrT0;
        if (sessionStart >= 0) {
          candidatesRef.current.push({
            ...r.evt,
            startTime: sessionStart,
            endTime: r.evt.endTime - asrT0,
          });
        }
      }
      pendingCandidatesRaw.current = [];
      setState((prev) => ({ ...prev, stutterCandidates: [...candidatesRef.current] }));
    }

    // Forward PCM to the Speechmatics callback
    if (onAudioDataRef.current) {
      onAudioDataRef.current(new Float32Array(msg.buffer));
    }
  };

  self.current._handleCandidateMessage = (evt: StutterCandidate) => {
    const asrT0 = asrT0Ref.current;

    if (asrT0 === null) {
      // Clock not yet aligned — stash for later
      pendingCandidatesRaw.current.push({ evt, rawStart: evt.startTime });
      return;
    }

    const sessionStart = evt.startTime - asrT0;
    if (sessionStart < 0) return; // before ASR started — drop

    const candidate: StutterCandidate = {
      ...evt,
      startTime: sessionStart,
      endTime: evt.endTime - asrT0,
    };
    candidatesRef.current = [...candidatesRef.current, candidate];
    setState((prev) => ({
      ...prev,
      stutterCandidates: [...candidatesRef.current],
    }));
  };

  // ── Pin clock to ASR-ready moment ─────────────────────────────────
  // Called by the page (e.g. RecordingSession) when ws.status becomes "connected".
  const pinClock = useCallback(() => {
    if (asrT0Ref.current !== null) return; // already pinned
    pinPendingRef.current = true;
  }, []);

  const setOnAudioData = useCallback(
    (cb: ((buffer: Float32Array) => void) | null) => {
      onAudioDataRef.current = cb;
    },
    []
  );

  const getAnalyser = useCallback(() => analyserRef.current, []);

  const getStutterCandidates = useCallback((): StutterCandidate[] => {
    return candidatesRef.current.map((c) => ({ ...c }));
  }, []);

  // ── Stop ──────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);

    workletNodeRef.current?.disconnect();
    scriptRef.current?.disconnect();
    sourceRef.current?.disconnect();
    analyserRef.current?.disconnect();
    ctxRef.current?.close();

    streamRef.current?.getTracks().forEach((t) => t.stop());

    streamRef.current = null;
    ctxRef.current = null;
    sourceRef.current = null;
    analyserRef.current = null;
    workletNodeRef.current = null;
    scriptRef.current = null;
    onAudioDataRef.current = null;
    asrT0Ref.current = null;
    pinPendingRef.current = false;
    pendingCandidatesRaw.current = [];
    candidatesRef.current = [];
    stutterSupportedRef.current = false;

    setState({
      level: 0,
      isActive: false,
      stream: null,
      stutterSupported: false,
      stutterCandidates: [],
      onAudioData: null,
    });
    smoothRef.current = 0;
  }, []);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return {
    ...state,
    start,
    stop,
    setOnAudioData,
    getAnalyser,
    getStutterCandidates,
    pinClock,
  };
}