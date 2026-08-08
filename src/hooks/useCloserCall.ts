import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioCapture } from "./useAudioCapture";
import { useSpeechmaticsWS } from "./useSpeechmaticsWS";
import { useGeminiLive } from "./useGeminiLive";
import { pickMood, pickName, pickPersona } from "../data/closerCatalog";
import { playHangupTone } from "../lib/closerAudio";
import {
  buildCustomerSystemPrompt,
  buildReportPrompt,
  REPORT_RESPONSE_SCHEMA,
} from "../lib/closerPrompts";
import { fallbackReport, normalizeReport } from "../lib/salesReport";
import { SUPABASE_URL } from "../lib/supabase";
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
 */
export function useCloserCall() {
  const mic = useAudioCapture();
  const stt = useSpeechmaticsWS();
  const live = useGeminiLive();

  const [phase, setPhase] = useState<CallPhase>("idle");
  /** Explicit live-call sub-state (per spec §23). */
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
  // Soft leave-attempts the customer made but the salesperson recovered from.
  const softHangupCountRef = useRef(0);
  // Ongoing reconnect bookkeeping (transient socket drops are NOT hang-ups).
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);

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
      live.close();
      playHangupTone();
      setLiveStateBoth("ended");
      setPhaseBoth("ended");
      void generateReport(reason);
    },
    [mic, stt, live, generateReport, setPhaseBoth, setLiveStateBoth]
  );

  const endCallRef = useRef(endCall);
  endCallRef.current = endCall;

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

    // One mic stream feeds both lanes: Speechmatics (user transcript)
    // and Gemini Live (customer hears the user + barge-in VAD).
    mic.setOnAudioData((chunk) => {
      stt.sendAudio(chunk);
      live.sendPcm(chunk);
    });

    await mic.start();
    window.setTimeout(() => setMicMissing(!micActiveRef.current), 450);

    stt.connect();

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

        // The customer's final goodbye — unambiguous, no recovery. Only
        // matches explicit farewell/hang-up lines (NOT "I've got to go",
        // "I'm busy", "email me" — those are recovery opportunities the
        // prompt guarantees, so they never hard-end the call).
        if (FINAL_HANGUP_RE.test(text)) {
          scheduleHangup();
          return;
        }

        // Soft leave-attempt (e.g. "I've got to go", "I'm really busy"):
        // give the salesperson a chance to recover. Only escalate to a real
        // hang-up if the customer keeps pushing to leave across multiple
        // turns and the salesperson never wins them back.
        if (SOFT_HANGUP_RE.test(text)) {
          softHangupCountRef.current += 1;
          if (softHangupCountRef.current >= 3) {
            scheduleHangup();
          }
        } else {
          // A normal response means the call is still on — reset the counter
          // so occasional "I'm busy" remarks don't accumulate forever.
          softHangupCountRef.current = 0;
        }
      },
      onInterrupted: () => {
        setInterruptedAt(Date.now());
        setLiveStateBoth("interrupted");
        // Reset to connected shortly after so the next turn is clean.
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
        // network blip — NOT the customer hanging up. Give the Live session
        // a chance to reconnect before ever ending the call.
        if (phaseRef.current === "live" && !endedRef.current) {
          void handleReconnect();
        }
      },
    });
  }, [mic, stt, live, pushLine, setPhaseBoth, setLiveStateBoth, onUserFinalTranscript, handleReconnect]);

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
    beginRoulette,
    onRouletteLand,
    endCallByUser,
    reset,
  };
}
