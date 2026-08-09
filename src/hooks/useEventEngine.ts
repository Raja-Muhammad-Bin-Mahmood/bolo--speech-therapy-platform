/**
 * BOLO — useEventEngine: Event-Centric Stutter Recovery & Word Stitching
 *
 * Replaces the old fire-and-forget recovery hook with the mission's
 * event-centric pipeline (shared by Script, Free Speech and Closer):
 *
 *   • EVERY suspicious acoustic pattern becomes an OPEN event immediately —
 *     we never wait for the sentence to finish.
 *   • Speechmatics words feed the engine continuously: the FIRST word whose
 *     window fits the event anchors it (Case A / Case C) and resolves it
 *     instantly (fast path — no fallback needed).
 *   • If no anchor arrives within the 1s hold window, a DYNAMIC snippet is
 *     sliced from the 5s ring buffer and sent to the Web Worker fallback
 *     (Case B) with snippet consensus before anything is accepted.
 *   • Timestamp anchoring locks recovered-word windows; a Speechmatics word
 *     that later lands inside a locked window is silently deduped.
 *   • Events in OPEN/WAITING surface as `pending` → the UI shows a pulsing
 *     loading indicator at the cursor while BOLO is analyzing the struggle.
 *
 * The four responsibilities stay separated: detection (existing hooks),
 * Speechmatics (existing WS hook), fallback (worker), fusion (this engine).
 * Evidence scoring for the transcript tags is unchanged (evidenceFusion).
 */
import { useRef, useCallback, useEffect, useState } from "react";
import type { AcousticEvent, AcousticEventType } from "./useAcousticAnalysis";
import type { TranscriptChunk } from "./useSpeechmaticsWS";
import type { RecoveredAnnotation } from "../lib/recoveryTypes";
import { bandFromConfidence } from "../lib/recoveryTypes";
import {
  type SpeechEvent,
  EVENT_SPEC,
  wordKeyOf,
  eventInWordWindow,
  timingOverlap,
  weightedConfidence,
  verifyThreeWay,
  renderStatusFor,
  createOpenEvent,
  normalizeWord,
} from "../lib/speechEvents";
import { recognizeInWorker } from "../lib/fallbackAsr";
import { FEED_LABELS } from "../lib/feedEvents";
import { diag } from "../lib/diagnosticLog";
import {
  evaluateInterruptionGate,
  findPrevWordEnd,
  countSpannedWords,
} from "../lib/interruptionGate";

// ─── Public types ───────────────────────────────────────────────────────

export interface PendingSpeechEvent {
  id: string;
  /** raw detector type (stutter / stammer / block / …) */
  type: string;
  startTime: number;
  endTime: number | null;
}

export interface EventEngineOptions {
  /** Whether the engine processes events (recording active). */
  active: boolean;
  /** Shared session clock (unused internally — kept for API parity). */
  getStreamTime: () => number | null;
  /** Register/unregister the raw PCM tap (worklet clock). */
  setOnPcm: (
    cb: ((msg: { t: number; buffer: Float32Array }) => void) | null
  ) => void;
  /** Finalized Speechmatics transcripts (read live for word anchoring). */
  transcripts: TranscriptChunk[];
  /** Live acoustic detector events (the OPEN-event trigger). */
  events: AcousticEvent[];
  /**
   * Optional script anchor (Script Mode): the script token the speaker is
   * currently on. Used as Case B lexical evidence when Speechmatics misses
   * the word (script-consistency consensus rule).
   */
  scriptWord?: string | null;
}

export interface EventEngineOutput {
  /** Case B recovered annotations (lexical word + badge), for renderers. */
  annotations: RecoveredAnnotation[];
  /** OPEN/WAITING events — render a pulsing "analyzing" indicator. */
  pending: PendingSpeechEvent[];
  /** Speechmatics word keys to hide (deduped against recovered words). */
  duplicateKeys: Set<string>;
  fallbackState: "idle" | "loading" | "running";
  /** Full event lifecycle (for logs / debugging / review). */
  events: SpeechEvent[];
  reset: () => void;
}

// ─── Constants ──────────────────────────────────────────────────────────

const SAMPLE_RATE = 16000;
const RING_SECONDS = 5; // spec: 3–5s live ring buffer
const RING_SAMPLES = RING_SECONDS * SAMPLE_RATE;
const POLL_MS = 150;
/** Local fallback acceptance bands (never trust a single weak result). */
const STRONG_LOCAL = 0.75;
const MED_LOCAL = 0.6;
const STRONG_DSP = 0.65;

interface PcmChunk {
  /** worklet clock (same timeline Speechmatics consumes) */
  t: number;
  buffer: Float32Array;
}

export function useEventEngine(options: EventEngineOptions): EventEngineOutput {
  const { active, setOnPcm, transcripts, events, scriptWord } = options;

  // ── React state (mirrors refs — only changed when something real moves) ──
  const [annotations, setAnnotations] = useState<RecoveredAnnotation[]>([]);
  const [pending, setPending] = useState<PendingSpeechEvent[]>([]);
  const [duplicateKeys, setDuplicateKeys] = useState<Set<string>>(
    () => new Set()
  );
  const [fallbackState, setFallbackState] = useState<
    "idle" | "loading" | "running"
  >("idle");

  // ── Engine refs (mutable, hot-loop safe) ──────────────────────────────
  const eventMapRef = useRef<Map<string, SpeechEvent>>(new Map());
  const seenEventsRef = useRef<Set<string>>(new Set());
  const seenWordsRef = useRef<Set<string>>(new Set());
  const lockedWindowsRef = useRef<{ start: number; end: number }[]>([]);
  const duplicateKeysRef = useRef<Set<string>>(new Set());
  const annotationsRef = useRef<RecoveredAnnotation[]>([]);
  const fallbackResultsRef = useRef<
    Map<string, { attempt: number; word: string; confidence: number }>
  >(new Map());
  const awaitingFallbackRef = useRef<Set<string>>(new Set());

  const ringRef = useRef<PcmChunk[]>([]);
  const ringStartTRef = useRef<number | null>(null);

  // Live props → refs (so the poll loop never re-binds)
  const transcriptsRef = useRef(transcripts);
  transcriptsRef.current = transcripts;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const scriptWordRef = useRef(scriptWord ?? null);
  scriptWordRef.current = scriptWord ?? null;
  const setOnPcmRef = useRef(setOnPcm);
  setOnPcmRef.current = setOnPcm;

  // ── Logging (spec: every event + every recovery attempt is logged) ─────
  const log = useCallback((evt: SpeechEvent, msg: string) => {
    evt.reasonLog.push(msg);
    if (evt.reasonLog.length > 20) evt.reasonLog.shift();
    console.debug(
      `[BOLO·event] ${evt.rawType}@${evt.startTime.toFixed(2)}s → ${msg}`
    );
  }, []);

  const pushAnnotation = useCallback((rec: RecoveredAnnotation) => {
    annotationsRef.current = [...annotationsRef.current, rec];
    setAnnotations(annotationsRef.current);
  }, []);

  // ── Collect finalized Speechmatics words (live, deduped) ───────────────
  const currentWords = useCallback(() => {
    const out: {
      text: string;
      startTime: number;
      endTime: number;
      confidence: number;
    }[] = [];
    const seen = new Set<string>();
    for (const chunk of transcriptsRef.current) {
      if (!chunk.isFinal) continue;
      for (const w of chunk.words) {
        const text = (w as any).text || w.word || "";
        if (!text) continue;
        const key = `${Math.round(w.startTime * 1000)}-${Math.round(w.endTime * 1000)}-${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          text,
          startTime: w.startTime,
          endTime: w.endTime,
          confidence: (w as any).confidence ?? 0.9,
        });
      }
    }
    return out;
  }, []);

  // ── Ingest new DSP events → OPEN tickets immediately ──────────────────
  const ingestEvents = useCallback(() => {
    const now = performance.now();
    const words = currentWords();
    for (const evt of eventsRef.current) {
      const key = `${evt.type}-${evt.startTime.toFixed(3)}`;
      if (seenEventsRef.current.has(key)) continue;
      seenEventsRef.current.add(key);

      // STAGE 1 — Interruption Gate. Before a DSP candidate may be
      // classified as a stutter (and consume the hold window + fallback
      // ASR), the speech FLOW must show an interruption: a micro-pause
      // before the labeled word (≥ 100 ms — the "reasonable delay between
      // the two words"), a repeated onset, a sustained segment, or an
      // onset block. Fluent function words ("could", "travel", "think")
      // carry none of these — the candidate is discarded immediately and
      // never becomes an OPEN ticket. The internal micro-pause is a
      // validation signal only — never shown in the feed or transcript.
      const prevWordEnd = findPrevWordEnd(words, evt.startTime);
      const gate = evaluateInterruptionGate({
        type: evt.type,
        startTime: evt.startTime,
        endTime: evt.endTime,
        durationMs: evt.durationMs,
        prevWordEnd,
        wordStart: null,
        overlappingWords: countSpannedWords(words, evt.startTime, evt.endTime),
        voicedRunCount: evt.voicedRepetition?.runCount,
        voicedSimilarity: evt.voicedSimilarity,
      });
      if (!gate.passed) {
        console.debug(
          `[BOLO·event] gate: ${evt.type}@${evt.startTime.toFixed(2)}s rejected — ${gate.rejectionReason}`
        );
        diag("gate", {
          type: evt.type,
          startTime: +evt.startTime.toFixed(3),
          endTime: evt.endTime != null ? +evt.endTime.toFixed(3) : null,
          durationMs: evt.durationMs,
          confidence: +evt.confidence.toFixed(3),
          passed: false,
          rejectionReason: gate.rejectionReason,
          prevWordEnd: prevWordEnd != null ? +prevWordEnd.toFixed(3) : null,
        });
        continue;
      }

      const se = createOpenEvent(evt);
      se.holdDeadlineMs = now + EVENT_SPEC.HOLD_MS;
      se.createdAtMs = now;
      eventMapRef.current.set(se.id, se);
      diag("gate", {
        type: evt.type,
        startTime: +evt.startTime.toFixed(3),
        endTime: evt.endTime != null ? +evt.endTime.toFixed(3) : null,
        durationMs: evt.durationMs,
        confidence: +evt.confidence.toFixed(3),
        passed: true,
        signals: gate.signals,
      });
      log(
        se,
        `OPEN — DSP candidate (conf ${(evt.confidence * 100) | 0}%, ${evt.durationMs}ms) · gate: ${gate.signals.join("; ")}`
      );
    }
  }, [currentWords, log]);

  // ── Ingest new Speechmatics words → anchor + dedupe ───────────────────
  const attachWords = useCallback(() => {
    for (const w of currentWords()) {
      const wKey = `${wordKeyOf(w)}-${w.text}`;
      if (seenWordsRef.current.has(wKey)) continue;
      seenWordsRef.current.add(wKey);

      // Timestamp anchoring: a word inside a locked recovery window is a
      // duplicate — silently discard it (never two tokens for one word).
      const locked = lockedWindowsRef.current.some(
        (l) =>
          w.startTime >= l.start - EVENT_SPEC.TOLERANCE_S &&
          w.startTime <= l.end + EVENT_SPEC.TOLERANCE_S
      );
      if (locked) {
        duplicateKeysRef.current.add(wordKeyOf(w));
        setDuplicateKeys(new Set(duplicateKeysRef.current));
        console.debug(
          `[BOLO·event] dedupe: Speechmatics "${w.text}" @${w.startTime.toFixed(2)}s hidden (already recovered locally)`
        );
        continue;
      }

      // FIRST OPEN/WAITING event whose window fits owns the word (no drift).
      const open = [...eventMapRef.current.values()]
        .filter(
          (e) =>
            (e.state === "OPEN" || e.state === "WAITING") &&
            !e.speechmaticsWord
        )
        .sort((a, b) => a.startTime - b.startTime);

      for (const evt of open) {
        if (!eventInWordWindow(evt, w)) continue;
        const ver = verifyThreeWay({
          acousticType: evt.acousticType,
          acousticConfidence: evt.acousticConfidence,
          smWord: w.text,
          smConfidence: w.confidence,
          localWord: evt.localWord,
          localConfidence: evt.localConfidence,
          timingOverlap: timingOverlap(evt, w),
          scriptWord: scriptWordRef.current,
        });
        evt.speechmaticsWord = w.text;
        evt.speechmaticsConfidence = w.confidence;
        evt.decision = ver.case;

        if (ver.case === "case_a" || ver.case === "case_c") {
          // Fast path — the transcript tag layer colors the word; the engine
          // just resolves the lifecycle (no fallback, no duplicate token).
          const score = weightedConfidence({
            acousticConfidence: evt.acousticConfidence,
            durationMs: evt.durationMs,
            timingOverlap: timingOverlap(evt, w),
            smConfidence: w.confidence,
            smAgree: true,
            recoveryQuality: 0.7,
          });
          evt.renderStatus = renderStatusFor(score, true);
          evt.state = "RESOLVED";
          log(
            evt,
            `word anchored → "${w.text}" (SM ${(w.confidence * 100) | 0}%) → ${evt.renderStatus}`
          );
        } else {
          evt.renderStatus = "feed-only";
          evt.state = "SUPPRESSED";
          log(evt, `${ver.reason} → feed-only`);
        }
        break; // one word owns this event
      }
    }
  }, [currentWords, log]);

  // ── Resolve helpers ───────────────────────────────────────────────────

  const suppressEvent = useCallback(
    (evt: SpeechEvent, why: string) => {
      evt.state = "SUPPRESSED";
      evt.renderStatus =
        evt.acousticConfidence >= EVENT_SPEC.MEDIUM_CONF
          ? "feed-only"
          : "internal-only";
      log(evt, `SUPPRESSED — ${why}`);
    },
    [log]
  );

  /** Accept a recovered lexical word (Case B) and lock its timestamp window. */
  const acceptRecovered = useCallback(
    (evt: SpeechEvent, word: string, conf: number, why: string) => {
      const ver = verifyThreeWay({
        acousticType: evt.acousticType,
        acousticConfidence: evt.acousticConfidence,
        smWord: evt.speechmaticsWord,
        smConfidence: evt.speechmaticsConfidence,
        localWord: word,
        localConfidence: conf,
        timingOverlap: 1,
        scriptWord: scriptWordRef.current,
      });
      const scriptAgree =
        !!scriptWordRef.current &&
        normalizeWord(scriptWordRef.current) === normalizeWord(word);
      const score = weightedConfidence({
        acousticConfidence: evt.acousticConfidence,
        durationMs: evt.durationMs,
        timingOverlap: 1,
        localConfidence: conf,
        localAgree: true,
        smConfidence: evt.speechmaticsConfidence,
        smAgree: ver.case === "case_a",
        scriptAgree,
        recoveryQuality: 1,
      });
      evt.localWord = word;
      evt.localConfidence = conf;
      evt.decision = "case_b";
      evt.renderStatus = renderStatusFor(score, true);

      // Timestamp anchor: lock [event.start − 300ms, event.end + 400ms] so a
      // later Speechmatics word in this window is deduped, never duplicated.
      const eEnd = evt.endTime ?? evt.startTime;
      const lock = {
        start: Math.max(0, evt.startTime - EVENT_SPEC.PREROLL_S),
        end: eEnd + EVENT_SPEC.POSTROLL_S,
      };
      evt.lockedWindow = lock;
      lockedWindowsRef.current.push(lock);
      evt.state = "RESOLVED";
      log(
        evt,
        `RESOLVED via local fallback → "${word}" (${(conf * 100) | 0}%) → ${evt.renderStatus} (${why})`
      );

      const label =
        FEED_LABELS[evt.rawType as AcousticEventType] ?? evt.rawType;
      const rec: RecoveredAnnotation = {
        id: `rec-${evt.rawType}-${evt.startTime.toFixed(3)}`,
        status: "recovered",
        type: evt.rawType as AcousticEventType,
        startTime: evt.startTime,
        endTime: eEnd,
        durationMs: evt.durationMs,
        confidence: score,
        band: bandFromConfidence(score),
        source: "fallback",
        recoveredText: word,
        label,
        reason: `recovered locally: "${word}" (${(conf * 100) | 0}%) — ${why}`,
      };
      pushAnnotation(rec);
    },
    [log, pushAnnotation]
  );

  // ── Dynamic snippet slicing + worker fallback (Case B) ────────────────

  const retryFallbackShifted = useCallback(
    (evt: SpeechEvent, attempt: number) => {
      const clip = cropClip(evt, ringRef.current, 0.3);
      if (!clip) {
        suppressEvent(evt, "second clip unavailable — kept feed-only");
        return;
      }
      log(
        evt,
        `consensus attempt ${attempt + 1} — overlapping snippet (${(clip.length / SAMPLE_RATE).toFixed(2)}s)`
      );
      awaitingFallbackRef.current.add(evt.id);
      setFallbackState("running");
      void recognizeInWorker(clip).then((res) => {
        awaitingFallbackRef.current.delete(evt.id);
        setFallbackState(awaitingFallbackRef.current.size > 0 ? "running" : "idle");
        const prevRes = fallbackResultsRef.current.get(evt.id);
        const consensus =
          !!prevRes &&
          res.text.length > 0 &&
          normalizeWord(prevRes.word) === normalizeWord(res.text);
        if (consensus && res.confidence >= MED_LOCAL) {
          acceptRecovered(
            evt,
            prevRes!.word,
            Math.min(1, res.confidence + 0.06),
            "two overlapping snippets agree"
          );
        } else if (
          res.text.length > 0 &&
          res.confidence >= STRONG_LOCAL &&
          evt.acousticConfidence >= STRONG_DSP
        ) {
          acceptRecovered(evt, res.text, res.confidence, "strong single clip + DSP");
        } else {
          suppressEvent(evt, "no snippet consensus — kept feed-only");
        }
      });
    },
    [acceptRecovered, suppressEvent, log]
  );

  const beginFallback = useCallback(
    (evt: SpeechEvent) => {
      const clip = cropClip(evt, ringRef.current, 0);
      if (!clip) {
        suppressEvent(evt, "clip unavailable — kept internal");
        return;
      }
      const prev = fallbackResultsRef.current.get(evt.id);
      const attempt = (prev?.attempt ?? 0) + 1;
      evt.state = "WAITING";
      evt.snippet = {
        start: Math.max(0, evt.startTime - EVENT_SPEC.PREROLL_S),
        end: (evt.endTime ?? evt.startTime) + EVENT_SPEC.POSTROLL_S,
      };
      awaitingFallbackRef.current.add(evt.id);
      setFallbackState("running");
      log(
        evt,
        `no SM word after hold — local fallback attempt ${attempt} (clip ${(clip.length / SAMPLE_RATE).toFixed(2)}s)`
      );

      void recognizeInWorker(clip).then((res) => {
        awaitingFallbackRef.current.delete(evt.id);
        setFallbackState(awaitingFallbackRef.current.size > 0 ? "running" : "idle");

        if (!res.text || res.confidence <= 0) {
          // Script-mode anchor: the script word + strong DSP is real evidence.
          if (
            attempt >= 2 &&
            scriptWordRef.current &&
            evt.acousticConfidence >= STRONG_DSP
          ) {
            acceptRecovered(
              evt,
              scriptWordRef.current,
              0.7,
              "script-consistent anchor (Speechmatics missed the word)"
            );
            return;
          }
          if (attempt < 2) {
            retryFallbackShifted(evt, attempt);
          } else {
            suppressEvent(evt, `fallback returned nothing (attempt ${attempt})`);
          }
          return;
        }

        const prevRes = fallbackResultsRef.current.get(evt.id);
        const consensus =
          !!prevRes && normalizeWord(prevRes.word) === normalizeWord(res.text);
        const dspStrong = evt.acousticConfidence >= STRONG_DSP;
        const scriptAgree =
          !!scriptWordRef.current &&
          normalizeWord(scriptWordRef.current) === normalizeWord(res.text);
        const strong = res.confidence >= STRONG_LOCAL;
        const medium = res.confidence >= MED_LOCAL;

        if (
          (strong && dspStrong) ||
          (strong && scriptAgree) ||
          (medium && consensus)
        ) {
          acceptRecovered(
            evt,
            res.text,
            Math.min(1, res.confidence + (consensus || scriptAgree ? 0.05 : 0)),
            "strong fallback + DSP/script/consensus"
          );
        } else if (attempt < 2) {
          fallbackResultsRef.current.set(evt.id, {
            attempt,
            word: res.text,
            confidence: res.confidence,
          });
          retryFallbackShifted(evt, attempt);
        } else {
          suppressEvent(
            evt,
            `fallback below acceptance after 2 attempts (${(res.confidence * 100) | 0}%)`
          );
        }
      });
    },
    [acceptRecovered, suppressEvent, retryFallbackShifted, log]
  );

  // ── Hold expiry + stale-event sweep ────────────────────────────────────
  const sweep = useCallback(() => {
    const now = performance.now();
    for (const evt of [...eventMapRef.current.values()]) {
      if (evt.state === "RESOLVED" || evt.state === "SUPPRESSED") continue;
      const awaiting = awaitingFallbackRef.current.has(evt.id);

      // Safety net: never leave an event open forever.
      if (
        !awaiting &&
        evt.createdAtMs != null &&
        now - evt.createdAtMs > EVENT_SPEC.MAX_AGE_S * 1000
      ) {
        suppressEvent(evt, "max age exceeded without resolution");
        continue;
      }
      if (
        evt.state === "OPEN" &&
        evt.holdDeadlineMs != null &&
        now >= evt.holdDeadlineMs &&
        !awaiting
      ) {
        beginFallback(evt);
      }
    }
  }, [beginFallback, suppressEvent]);

  // ── Pending list for the UI loading indicator ──────────────────────────
  const recomputePending = useCallback(() => {
    const list: PendingSpeechEvent[] = [...eventMapRef.current.values()]
      .filter((e) => e.state === "OPEN" || e.state === "WAITING")
      .sort((a, b) => a.startTime - b.startTime)
      .map((e) => ({
        id: e.id,
        type: e.rawType,
        startTime: e.startTime,
        endTime: e.endTime,
      }));
    setPending((prev) => {
      if (
        prev.length === list.length &&
        prev.every((p, i) => p.id === list[i].id)
      ) {
        return prev;
      }
      return list;
    });
  }, []);

  // ── Poll loop (the event-centric heart) ────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const process = () => {
      ingestEvents();
      attachWords();
      sweep();
      recomputePending();
    };
    process();
    const iv = setInterval(process, POLL_MS);
    return () => clearInterval(iv);
  }, [active, ingestEvents, attachWords, sweep, recomputePending]);

  // ── Raw PCM → 5s ring buffer (worklet clock) ───────────────────────────
  useEffect(() => {
    if (!active) return;
    const onPcm = (msg: { t: number; buffer: Float32Array }) => {
      const ring = ringRef.current;
      if (ring.length > 0) ringStartTRef.current = ring[0].t;
      ring.push({ t: msg.t, buffer: msg.buffer });
      let totalSamples = ring.reduce((s, c) => s + c.buffer.length, 0);
      while (totalSamples > RING_SAMPLES && ring.length > 1) {
        const first = ring.shift()!;
        totalSamples -= first.buffer.length;
      }
      if (ring.length > 0) ringStartTRef.current = ring[0].t;
    };
    setOnPcmRef.current(onPcm);
    return () => setOnPcmRef.current(null);
  }, [active]);

  // ── Reset on stop ──────────────────────────────────────────────────────
  const clearAll = useCallback(() => {
    eventMapRef.current.clear();
    seenEventsRef.current.clear();
    seenWordsRef.current.clear();
    lockedWindowsRef.current = [];
    duplicateKeysRef.current = new Set();
    fallbackResultsRef.current.clear();
    awaitingFallbackRef.current.clear();
    annotationsRef.current = [];
    ringRef.current = [];
    ringStartTRef.current = null;
    setAnnotations([]);
    setPending([]);
    setDuplicateKeys(new Set());
    setFallbackState("idle");
  }, []);

  useEffect(() => {
    if (!active) clearAll();
  }, [active, clearAll]);

  const reset = useCallback(() => {
    clearAll();
  }, [clearAll]);

  const lifecycle: SpeechEvent[] = [...eventMapRef.current.values()].sort(
    (a, b) => a.startTime - b.startTime
  );

  return {
    annotations,
    pending,
    duplicateKeys,
    fallbackState,
    events: lifecycle,
    reset,
  };
}

// ─── Dynamic snippet slicing ─────────────────────────────────────────────

/**
 * Crop the suspicious region from the ring buffer with DYNAMIC boundaries
 * (spec): 300ms pre-roll, ≥800ms minimum context, ~2s preferred, 6s hard cap.
 * A shifted second window (shiftS) is used for snippet consensus.
 * Ring timestamps are worklet-clock; the event is on the session clock, so
 * we anchor with the worklet offset of the newest chunk (the fallback runs
 * within ~1.5s of the event, so the drift is negligible).
 */
function cropClip(
  evt: SpeechEvent,
  ring: PcmChunk[],
  shiftS: number
): Float32Array | null {
  if (ring.length === 0) return null;
  const newestT = ring[ring.length - 1].t;
  const chunkDur = ring[ring.length - 1].buffer.length / SAMPLE_RATE;
  const newestEnd = newestT + chunkDur;
  const eEnd = evt.endTime ?? evt.startTime + 0.5;
  const offset = newestEnd - eEnd; // worklet-clock estimate of event end

  let start = evt.startTime - EVENT_SPEC.PREROLL_S + shiftS - offset;
  let end = eEnd + EVENT_SPEC.POSTROLL_S + shiftS - offset;
  if (end - start < EVENT_SPEC.MIN_CLIP_S) end = start + EVENT_SPEC.MIN_CLIP_S;
  if (end - start > EVENT_SPEC.PREF_CLIP_S) end = start + EVENT_SPEC.PREF_CLIP_S;
  if (end - start > EVENT_SPEC.MAX_CLIP_S) end = start + EVENT_SPEC.MAX_CLIP_S;
  start = Math.max(0, start);
  if (end <= start) return null;

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
