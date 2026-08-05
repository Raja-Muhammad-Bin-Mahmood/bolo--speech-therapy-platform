/**
 * BOLO — useSensor
 *
 * Main-thread React hook for the AudioWorklet sensor layer.
 *
 * Responsibilities:
 *   1. Request microphone permission
 *   2. Create AudioContext and start the AudioWorklet
 *   3. Receive raw frame messages and maintain live state
 *   4. Keep a rolling buffer of frames (≥30 seconds)
 *   5. Clean start/stop lifecycle
 *   6. Finalize a SensorSession on stop
 *
 * This is a PURE sensor layer — no interpretation, no classification.
 */

import { useRef, useCallback, useEffect, useState } from "react";
import type {
  SensorFrame,
  SensorSession,
  SensorState,
  SensorWorkletMessage,
} from "../lib/sensorTypes";

/** How many frames to keep in the rolling buffer (30s @ 100fps). */
const MAX_BUFFER_FRAMES = 4000; // slightly more than 30s for safety margin

const INITIAL_STATE: SensorState = {
  currentRms: 0,
  currentZcr: 0,
  currentDeltaEnergy: 0,
  isRecording: false,
  isReady: false,
  latestTimestamp: 0,
  frameBuffer: [],
  totalFrames: 0,
};

export function useSensor() {
  const [state, setState] = useState<SensorState>(INITIAL_STATE);

  // ── Refs for audio resources ───────────────────────────────────────────
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);

  // ── Refs for accumulated data ──────────────────────────────────────────
  const bufferRef = useRef<SensorFrame[]>([]);
  const totalFramesRef = useRef(0);
  const recordingRef = useRef(false);
  const startedAtRef = useRef(0);

  // ── Ref for live state (avoids stale closures in message handler) ──────
  const liveStateRef = useRef({
    currentRms: 0,
    currentZcr: 0,
    currentDeltaEnergy: 0,
    latestTimestamp: 0,
  });

  // ── Start recording ────────────────────────────────────────────────────
  const start = useCallback(async () => {
    if (recordingRef.current) return;

    try {
      // 1. Request microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 2. Create AudioContext at 16 kHz
      const ctx = new AudioContext({ sampleRate: 16000 });
      ctxRef.current = ctx;

      // Resume (context may be suspended after async gap)
      try {
        await ctx.resume();
      } catch {
        // non-critical
      }

      // 3. Create source from mic stream
      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // 4. Load and connect the AudioWorklet
      const url = new URL(
        "/audio/sensor-processor.worklet.js",
        window.location.origin
      );
      await ctx.audioWorklet.addModule(url.href);

      const workletNode = new AudioWorkletNode(ctx, "bolo-sensor-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit",
      });

      // 5. Set up message handler for incoming frames
      workletNode.port.onmessage = (ev: MessageEvent<SensorWorkletMessage>) => {
        const msg = ev.data;
        if (!msg || msg.type !== "frame" || !msg.frame) return;

        const f = msg.frame;
        const frame: SensorFrame = {
          timestamp: f.t,
          rms: f.rms,
          zcr: f.zcr,
          deltaEnergy: f.deltaEnergy,
          sampleCount: f.sampleCount,
        };

        // Update live state ref (no React re-render for every frame at 100fps)
        liveStateRef.current = {
          currentRms: f.rms,
          currentZcr: f.zcr,
          currentDeltaEnergy: f.deltaEnergy,
          latestTimestamp: f.t,
        };

        // Accumulate buffer
        bufferRef.current.push(frame);
        totalFramesRef.current++;

        // Prune buffer beyond max
        if (bufferRef.current.length > MAX_BUFFER_FRAMES) {
          bufferRef.current = bufferRef.current.slice(
            bufferRef.current.length - MAX_BUFFER_FRAMES
          );
        }

        // Throttled React state update (every ~4 frames at 100fps = ~25 updates/s)
        // This avoids flooding the main thread with re-renders.
        if (totalFramesRef.current % 4 === 0) {
          setState((prev) => ({
            ...prev,
            currentRms: f.rms,
            currentZcr: f.zcr,
            currentDeltaEnergy: f.deltaEnergy,
            latestTimestamp: f.t,
            totalFrames: totalFramesRef.current,
            frameBuffer: [
              ...bufferRef.current.slice(-MAX_BUFFER_FRAMES),
            ],
          }));
        }
      };

      source.connect(workletNode);
      workletNodeRef.current = workletNode;

      // 6. Mark as ready and recording
      recordingRef.current = true;
      startedAtRef.current = Date.now();

      setState({
        currentRms: 0,
        currentZcr: 0,
        currentDeltaEnergy: 0,
        isRecording: true,
        isReady: true,
        latestTimestamp: 0,
        frameBuffer: [],
        totalFrames: 0,
      });

      console.log("📡 BOLO sensor layer ACTIVE — raw audio physics online");
    } catch (err) {
      console.warn("🎤 Mic access denied or audio init failed:", err);
      recordingRef.current = false;
      setState((prev) => ({ ...prev, isRecording: false, isReady: false }));
    }
  }, []);

  // ── Stop recording — IMMEDIATELY halts everything ──────────────────────
  const stop = useCallback((): SensorSession => {
    // 1. Disconnect and tear down audio resources
    workletNodeRef.current?.disconnect();
    sourceRef.current?.disconnect();
    ctxRef.current?.close();

    // 2. Stop all mic tracks
    streamRef.current?.getTracks().forEach((t) => t.stop());

    // 3. Capture the final buffer before clearing refs
    const finalBuffer = [...bufferRef.current];
    const endedAt = Date.now();
    const startedAt = startedAtRef.current;

    // 4. Build the finalized session
    const session: SensorSession = {
      sessionId: `sensor-${startedAt}`,
      startedAt,
      endedAt,
      totalDuration: finalBuffer.length > 0
        ? finalBuffer[finalBuffer.length - 1].timestamp
        : 0,
      frames: finalBuffer,
    };

    // 5. Clear all refs
    streamRef.current = null;
    ctxRef.current = null;
    sourceRef.current = null;
    workletNodeRef.current = null;
    bufferRef.current = [];
    totalFramesRef.current = 0;
    recordingRef.current = false;
    startedAtRef.current = 0;

    liveStateRef.current = {
      currentRms: 0,
      currentZcr: 0,
      currentDeltaEnergy: 0,
      latestTimestamp: 0,
    };

    // 6. Freeze state — transition from live to finalized
    setState({
      currentRms: 0,
      currentZcr: 0,
      currentDeltaEnergy: 0,
      isRecording: false,
      isReady: false,
      latestTimestamp: 0,
      frameBuffer: [],
      totalFrames: 0,
    });

    console.log(
      `📡 BOLO sensor layer STOPPED — ${finalBuffer.length} frames captured over ${session.totalDuration.toFixed(1)}s`
    );

    return session;
  }, []);

  // ── Cleanup on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        workletNodeRef.current?.disconnect();
        sourceRef.current?.disconnect();
        ctxRef.current?.close();
        streamRef.current?.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return {
    // Live state (updates ~25 times/second)
    ...state,
    // Actions
    start,
    stop,
    // Ref for synchronous access to latest values (no re-render)
    getSnapshot: useCallback(
      () => ({ ...liveStateRef.current }),
      []
    ),
  };
}