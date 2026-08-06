/**
 * BOLO — useStutterRecovery: Event-Triggered Recovery Engine
 *
 * The 3-stage pipeline (spec):
 *   Stage 1 — Speechmatics: source of finalized words + timestamps.
 *   Stage 2 — Local acoustic detector: flags stutter events (NOT modified).
 *   Stage 3 — Event-triggered recovery buffer:
 *       detector flags a candidate → 1.0s HOLD window
 *       → if Speechmatics finalizes a matching word (±200ms) attach to it
 *       → if not, crop the suspicious region from the live ring buffer
 *         and run the local Wav2Vec2 fragment recognizer (ON-DEMAND only,
 *         never continuously)
 *       → confident → recovered text; else conservative placeholder
 *
 * ONE shared stream clock: all timestamps (detector, Speechmatics, buffer,
 * annotations) live on the same session timeline via audio.getStreamTime().
 * Detection logic is untouched — this layer only recovers + annotates.
 */
import { useRef, useEffect, useState, useCallback } from "react";
import type { AcousticEvent } from "./useAcousticAnalysis";
import type { TranscriptChunk } from "./useSpeechmaticsWS";
import {
  bandFromConfidence,
  buildStutterPrefix,
  placeholderFor,
  HOLD_MS,
  MAX_FALLBACK_CLIP_S,
  POSTROLL_S,
  PREROLL_S,
  type RecoveredAnnotation,
} from "../lib/recoveryTypes";
import { recognizeClip } from "../lib/localRecognizer";

export interface RecoveryOptions {
  /** Whether the engine should process events (recording active). */
  active: boolean;
  /** Shared session clock — same timeline as Speechmatics words. */
  getStreamTime: () => number | null;
  /** Register/unregister a raw PCM tap (worklet clock). */
  setOnPcm: (
    cb: ((msg: { t: number; buffer: Float32Array }) => void) | null
  ) => void;
  /** Finalized Speechmatics transcripts (read live for hold resolution). */
  transcripts: TranscriptChunk[];
  /** Live acoustic detector events (the recovery trigger). */
  events: AcousticEvent[];
}

const SAMPLE_RATE = 16000;
/** 5s review ring buffer (spec). */
const RING_SECONDS = 5;
const RING_SAMPLES = RING_SECONDS * SAMPLE_RATE;

interface PcmChunk {
  /** worklet clock (start of chunk) — same timeline Speechmatics consumes */
  t: number;
  buffer: Float32Array;
}

interface PendingHold {
  evt: AcousticEvent;
  holdUntilMs: number; // performance.now() deadline
  startedAt: number; // stream time of the event
  timer: ReturnType<typeof setTimeout> | null;
}

export function useStutterRecovery({
  active,
  getStreamTime,
  setOnPcm,
  transcripts,
  events,
}: RecoveryOptions) {
  const [annotations, setAnnotations] = useState<RecoveredAnnotation[]>([]);
  const [fallbackState, setFallbackState] = useState<
    "idle" | "loading" | "running"
  >("idle");

  const ringRef = useRef<PcmChunk[]>([]);
  const ringStartTRef = useRef<number | null>(null); // worklet t of ring[0]
  const holdsRef = useRef<PendingHold[]>([]);
  const processedRef = useRef<Set<string>>(new Set());
  const annotationsRef = useRef<RecoveredAnnotation[]>([]);
  const busyRef = useRef(false);
  const getStreamTimeRef = useRef(getStreamTime);
  getStreamTimeRef.current = getStreamTime;
  const transcriptsRef = useRef(transcripts);
  transcriptsRef.current = transcripts;
  const eventsRef = useRef(events);
  eventsRef.current = events;

  const pushAnnotation = useCallback((rec: RecoveredAnnotation) => {
    annotationsRef.current = [...annotationsRef.current, rec];
    setAnnotations(annotationsRef.current);
  }, []);

  /** Collect finalized Speechmatics words (live, from ref) */
  const collectFinalWords = useCallback(() => {
    const words: { text: string; startTime: number; endTime: number }[] = [];
    const seen = new Set<string>();
    for (const chunk of transcriptsRef.current) {
      if (!chunk.isFinal) continue;
      for (const w of chunk.words) {
        const text = (w as any).text || w.word || "";
        if (!text) continue;
        const key = `${Math.round(w.startTime * 1000)}-${Math.round(w.endTime * 1000)}-${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        words.push({
          text,
          startTime: w.startTime,
          endTime: w.endTime,
        });
      }
    }
    return words;
  }, []);

  const resolveHold = useCallback(
    (hold: PendingHold, words: { text: string; startTime: number; endTime: number }[]) => {
      const { evt } = hold;
      const tol = 0.2; // ±200ms
      let best: { text: string; startTime: number; endTime: number } | null = null;
      let bestScore = 0;
      for (const w of words) {
        const overlap = Math.max(
          0,
          Math.min(w.endTime, evt.endTime) - Math.max(w.startTime, evt.startTime)
        );
        const proximity = Math.abs(w.startTime - evt.startTime);
        let score = overlap;
        if (
          evt.type === "block" &&
          w.startTime >= evt.endTime - 0.05 &&
          w.startTime <= evt.endTime + tol
        ) {
          score = Math.max(score, 0.05);
        }
        if (overlap <= 0 && proximity <= tol) score = Math.max(score, 0.02);
        if (score > bestScore) {
          bestScore = score;
          best = w;
        }
      }

      if (best && bestScore >= 0.02) {
        // Speechmatics has the word — attach the annotation, keep its text.
        pushAnnotation({
          id: `rec-${evt.type}-${evt.startTime.toFixed(3)}`,
          status: "attached",
          type: evt.type,
          startTime: evt.startTime,
          endTime: evt.endTime,
          durationMs: evt.durationMs,
          confidence: evt.confidence,
          band: bandFromConfidence(evt.confidence),
          source: "speechmatics",
          baseWord: best.text,
          prefix: buildStutterPrefix(evt.type, best.text),
          reason: `${evt.type} detected · attached to "${best.text}" (Speechmatics)`,
        });
        return;
      }

      // No matching word — crop the suspicious region and run the fallback.
      void runFallbackFor(hold);
    },
    [pushAnnotation]
  );

  const runFallbackFor = useCallback(
    async (hold: PendingHold) => {
      const { evt } = hold;
      const clip = cropClip(evt, ringRef.current, ringStartTRef.current);
      if (!clip || clip.length < SAMPLE_RATE * 0.4) {
        // Not enough audio — conservative placeholder, never invent a word.
        pushAnnotation({
          id: `rec-${evt.type}-${evt.startTime.toFixed(3)}`,
          status: "unresolved",
          type: evt.type,
          startTime: evt.startTime,
          endTime: evt.endTime,
          durationMs: evt.durationMs,
          confidence: evt.confidence,
          band: bandFromConfidence(evt.confidence),
          source: "none",
          placeholder: placeholderFor(evt.type),
          reason: "no matching word & clip too short — conservative placeholder",
        });
        return;
      }

      setFallbackState((prev) => (prev === "idle" ? "loading" : prev));
      let result: { text: string; confidence: number } = { text: "", confidence: 0 };
      try {
        if (!busyRef.current) {
          busyRef.current = true;
          result = await recognizeClip(clip);
        }
      } finally {
        busyRef.current = false;
        setFallbackState("idle");
      }

      if (result.text && result.confidence >= 0.5) {
        pushAnnotation({
          id: `rec-${evt.type}-${evt.startTime.toFixed(3)}`,
          status: "recovered",
          type: evt.type,
          startTime: evt.startTime,
          endTime: evt.endTime,
          durationMs: evt.durationMs,
          confidence: result.confidence,
          band: bandFromConfidence(result.confidence),
          source: "fallback",
          recoveredText: result.text,
          prefix: buildStutterPrefix(evt.type, result.text),
          reason: `recovered locally: "${result.text}" (${(result.confidence * 100).toFixed(0)}%)`,
        });
      } else {
        pushAnnotation({
          id: `rec-${evt.type}-${evt.startTime.toFixed(3)}`,
          status: "unresolved",
          type: evt.type,
          startTime: evt.startTime,
          endTime: evt.endTime,
          durationMs: evt.durationMs,
          confidence: result.confidence || evt.confidence,
          band: bandFromConfidence(result.confidence || evt.confidence),
          source: "none",
          placeholder: placeholderFor(evt.type),
          reason:
            result.text && result.confidence < 0.5
              ? `fallback low confidence (${(result.confidence * 100).toFixed(0)}%) — placeholder`
              : "fallback returned nothing — placeholder",
        });
      }
    },
    [pushAnnotation]
  );

  // ── Raw PCM → ring buffer (5s) ──────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const onPcm = (msg: { t: number; buffer: Float32Array }) => {
      const ring = ringRef.current;
      ringStartTRef.current = ring.length > 0 ? ring[0].t : msg.t;
      ring.push({ t: msg.t, buffer: msg.buffer });
      // Prune to 5s
      let totalSamples = ring.reduce((s, c) => s + c.buffer.length, 0);
      while (totalSamples > RING_SAMPLES && ring.length > 1) {
        const first = ring.shift()!;
        totalSamples -= first.buffer.length;
      }
      if (ring.length > 0) ringStartTRef.current = ring[0].t;
    };
    setOnPcm(onPcm);
    return () => setOnPcm(null);
  }, [active, setOnPcm]);

  // ── Hold-window scheduler: new events → 1.0s hold → resolve ─────────
  useEffect(() => {
    if (!active) return;

    const processNew = () => {
      const now = performance.now();

      // Accept unseen events into the hold window (1.0s) immediately.
      const seenSet = processedRef.current;
      const accepted: PendingHold[] = [];
      for (const evt of eventsRef.current) {
        const key = evt.startTime.toFixed(3);
        if (seenSet.has(key)) continue;
        seenSet.add(key);
        const hold: PendingHold = {
          evt,
          holdUntilMs: now + HOLD_MS,
          startedAt: evt.startTime,
          timer: null,
        };
        hold.timer = setTimeout(() => {
          resolveHold(hold, collectFinalWords());
          holdsRef.current = holdsRef.current.filter((x) => x !== hold);
        }, HOLD_MS);
        accepted.push(hold);
      }
      if (accepted.length > 0) {
        holdsRef.current = [...holdsRef.current, ...accepted];
      }

      // Expire holds whose timer already fired (safety net)
      const expired = holdsRef.current.filter(
        (h) => h.timer === null && now > h.holdUntilMs
      );
      for (const h of expired) {
        resolveHold(h, collectFinalWords());
        holdsRef.current = holdsRef.current.filter((x) => x !== h);
      }
    };

    const iv = setInterval(processNew, 150);
    processNew();
    return () => clearInterval(iv);
  }, [active, resolveHold, collectFinalWords]);

  // ── Reset on stop ───────────────────────────────────────────────────
  useEffect(() => {
    if (!active) {
      holdsRef.current.forEach((h) => h.timer && clearTimeout(h.timer));
      holdsRef.current = [];
      processedRef.current.clear();
      ringRef.current = [];
      ringStartTRef.current = null;
      annotationsRef.current = [];
      setAnnotations([]);
      setFallbackState("idle");
    }
  }, [active]);

  return { annotations, fallbackState };
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Crop the suspicious region from the ring buffer.
 * All ring timestamps are worklet-clock; the event is on the session clock,
 * so we anchor with the worklet offset of the newest chunk (the fallback
 * runs within ~1.5s of the event, so the drift is negligible).
 */
function cropClip(
  evt: AcousticEvent,
  ring: PcmChunk[],
  _ringStartT: number | null
): Float32Array | null {
  if (ring.length === 0) return null;
  const newestT = ring[ring.length - 1].t;
  const chunkDur = ring[ring.length - 1].buffer.length / SAMPLE_RATE;
  const newestEnd = newestT + chunkDur;
  const offset = newestEnd - evt.endTime; // worklet-clock estimate of event end

  const start = evt.startTime - PREROLL_S - offset;
  const end = evt.endTime + POSTROLL_S - offset;
  const clipLen = end - start;
  if (clipLen <= 0 || clipLen > MAX_FALLBACK_CLIP_S) return null;
  if (clipLen < 0.4) return null;

  // Map [start, end] onto ring chunks (worklet clock)
  const samples: number[] = [];
  for (const c of ring) {
    const cStart = c.t;
    const cEnd = c.t + c.buffer.length / SAMPLE_RATE;
    if (cEnd <= start || cStart >= end) continue;
    const from = Math.max(0, Math.floor((start - cStart) * SAMPLE_RATE));
    const to = Math.min(c.buffer.length, Math.ceil((end - cStart) * SAMPLE_RATE));
    for (let i = from; i < to; i++) samples.push(c.buffer[i]);
  }
  if (samples.length < SAMPLE_RATE * 0.4) return null;
  const out = new Float32Array(samples.length);
  out.set(samples);
  return out;
}
