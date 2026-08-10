import { useRef, useCallback, useEffect, useState } from "react";
import type { StutterCandidate, TimelineFrame } from "../lib/stutterTypes";
import { TimelineEngine } from "../lib/timelineEngine";
import * as sessionClock from "../lib/sessionClock";
import {
  resolveMicProfile,
  getMicConstraints,
} from "../lib/micConstraints";

interface AudioCaptureState {
  level: number; // 0–1 normalized RMS
  isActive: boolean;
  stream: MediaStream | null;
  /** True when the AudioWorklet loaded and is running the DSP lane. */
  stutterSupported: boolean;
  /** Candidates since the session started (session-relative time, updated live). */
  stutterCandidates: StutterCandidate[];
  /** Latest classified frame from the telemetry worklet (for debugging). */
  latestFrame: TimelineFrame | null;
  onAudioData: ((buffer: Float32Array) => void) | null;
}

/**
 * Captures mic audio via AudioContext.
 *
 * PRIMARY lane: AudioWorklet-based processing (bolo-telemetry-processor):
 *   - Runs physics-based DSP off the main thread.
 *   - Classifies every 20ms frame into phonetic categories.
 *   - Forwards PCM chunks to the Speechmatics WebSocket callback.
 *   - TimelineEngine (main thread) detects patterns from classified frames.
 *
 * FALLBACK: ScriptProcessorNode (when AudioWorklet unsupported).
 *   - PCM streaming only, no telemetry detection.
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
    latestFrame: null,
    onAudioData: null,
  });

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  /** ACTUAL AudioContext sample rate (verified — may differ from requested). */
  const sampleRateRef = useRef<number | null>(null);
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

  // PCM forwarding to Speechmatics
  const onAudioDataRef = useRef<((buffer: Float32Array) => void) | null>(null);

  // Raw PCM tap for the recovery ring buffer (worklet clock, same stream
  // that feeds Speechmatics — so timestamps share one clock).
  const onPcmRef = useRef<((msg: { t: number; buffer: Float32Array }) => void) | null>(null);

  // ── Timeline Engine (main-thread pattern detector) ─────────────────────
  const timelineEngineRef = useRef<TimelineEngine | null>(null);
  const timelineEventsRef = useRef<StutterCandidate[]>([]);

  // ── Session clock (SINGLE shared timeline — see lib/sessionClock.ts) ──
  // All worklet anchors, the ASR pin and stream-time reads now live in the
  // module; this hook only forwards worklet messages to it. No second
  // clock exists in the app.
  const pendingCandidatesRaw = useRef<
    { evt: StutterCandidate; rawStart: number }[]
  >([]);
  const candidatesRef = useRef<StutterCandidate[]>([]);

  // ── Start ──────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    try {
      // Begin the shared session clock (provisional phase — the origin is
      // pinned when Speechmatics is ready). All detectors timestamp against
      // this single timeline.
      sessionClock.start();

      // ── Microphone constraint profile (TEST A / TEST B comparison) ──
      // Browser defaults (noiseSuppression=true, autoGainControl=true)
      // attenuate sustained fricatives ("ssssslap") BEFORE they reach the
      // ASR or the DSP lane. Default = analysis profile (echo cancellation
      // stays ON for TTS/coach rejection; noise suppression + AGC OFF).
      // Select the comparison profile with ?mic=default in the URL.
      const micProfile = resolveMicProfile();
      const micConstraints = getMicConstraints(micProfile);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micConstraints,
      });
      streamRef.current = stream;

      // ── AUDIO FORMAT VERIFICATION (spec §1) ─────────────────────────
      // Log what the browser ACTUALLY applied (not what we asked for) so a
      // sample-rate/processing mismatch is visible at runtime.
      const track = stream.getAudioTracks()[0];
      const actual = track?.getSettings?.() ?? {};
      console.info(
        `[DG·AUDIO] mic profile=${micProfile} | requested=${JSON.stringify(micConstraints)} | ` +
          `actual track=${JSON.stringify({
            sampleRate: actual.sampleRate,
            channelCount: actual.channelCount,
            echoCancellation: actual.echoCancellation,
            noiseSuppression: actual.noiseSuppression,
            autoGainControl: actual.autoGainControl,
          })}`
      );

      // AudioContext at 16 kHz — but CONFIRM the real rate. If the browser
      // cannot produce 16 kHz (some devices only do 48 kHz) the context
      // silently uses its default; the PCM sent to Deepgram MUST match the
      // declared sample_rate, so the actual rate is captured and exposed
      // (useDeepgramWS declares it in the query string).
      const ctx = new AudioContext({ sampleRate: 16000 });
      ctxRef.current = ctx;
      sampleRateRef.current = ctx.sampleRate;
      console.info(
        `[DG·AUDIO] AudioContext requested=16000 actual=${ctx.sampleRate} ` +
          `(contextState=${ctx.state})`
      );

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

      // Create TimelineEngine for pattern detection
      const engine = new TimelineEngine();
      timelineEngineRef.current = engine;

      // Subscribe to engine events
      const unsub = engine.subscribe((events) => {
        timelineEventsRef.current = events;
      });

      // ── Try AudioWorklet ─────────────────────────────────────
      let workletUsed = false;
      try {
        const url = new URL(
          "/audio/telemetry-processor.worklet.js",
          window.location.origin
        );
        await ctx.audioWorklet.addModule(url.href);

        const workletNode = new AudioWorkletNode(ctx, "bolo-telemetry-processor", {
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
          } else if (msg.type === "frame" && msg.frame) {
            self.current._handleFrameMessage(msg.frame);
          }
        };

        source.connect(workletNode);
        workletNodeRef.current = workletNode;
        stutterSupportedRef.current = true;
        workletUsed = true;

        console.log("🎧 Telemetry worklet ACTIVE — physics-based frame classification on audio thread");
      } catch (workletErr) {
        console.warn(
          "AudioWorklet unavailable — falling back to ScriptProcessorNode:",
          workletErr
        );
        unsub(); // clean up engine subscription since we won't get frames
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
  const self = useRef({
    _handlePcmMessage(_msg: { t: number; buffer: Float32Array }) {},
    _handleFrameMessage(_frame: TimelineFrame) {},
  });

  self.current._handlePcmMessage = (msg: { t: number; buffer: Float32Array }) => {
    // Anchor the worklet clock — the shared session clock extrapolates its
    // smooth "now" from these anchors (single timeline, lib/sessionClock).
    sessionClock.anchor(msg.t);

    // Pin session t=0 on the FIRST PCM after the page signalled ASR-ready.
    // The module applies ONE deterministic shift to all provisional
    // timestamps; worklet time is the pinned origin everywhere after this.
    if (sessionClock.isPinPending()) {
      sessionClock.pin();
    }

    // Tap raw PCM for the recovery ring buffer (before the ASR forward)
    if (onPcmRef.current) {
      onPcmRef.current({ t: msg.t, buffer: new Float32Array(msg.buffer) });
    }

    // Forward PCM to the Speechmatics callback
    if (onAudioDataRef.current) {
      onAudioDataRef.current(new Float32Array(msg.buffer));
    }
  };

  self.current._handleFrameMessage = (frame: TimelineFrame) => {
    // Frames arrive every ~10ms — a finer anchor for the stream clock
    sessionClock.anchor(frame.t);

    // Update live frame state for UI
    setState((prev) => ({ ...prev, latestFrame: frame }));

    // Feed frame into the timeline engine for pattern detection
    const engine = timelineEngineRef.current;
    if (engine) {
      // Convert the worklet timestamp onto the SHARED session clock. The
      // module owns the worklet→session mapping (single origin); the
      // engine only ever sees session-relative time.
      const sessionT = sessionClock.toWorkletSession(frame.t);
      if (sessionT != null) {
        if (sessionT >= 0) engine.pushFrame({ ...frame, t: sessionT });
      } else {
        // Clock not pinned yet — feed raw timestamp, engine uses relative
        // offsets until the origin is known.
        engine.pushFrame(frame);
      }
    }
  };

  // ── Pin clock to ASR-ready moment ─────────────────────────────────
  // Called by the page (e.g. RecordingSession) when ws.status becomes "connected".
  const pinClock = useCallback(() => {
    sessionClock.requestPin();
  }, []);

  const setOnAudioData = useCallback(
    (cb: ((buffer: Float32Array) => void) | null) => {
      onAudioDataRef.current = cb;
    },
    []
  );

  /** Register a raw PCM tap (worklet clock) — used by the recovery ring buffer. */
  const setOnPcm = useCallback(
    (cb: ((msg: { t: number; buffer: Float32Array }) => void) | null) => {
      onPcmRef.current = cb;
    },
    []
  );

  /**
   * Shared session clock: current time on the SAME timeline Speechmatics
   * word timestamps use (worklet clock − ASR pin offset). The single
   * implementation lives in lib/sessionClock — this is just the hook's
   * stable handle for pages that need a "now" (smooth, extrapolated from
   * the latest worklet anchor).
   */
  const getStreamTime = useCallback((): number | null => {
    return sessionClock.now();
  }, []);

  /** Worklet time at session t=0 (the pinned origin), or null pre-pin. */
  const getAsrT0 = useCallback((): number | null => {
    return sessionClock.workletT0Value();
  }, []);

  const getAnalyser = useCallback(() => analyserRef.current, []);

  /** ACTUAL AudioContext sample rate (the rate of the PCM sent to ASR). */
  const getSampleRate = useCallback((): number | null => {
    return sampleRateRef.current;
  }, []);

  const getStutterCandidates = useCallback((): StutterCandidate[] => {
    return candidatesRef.current.map((c) => ({ ...c }));
  }, []);

  const getTimelineEngine = useCallback((): TimelineEngine | null => {
    return timelineEngineRef.current;
  }, []);

  const getTimelineEvents = useCallback((): StutterCandidate[] => {
    return [...timelineEventsRef.current];
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

    // Reset the timeline engine
    if (timelineEngineRef.current) {
      timelineEngineRef.current.reset();
      timelineEngineRef.current = null;
    }
    timelineEventsRef.current = [];

    streamRef.current = null;
    ctxRef.current = null;
    sampleRateRef.current = null;
    sourceRef.current = null;
    analyserRef.current = null;
    workletNodeRef.current = null;
    scriptRef.current = null;
    onAudioDataRef.current = null;
    onPcmRef.current = null;
    pendingCandidatesRaw.current = [];
    candidatesRef.current = [];
    stutterSupportedRef.current = false;

    // End the shared session clock (idle → next start() begins fresh).
    sessionClock.reset();

    setState({
      level: 0,
      isActive: false,
      stream: null,
      stutterSupported: false,
      stutterCandidates: [],
      latestFrame: null,
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
    setOnPcm,
    getStreamTime,
    getAsrT0,
    getAnalyser,
    getSampleRate,
    getStutterCandidates,
    getTimelineEngine,
    getTimelineEvents,
    pinClock,
  };
}