import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioCapture } from "./useAudioCapture";
import { useSpeechmaticsWS } from "./useSpeechmaticsWS";
import { useGeminiLive } from "./useGeminiLive";
import { pickMood, pickName, pickPersona } from "../data/closerCatalog";
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
  SalesReport,
  TranscriptLine,
} from "../lib/closerTypes";

/** Hard cap on any call — the model is told to wrap up before this too. */
const MAX_CALL_SECONDS = 120;

/** Detects the customer's goodbye line (only ever checked on CUSTOMER turns). */
const HANGUP_RE =
  /(hang\s?up|hanging up|gotta go|got to go|have to go|need to leave|i'?m (going|leaving now)|goodbye|\bbye\b|don'?t call me)/i;

/**
 * The whole Closer Mode state machine: roulette → ringing → live call →
 * ended + report. Owns mic, Speechmatics STT (user's side) and the Gemini
 * Live customer.
 */
export function useCloserCall() {
  const mic = useAudioCapture();
  const stt = useSpeechmaticsWS();
  const live = useGeminiLive();

  const [phase, setPhase] = useState<CallPhase>("idle");
  const [context, setContext] = useState<CallContext | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [customerPartial, setCustomerPartial] = useState("");
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
  const contextRef = useRef<CallContext | null>(null);
  const transcriptRef = useRef<TranscriptLine[]>([]);
  const elapsedRef = useRef(0);
  const endedRef = useRef(false);
  const customerTurnRef = useRef("");
  const seenFinalsRef = useRef<Set<object>>(new Set());
  const micActiveRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setPhaseBoth = useCallback((p: CallPhase) => {
    phaseRef.current = p;
    setPhase(p);
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
      if (!res.ok) throw new Error(`report request failed (${res.status})`);
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
      setOutcome(reason);
      setCustomerSpeaking(false);
      setCustomerPartial("");
      mic.stop();
      stt.disconnect();
      live.close();
      setPhaseBoth("ended");
      void generateReport(reason);
    },
    [mic, stt, live, generateReport, setPhaseBoth]
  );

  const endCallRef = useRef(endCall);
  endCallRef.current = endCall;

  // ── Connect the live call (after the ringing phase) ──────────────────
  const connectCall = useCallback(async () => {
    const ctx = contextRef.current;
    if (!ctx || endedRef.current) return;
    setPhaseBoth("connecting");

    // One mic stream feeds both lanes: Speechmatics (user transcript)
    // and Gemini Live (customer hears the user). Each lane self-guards.
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
      },
      onTurnComplete: () => {
        const text = customerTurnRef.current.trim();
        customerTurnRef.current = "";
        setCustomerPartial("");
        setCustomerSpeaking(false);
        if (!text) return;
        pushLine("customer", text);
        // The customer decided to hang up? (only after 10s so greetings
        // like "bye" in a normal reply can't false-trigger).
        if (
          elapsedRef.current > 10 &&
          text.length < 140 &&
          !text.endsWith("?") &&
          HANGUP_RE.test(text)
        ) {
          window.setTimeout(() => endCallRef.current("customer-hung-up"), 700);
        }
      },
      onInterrupted: () => setInterruptedAt(Date.now()),
      onError: (err) => {
        setLiveError(err);
        setPhaseBoth("live");
      },
      onClose: () => {
        // Unexpected socket close mid-call = the customer hung up.
        if (phaseRef.current === "live" && !endedRef.current) {
          endCallRef.current("customer-hung-up");
        }
      },
    });
  }, [mic, stt, live, pushLine, setPhaseBoth]);

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
      // Random 2–5s of ringing before the customer answers.
      const delay = 2000 + Math.random() * 3000;
      window.setTimeout(() => void connectCall(), delay);
    },
    [connectCall, setPhaseBoth]
  );

  const endCallByUser = useCallback(() => endCall("user-ended"), [endCall]);

  const reset = useCallback(() => {
    endedRef.current = false;
    seenFinalsRef.current = new Set();
    customerTurnRef.current = "";
    elapsedRef.current = 0;
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
    setCustomerSpeaking(false);
    setPhaseBoth("idle");
  }, [setPhaseBoth]);

  useEffect(() => {
    if (stt.status === "error") setSttNote(true);
  }, [stt.status]);

  useEffect(
    () => () => {
      if (tickRef.current) clearInterval(tickRef.current);
    },
    []
  );

  return {
    phase,
    context,
    elapsed,
    transcript,
    customerPartial,
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
