import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAudioCapture } from "./useAudioCapture";
import { useSpeechmaticsWS } from "./useSpeechmaticsWS";
import { useAcousticAnalysis } from "./useAcousticAnalysis";
import { useAnalyserSensor } from "./useAnalyserSensor";
import { useDeepgramWS } from "./useDeepgramWS";
import { useTranscriptReconciler } from "./useTranscriptReconciler";
import { useSessionAnalysis } from "./useSessionAnalysis";
import { useSessionDisfluencies } from "./useSessionDisfluencies";
import { useEventEngine } from "./useEventEngine";
import { usePaceEngine } from "./usePaceEngine";
import { useGeminiLive } from "./useGeminiLive";
import { pickMood, pickName, pickPersona } from "../data/closerCatalog";
import { playHangupTone } from "../lib/closerAudio";
import {
  buildCustomerSystemPrompt,
  buildReportPrompt,
  REPORT_RESPONSE_SCHEMA,
} from "../lib/closerPrompts";
import { fallbackReport, normalizeReport } from "../lib/salesReport";
import { mergeAcousticEvents } from "../lib/mergeAcousticEvents";
import { buildDgFinalChunks, mergeFinalChunks } from "../lib/finalChunks";
import { buildAnalysisPayload } from "../lib/analysisPayload";
import {
  persistSessionDisfluencies,
  type SessionDisfluencySnapshot,
} from "../lib/sessionDisfluencies";
import {
  makeMarkerId,
  persistMarkers,
  persistEvents,
  type OfficialDisfluencyEvent,
  type SessionMarker,
  type UserAccount,
} from "../lib/manualAnnotations";
import { SUPABASE_URL } from "../lib/supabase";
import { useAuth } from "../context/AuthContext";
import type { TranscriptToken } from "../lib/transcriptTokens";
import { diagBanner } from "../lib/diagnosticLog";
import type {
  CallContext,
  CallOutcome,
  CallPhase,
  LiveCallState,
  SalesReport,
  TranscriptLine,
} from "../lib/closerTypes";

/** Soft cap on a call — the model is told to wrap up before this too. */
const MAX_CALL_SECONDS = 120;

/**
 * FINAL goodbye signals — a customer line matching this (as their complete
 * turn) is treated as an unambiguous, final hang-up. Short soft phrases like
 * "I've got to go" / "I'm busy" are deliberately NOT here: per the customer
 * system prompt (§9) those are *attempts to leave* that the salesperson gets
 * a chance to recover from, so they must not hard-end the call.
 */
const FINAL_HANGUP_RE =
  /\b(goodbye|bye)\b|hanging up|hang up now|i'?m (hanging up|leaving now)|(that'?s|this is) all for me/i;

/**
 * Soft "I might leave" signals — the customer is trying to end the call but
 * the prompt guarantees the salesperson a recovery window. If they repeat
 * this intent across multiple turns (and never get a reason to stay), we
 * treat it as a real hang-up.
 */
const SOFT_HANGUP_RE =
  /(got to go|gotta go|have to go|need to leave|i'?m (going|leaving)|don'?t call me|really busy|in the middle of something|not interested|not for me|send me an email|email me)/i;

/**
 * The whole Closer Mode state machine: roulette → ringing → live call →
 * ended + report. Owns mic, Speechmatics STT (user's side) and the Gemini
 * Live customer (audio + transcriptions).
 *
 * HIDDEN FREE-SPEECH DETECTION: while the call is live, the SAME detection
 * pipeline Free Speech runs is ALSO running invisibly in the background —
 * Deepgram transcription, disfluency/stutter/filler detection, timing/audio
 * evidence, the same purple disfluency logic and the same saved
 * event/token structure. The call UI stays clean (no purple markings, no
 * detection feed, no disfluency counters). When the call ends, the
 * collected detection data produces the SAME Free Speech-style /analysis
 * experience (scores, tagged words, purple annotations, transcript,
 * manual-review workflow) — nothing was shown during the call, everything
 * is analyzed after.
 */
export function useCloserCall() {
  const mic = useAudioCapture();
  const stt = useSpeechmaticsWS();
  const live = useGeminiLive();
  const { user, isLocal, saveSessionData } = useAuth();

  // ── HIDDEN FREE-SPEECH DETECTION PIPELINE (same as Free Speech) ────────
  // Runs whenever the call is live. The UI NEVER renders any of it — the
  // data is collected silently and handed to the after-session analysis.
  const [isLive, setIsLive] = useState(false);
  const acoustic = useAcousticAnalysis(mic.getAnalyser, isLive);
  const sensor = useAnalyserSensor(mic.getAnalyser, isLive);
  const allAcoustic = mergeAcousticEvents(acoustic.events, sensor.events);
  const dg = useDeepgramWS({
    getAnalyser: mic.getAnalyser,
    getSampleRate: mic.getSampleRate,
    acousticEvents: allAcoustic,
  });
  const dgFinalChunks = buildDgFinalChunks(dg.finals);
  const mergedFinalChunks = mergeFinalChunks(dgFinalChunks, stt.transcripts);
  const analysis = useSessionAnalysis(mergedFinalChunks, allAcoustic);
  const reconciler = useTranscriptReconciler({
    active: isLive,
    transcripts: stt.transcripts,
    deepgramFinals: dg.finals,
  });
  const recovery = useEventEngine({
    active: isLive && stt.status === "connected",
    getStreamTime: mic.getStreamTime,
    setOnPcm: mic.setOnPcm,
    transcripts: stt.transcripts,
    events: allAcoustic,
  });
  const disfluencyCollector = useSessionDisfluencies(reconciler.tokens, analysis.wordTags);
  const pace = usePaceEngine();

  // ── Live call state ────────────────────────────────────────────────────
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [liveState, setLiveState] = useState<LiveCallState>("idle");
  const [context, setContext] = useState<CallContext | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [customerPartial, setCustomerPartial] = useState("");
  const [userPartial, setUserPartial] = useState("");
  const [customerSpeaking, setCustomerSpeaking] = useState(false);
  const [interruptedAt, setInterruptedAt] = useState(0);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [micMissing, setMicMissing] = useState(false);
  const [sttNote, setSttNote] = useState(false);
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [report, setReport] = useState<SalesReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  // ── Refs (escape hatch for callbacks/timers) ──────────────────────────
  const phaseRef = useRef<CallPhase>("idle");
  const liveStateRef = useRef<LiveCallState>("idle");
  const contextRef = useRef<CallContext | null>(null);
  const transcriptRef = useRef<TranscriptLine[]>([]);
  const elapsedRef = useRef(0);
  const endedRef = useRef(false);
  const customerTurnRef = useRef("");
  const seenFinalsRef = useRef<Set<object>>(new Set());
  const seenUserTranscriptRef = useRef<Set<string>>(new Set());
  const userPartialRef = useRef("");
  const micActiveRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const softHangupCountRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);

  // Hidden pipeline refs — captured at call end BEFORE the reconciler clears.
  const finalTokensRef = useRef<TranscriptToken[]>([]);
  const finalHiddenKeysRef = useRef<string[]>([]);
  const sessionIdRef = useRef<string>(`closer-${Date.now().toString(36)}`);
  const markersRef = useRef<SessionMarker[]>([]);
  const userRef = useRef<UserAccount | null>(null);
  useEffect(() => {
    if (!user) return;
    userRef.current = { id: user.id, isLocal };
  }, [user, isLocal]);

  // Keep the hidden pipeline's final token array mirrored while live.
  const mergedDuplicateKeys = useMemo(
    () => new Set([...recovery.duplicateKeys, ...reconciler.hiddenSpeechmaticsKeys]),
    [recovery.duplicateKeys, reconciler.hiddenSpeechmaticsKeys]
  );
  useEffect(() => {
    if (isLive) {
      finalTokensRef.current = reconciler.tokens;
      finalHiddenKeysRef.current = Array.from(mergedDuplicateKeys);
    }
  }, [isLive, reconciler.tokens, mergedDuplicateKeys]);

  const setPhaseBoth = useCallback((p: CallPhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const setLiveStateBoth = useCallback((s: LiveCallState) => {
    liveStateRef.current = s;
    setLiveState(s);
  }, []);

  const pushLine = useCallback((role: "user" | "customer", text: string) => {
    const line: TranscriptLine = {
      role,
      text,
      atSec: Math.round(elapsedRef.current),
    };
    transcriptRef.current = [...transcriptRef.current, line];
    setTranscript(transcriptRef.current);
  }, []);

  useEffect(() => {
    micActiveRef.current = mic.isActive;
  }, [mic.isActive]);

  // ── Speechmatics finals → user transcript lines ─────────────────────
  useEffect(() => {
    for (const chunk of stt.transcripts) {
      if (!chunk.isFinal || seenFinalsRef.current.has(chunk)) continue;
      seenFinalsRef.current.add(chunk);
      const text = chunk.text.trim();
      if (!text || phaseRef.current !== "live") continue;
      pushLine("user", text);
    }
  }, [stt.transcripts, pushLine]);

  // ── Gemini Live user transcription (final) → transcript lines ────────
  const onUserFinalTranscript = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t || phaseRef.current !== "live") return;
      if (seenUserTranscriptRef.current.has(t)) return;
      seenUserTranscriptRef.current.add(t);
      pushLine("user", t);
    },
    [pushLine]
  );

  // ── Report generation (server-side Gemini, fallback to instant stats) ─
  const generateReport = useCallback(async (reason: CallOutcome) => {
    const ctx = contextRef.current;
    if (!ctx) return;
    setReportLoading(true);
    setReportError(null);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/closer-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildReportPrompt(ctx, transcriptRef.current, elapsedRef.current, reason),
          schema: REPORT_RESPONSE_SCHEMA,
        }),
      });
      if (!res.ok) {
        let detail = `report request failed (${res.status})`;
        try {
          const body = await res.json();
          if (body?.class) detail = `${body.class}: ${body.error}`;
        } catch {
          // non-JSON error body — keep the generic detail
        }
        throw new Error(detail);
      }
      const raw = await res.json();
      const parsed = normalizeReport(raw);
      if (!parsed) throw new Error("report was not parseable");
      setReport(parsed);
    } catch (err: any) {
      setReportError(String(err?.message || err));
      setReport(
        fallbackReport(ctx, transcriptRef.current, elapsedRef.current, reason)
      );
    } finally {
      setReportLoading(false);
    }
  }, []);

  // ── End call + stop everything ───────────────────────────────────────
  const endCall = useCallback(
    (reason: CallOutcome) => {
      if (endedRef.current) return;
      endedRef.current = true;
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      setOutcome(reason);
      setCustomerSpeaking(false);
      setCustomerPartial("");
      setUserPartial("");
      mic.stop();
      stt.disconnect();
      dg.disconnect();
      live.close();
      playHangupTone();
      setLiveStateBoth("ended");
      setPhaseBoth("ended");
      void generateReport(reason);

      // ── HIDDEN FREE-SPEECH DATA → after-session analysis ─────────────
      // The SAME data Free Speech collects is captured BEFORE the pipeline
      // resets, persisted the same way, and the same /analysis experience
      // is produced after the call ends.
      const ctx = contextRef.current;
      if (ctx) {
        captureSpeechData(ctx);
      }
    },
    [mic, stt, dg, live, generateReport, setPhaseBoth, setLiveStateBoth]
  );

  const endCallRef = useRef(endCall);
  endCallRef.current = endCall;

  // ── Capture the hidden speech data → persist → store the analysis
  //    payload in a ref so CloserMode can route to /analysis. ────────────
  const speechPayloadRef = useRef<any>(null);
  const captureSpeechData = useCallback(
    (ctx: CallContext) => {
      try {
        const smSnapshot = stt.snapshotTranscripts();
        const finalTranscripts =
          mergedFinalChunks.length > 0 ? mergedFinalChunks : smSnapshot;
        const finalAcoustic = acoustic.getEvents();
        const sensorEvents = sensor.getEvents();
        const all = mergeAcousticEvents(finalAcoustic, sensorEvents);
        const paceReport = pace.finalize();
        const finalTokens = finalTokensRef.current;
        const finalHiddenKeys = finalHiddenKeysRef.current;
        const finalDisfluencies = disfluencyCollector.snapshot();
        const recoverySnapshot = recovery.annotations;
        const sessionId = sessionIdRef.current;
        const finalMarkers = markersRef.current;

        const payload = buildAnalysisPayload({
          sessionId,
          topic: `Closer Call — ${ctx.product} (${ctx.customerName})`,
          mode: "closer",
          finalTranscripts,
          acousticEvents: finalAcoustic,
          sensorEvents,
          allAcoustic: all,
          recoveryAnnotations: recoverySnapshot,
          finalTokens: finalTokens as any[],
          finalHiddenKeys,
          finalDisfluencies,
          markers: finalMarkers,
          paceReport,
        });
        speechPayloadRef.current = payload;

        diagBanner("CLOSER SESSION END — hidden speech analysis", {
          product: ctx.product,
          ts: new Date().toISOString(),
          words: finalTranscripts.reduce((n, c) => n + (c.isFinal ? c.words.length : 0), 0),
          mergedEvents: all.map((e) => `${e.type}@${e.startTime.toFixed(2)}`),
          savedTranscriptTokens: finalTokens.length,
          savedDisfluencies: finalDisfluencies.map((d) => `${d.type}:"${d.word}"@${d.timeMs}ms`),
          score: payload.overallScore,
        });

        try {
          persistSessionDisfluencies({
            sessionId,
            topic: `Closer Call — ${ctx.product} (${ctx.customerName})`,
            recordedAt: new Date().toISOString(),
            items: finalDisfluencies,
          } satisfies SessionDisfluencySnapshot);
        } catch {
          // non-critical — history persistence is best-effort
        }

        const account = userRef.current;
        if (account) {
          persistMarkers(account, finalMarkers);
          const automaticEvents: OfficialDisfluencyEvent[] = finalDisfluencies.map(
            (d) => ({
              id: d.tokenId ? `evt_${sessionId}_${d.tokenId}` : makeMarkerId(),
              sessionId,
              tokenId: d.tokenId,
              word: d.word,
              firstLetter: d.firstLetter,
              type: d.type,
              timeMs: d.timeMs,
              source: "automatic" as const,
              utterance: d.utterance,
              sentence: d.sentence,
              createdAt: new Date().toISOString(),
            })
          );
          persistEvents(account, automaticEvents);
        }

        try {
          saveSessionData(payload.overallScore);
        } catch {
          // non-critical — history persistence is best-effort
        }
      } catch {
        // Speech analysis is best-effort — the sales report still shows.
      }
    },
    [stt, mergedFinalChunks, acoustic, sensor, pace, disfluencyCollector, recovery.annotations, saveSessionData]
  );

  // ── Hang-up decision (final intent only, with a recovery window) ──────
  const scheduleHangup = useCallback((delayMs = 700) => {
    window.setTimeout(() => endCallRef.current("customer-hung-up"), delayMs);
  }, []);

  // ── Reconnect after a transient socket drop (NOT a hang-up) ────────────
  const handleReconnect = useCallback(async () => {
    if (endedRef.current) return;
    setLiveStateBoth("reconnecting");
    if (reconnectAttemptRef.current >= 3) {
      // Give up after a few clean attempts — the connection is truly gone.
      endCallRef.current("connection-lost");
      return;
    }
    reconnectAttemptRef.current += 1;
    const ok = await live.reconnect();
    if (endedRef.current) return;
    if (ok) {
      reconnectAttemptRef.current = 0;
      setLiveStateBoth("connected");
      return;
    }
    // Retry with backoff: 1.5s, 3s, 6s…
    const delay = 1500 * 2 ** (reconnectAttemptRef.current - 1);
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = window.setTimeout(
      () => void handleReconnect(),
      Math.min(delay, 8000)
    );
  }, [live, setLiveStateBoth]);

  // ── Connect the live call (after the ringing phase) ──────────────────
  const connectCall = useCallback(async () => {
    const ctx = contextRef.current;
    if (!ctx || endedRef.current) return;
    setPhaseBoth("connecting");
    setLiveStateBoth("connecting");

    // One mic stream feeds ALL lanes: Speechmatics (user transcript),
    // Deepgram (hidden disfluency detection) and Gemini Live (customer
    // hears the user + barge-in VAD).
    mic.setOnAudioData((chunk) => {
      stt.sendAudio(chunk);
      dg.sendAudio(chunk);
      live.sendPcm(chunk);
    });

    await mic.start();
    window.setTimeout(() => setMicMissing(!micActiveRef.current), 450);

    stt.connect();
    dg.connect();
    setIsLive(true);

    live.start(buildCustomerSystemPrompt(ctx), {
      onOpen: () => {
        setPhaseBoth("live");
        setLiveStateBoth("connected");
        if (tickRef.current) clearInterval(tickRef.current);
        tickRef.current = setInterval(() => {
          elapsedRef.current += 0.25;
          setElapsed(elapsedRef.current);
          if (elapsedRef.current >= MAX_CALL_SECONDS) {
            endCallRef.current("timeout");
          }
        }, 250);
      },
      onAiText: (text) => {
        customerTurnRef.current += text;
        setCustomerPartial(customerTurnRef.current);
        setCustomerSpeaking(true);
        setLiveStateBoth("customer_speaking");
      },
      onTurnComplete: () => {
        const text = customerTurnRef.current.trim();
        customerTurnRef.current = "";
        setCustomerPartial("");
        setCustomerSpeaking(false);
        setLiveStateBoth("connected");
        if (!text) return;
        pushLine("customer", text);

        // The customer's final goodbye — unambiguous, no recovery.
        if (FINAL_HANGUP_RE.test(text)) {
          scheduleHangup();
          return;
        }

        // Soft leave-attempt — give the salesperson a chance to recover.
        if (SOFT_HANGUP_RE.test(text)) {
          softHangupCountRef.current += 1;
          if (softHangupCountRef.current >= 3) {
            scheduleHangup();
          }
        } else {
          softHangupCountRef.current = 0;
        }
      },
      onInterrupted: () => {
        setInterruptedAt(Date.now());
        setLiveStateBoth("interrupted");
        window.setTimeout(() => {
          if (phaseRef.current === "live" && !endedRef.current) {
            setLiveStateBoth("connected");
          }
        }, 1200);
      },
      onUserTranscript: (text) => {
        userPartialRef.current = text;
        setUserPartial(text);
        setLiveStateBoth("user_speaking");
      },
      onUserFinalTranscript: onUserFinalTranscript,
      onError: (err) => {
        setLiveError(err);
        setLiveStateBoth("error");
        setPhaseBoth("error");
      },
      onClose: () => {
        // Unexpected socket close mid-call is almost always a transient
        // network blip — NOT the customer hanging up.
        if (phaseRef.current === "live" && !endedRef.current) {
          void handleReconnect();
        }
      },
    });
  }, [mic, stt, dg, live, pushLine, setPhaseBoth, setLiveStateBoth, onUserFinalTranscript, handleReconnect]);

  // ── Flow actions ──────────────────────────────────────────────────────
  const beginRoulette = useCallback(() => {
    setPhaseBoth("roulette");
  }, [setPhaseBoth]);

  const onRouletteLand = useCallback(
    (product: string) => {
      const ctx: CallContext = {
        product,
        customerName: pickName(),
        persona: pickPersona(),
        mood: pickMood(),
      };
      contextRef.current = ctx;
      setContext(ctx);
      sessionIdRef.current = `closer-${Date.now().toString(36)}`;
      markersRef.current = [];
      finalTokensRef.current = [];
      finalHiddenKeysRef.current = [];
      setPhaseBoth("ringing");
      setLiveStateBoth("ringing");
      // Random 2–5s of ringing before the customer answers.
      const delay = 2000 + Math.random() * 3000;
      window.setTimeout(() => void connectCall(), delay);
    },
    [connectCall, setPhaseBoth, setLiveStateBoth]
  );

  const endCallByUser = useCallback(() => endCall("user-ended"), [endCall]);

  const reset = useCallback(() => {
    endedRef.current = false;
    seenFinalsRef.current = new Set();
    seenUserTranscriptRef.current = new Set();
    customerTurnRef.current = "";
    userPartialRef.current = "";
    elapsedRef.current = 0;
    softHangupCountRef.current = 0;
    reconnectAttemptRef.current = 0;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    transcriptRef.current = [];
    setTranscript([]);
    setElapsed(0);
    setContext(null);
    setOutcome(null);
    setReport(null);
    setReportError(null);
    setLiveError(null);
    setMicMissing(false);
    setSttNote(false);
    setInterruptedAt(0);
    setCustomerPartial("");
    setUserPartial("");
    setCustomerSpeaking(false);
    speechPayloadRef.current = null;
    setLiveStateBoth("idle");
    setPhaseBoth("idle");
  }, [setPhaseBoth, setLiveStateBoth]);

  useEffect(() => {
    if (stt.status === "error") setSttNote(true);
  }, [stt.status]);

  useEffect(
    () => () => {
      if (tickRef.current) clearInterval(tickRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    },
    []
  );

  return {
    phase,
    liveState,
    context,
    elapsed,
    transcript,
    customerPartial,
    userPartial,
    customerSpeaking,
    interruptedAt,
    liveError,
    micMissing,
    sttNote,
    liveStatus: live.status,
    sttStatus: stt.status,
    speakingLevel: mic.level,
    outcome,
    report,
    reportLoading,
    reportError,
    speechPayload: speechPayloadRef.current,
    beginRoulette,
    onRouletteLand,
    endCallByUser,
    reset,
  };
}
