import { useCallback, useEffect, useRef, useState } from "react";
import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
  ActivityHandling,
} from "@google/genai";
import { supabase, SUPABASE_URL } from "../lib/supabase";
import { AudioQueue, float32ToInt16, int16ToBase64 } from "../lib/closerAudio";
import { createVoiceActivity } from "../lib/voiceActivity";

/**
 * Gemini Live customer — a REAL audio-to-audio session.
 *
 * Pipeline:
 *   mic (16 kHz PCM16, ~256ms chunks) → Gemini Live API → native Gemini
 *   audio (24 kHz PCM16) → sequential WebAudio playback.
 *
 * The API key never reaches the browser — a short-lived, single-use
 * ephemeral token is minted server-side by the `gemini-live-token` Edge
 * Function and used for this one call session.
 *
 * ── Conversation quality ────────────────────────────────────────────────
 * 1. ONE SPOKEN PROMPT = ONE USER TURN. Server `inputTranscription` events
 *    (interim AND segment-final) are ACCUMULATED into a single user-turn
 *    buffer. The buffer is committed to the caller as ONE final transcript
 *    only when the model starts its reply (or the turn completes / a safety
 *    timeout fires) — never per streaming event. Interim events only update
 *    the live partial bubble. This is the frontend layer; the server-side
 *    VAD tuning below is what prevents the fragmentation in the first place.
 *
 * 2. SERVER-SIDE ACTIVITY DETECTION is kept ON (the authority for turn
 *    boundaries) and tuned for conversation: Gemini Live's DEFAULT is the
 *    most aggressive setting (START_HIGH + END_HIGH = "ends speech more
 *    often"). We set END_SENSITIVITY_LOW + silenceDurationMs 900 so normal
 *    short intra-sentence pauses do NOT end the user's turn, while the
 *    model still answers promptly once the user actually stops.
 *    `activityHandling` stays at the documented default
 *    START_OF_ACTIVITY_INTERRUPTS (barge-in) — set explicitly for clarity.
 *
 * 3. LOW-LATENCY CHUNKING. The shared mic lane delivers ~256ms chunks to
 *    every consumer (Speechmatics / Deepgram / stutter DSP). Google
 *    recommends 20–40ms realtime audio chunks for the Live API, so the
 *    256ms chunk is split into 40ms sub-chunks HERE, inside the Gemini
 *    lane only — nothing else in the 16 kHz pipeline changes.
 *
 * 4. INTERRUPT / BARGE-IN. Server signal (`serverContent.interrupted`) and
 *    a lightweight client-side RMS VAD (safety net for the Gemini 3.1 edge
 *    case where the server may not emit `interrupted`) both flush the
 *    playback queue immediately. The Live session stays open; the mic keeps
 *    flowing; the user's new speech keeps accumulating.
 *
 * 5. SESSION CONTINUITY. One Live session lives for the whole call. On a
 *    reconnect (transient socket blip) the server gives us a FRESH session
 *    with no memory — the conversation so far is re-hydrated via
 *    `sendClientContent({ turns, turnComplete: false })` so the customer
 *    doesn't forget earlier turns.
 */
const LIVE_MODEL = "gemini-3.1-flash-live-preview";
const LIVE_VOICE = "Puck";

/**
 * Gemini Live sub-chunk: 40ms of 16 kHz PCM = 640 samples (Google's
 * low-latency guidance for Live realtime audio).
 */
const LIVE_AUDIO_CHUNK_SAMPLES = 640;

/**
 * Safety timeout (ms) for committing an accumulated user turn. If the
 * server finalized the user's speech but the model never produces a reply
 * (or takes unusually long), the accumulated text is committed anyway so
 * it never gets lost. Cancelled the moment any new user audio or model
 * activity arrives.
 */
const USER_TURN_COMMIT_MS = 1600;

export type LiveStatus = "idle" | "connecting" | "live" | "error" | "closed";

/**
 * Developer-facing messages per error class returned by the gemini-live-token
 * Edge Function. Never includes the API key — Google error bodies are parsed
 * server-side and only the safe, classified message reaches the browser.
 */
const LIVE_ERROR_MESSAGES: Record<string, string> = {
  "missing-secret":
    "Gemini isn't configured yet — add the GEMINI_API_KEY secret in Supabase Edge Function secrets.",
  "unsupported-credential-type":
    "Google rejected the stored credential type when minting the live token (ACCESS_TOKEN_TYPE_UNSUPPORTED) — the AI Studio credential in GEMINI_API_KEY isn't accepted by the ephemeral-token endpoint in its current form. Re-store the credential from AI Studio and try again.",
  "invalid-key":
    "Gemini rejected the stored credential (401) — verify it in AI Studio and re-store it.",
  forbidden:
    "Gemini denied access (403) — check that the credential's project has the Gemini API enabled.",
  quota: "Gemini quota exceeded (429) — wait a bit and try again.",
  "model-unavailable": `The Gemini Live model (${LIVE_MODEL}) is unavailable — check the model name.`,
};

function liveErrorMessage(cls: string | undefined, fallback: string): string {
  if (cls && LIVE_ERROR_MESSAGES[cls]) return LIVE_ERROR_MESSAGES[cls];
  const f = (fallback || "").slice(0, 240);
  return f || "The live connection failed — check the Gemini configuration.";
}

export interface LiveHistoryLine {
  role: "user" | "customer";
  text: string;
}

export interface LiveHandlers {
  onOpen: () => void;
  /** Streaming text of the customer's current reply (may arrive in parts). */
  onAiText: (text: string) => void;
  /** The customer finished their reply. */
  onTurnComplete: () => void;
  /** Server told us the user interrupted the model. */
  onInterrupted: () => void;
  /**
   * The client-side VAD cut the customer's audio locally (barge-in safety
   * net for the Gemini 3.1 case where the server may not emit
   * `interrupted` when the user is already speaking as the model's turn
   * begins).
   */
  onBargeIn: () => void;
  /** Streaming (interim) transcript of what the user is currently saying. */
  onUserTranscript: (text: string) => void;
  /**
   * ONE final user turn — the accumulated text of the whole spoken prompt,
   * committed only when the turn is determined to have ended.
   */
  onUserFinalTranscript: (text: string) => void;
  onError: (err: string) => void;
  /** Socket closed unexpectedly (without our close()). */
  onClose: () => void;
  /** Snapshot of the conversation so far (for context re-hydration on reconnect). */
  getHistory?: () => LiveHistoryLine[];
}

/** Whitespace-normalise (for fuzzy duplicate detection between event channels). */
function normText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function useGeminiLive() {
  const sessionRef = useRef<{ close: () => void } | null>(null);
  const queueRef = useRef<AudioQueue | null>(null);
  const handlersRef = useRef<LiveHandlers | null>(null);
  const instructionRef = useRef("");
  const statusRef = useRef<LiveStatus>("idle");
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // Lightweight barge-in VAD (RMS gate on the live mic stream).
  const vadRef = useRef(createVoiceActivity());
  // True while customer audio is actively playing (armed for barge-in).
  const playingRef = useRef(false);

  // ── User-turn accumulation (ONE spoken prompt = ONE user turn) ────────
  const userTurnTextRef = useRef("");
  const userCommitTimerRef = useRef<number | null>(null);

  // ── Flush instrumentation (verification + the dev test bridge) ────────
  const flushCountRef = useRef(0);
  const lastFlushAtRef = useRef(0);
  const lastFlushSourceRef = useRef<"server" | "local" | "">("");

  // ── Connection bookkeeping ────────────────────────────────────────────
  const connectCountRef = useRef(0);

  // Stable handle to the latest sendPcm (exposed to the dev test bridge).
  const sendPcmRef = useRef<((f32: Float32Array) => void) | null>(null);

  const setLiveStatus = useCallback((s: LiveStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  /** Flush the customer's playback queue immediately (barge-in). */
  const flushAudio = useCallback((source: "server" | "local") => {
    playingRef.current = false;
    queueRef.current?.flush();
    flushCountRef.current += 1;
    lastFlushAtRef.current = Date.now();
    lastFlushSourceRef.current = source;
  }, []);

  // ── User-turn aggregation state machine ───────────────────────────────
  /**
   * Append a server segment-final transcription to the current user turn.
   * Successive `inputTranscription.finished` events can be independent
   * segments of ONE spoken prompt (e.g. the VAD finalised "Hello" and then
   * "what's your name?"), so segments are merged — not replaced — with
   * fuzzy duplicate protection in case the server re-sends cumulative text.
   */
  const appendUserSegment = useCallback((seg: string) => {
    const b = normText(seg);
    if (!b) return;
    const a = userTurnTextRef.current;
    if (!a) {
      userTurnTextRef.current = b;
      return;
    }
    if (b.startsWith(a)) {
      // Server re-sent the cumulative text for the segment — keep the new copy.
      userTurnTextRef.current = b;
      return;
    }
    if (a.endsWith(b)) return; // duplicate tail
    userTurnTextRef.current = `${a} ${b}`;
  }, []);

  /**
   * Commit the accumulated user turn as ONE final transcript. Safe to call
   * repeatedly — the buffer is cleared on the first commit.
   */
  const commitUserTurn = useCallback(() => {
    if (userCommitTimerRef.current !== null) {
      clearTimeout(userCommitTimerRef.current);
      userCommitTimerRef.current = null;
    }
    const text = userTurnTextRef.current.trim();
    userTurnTextRef.current = "";
    if (text) handlersRef.current?.onUserFinalTranscript(text);
  }, []);

  /** Arm the safety timer that commits a finalised user turn if the model never replies. */
  const armUserCommitTimer = useCallback(() => {
    if (userCommitTimerRef.current !== null) clearTimeout(userCommitTimerRef.current);
    userCommitTimerRef.current = window.setTimeout(() => {
      userCommitTimerRef.current = null;
      commitUserTurn();
    }, USER_TURN_COMMIT_MS);
  }, [commitUserTurn]);

  /** Cancel the safety timer (new user audio or model activity arrived). */
  const cancelUserCommitTimer = useCallback(() => {
    if (userCommitTimerRef.current !== null) {
      clearTimeout(userCommitTimerRef.current);
      userCommitTimerRef.current = null;
    }
  }, []);

  /** Parse `serverContent` → transcript + PCM16 audio playback. */
  const handleServerMessage = useCallback(
    (msg: unknown) => {
      const sc = (msg as { serverContent?: any })?.serverContent;
      if (!sc) return;

      if (sc.interrupted) {
        // User started speaking over the customer — stop playback NOW and
        // tell the caller. The user's ongoing speech keeps accumulating.
        cancelUserCommitTimer();
        flushAudio("server");
        handlersRef.current?.onInterrupted();
      }

      const parts = sc.modelTurn?.parts ?? [];
      let text = "";
      for (const p of parts) {
        if (p.text) text += p.text;
        if (p.inlineData?.data) {
          if (!queueRef.current) queueRef.current = new AudioQueue();
          playingRef.current = true;
          queueRef.current.enqueue(p.inlineData.data);
        }
      }
      if (text) {
        // The model started its reply → the user's turn is over → commit
        // the accumulated text as exactly ONE user message.
        commitUserTurn();
        handlersRef.current?.onAiText(text);
      }

      // Streaming transcriptions (independent of the model turn).
      if (sc.inputTranscription?.text) {
        if (sc.inputTranscription.finished) {
          // Server-side VAD finalised this segment — merge into the turn
          // buffer. NOT committed yet: the user may keep talking.
          appendUserSegment(sc.inputTranscription.text);
          armUserCommitTimer();
        } else {
          // Interim within an ongoing turn — live partial bubble only.
          cancelUserCommitTimer();
          handlersRef.current?.onUserTranscript(sc.inputTranscription.text);
        }
      }
      if (sc.interimInputTranscription?.text) {
        cancelUserCommitTimer();
        handlersRef.current?.onUserTranscript(sc.interimInputTranscription.text);
      }
      if (sc.outputTranscription?.text) {
        // Customer text from transcription (finalized speech).
        commitUserTurn();
        handlersRef.current?.onAiText(sc.outputTranscription.text);
      }

      if (sc.turnComplete) {
        // Flush any user text that was finalised but never answered.
        commitUserTurn();
        handlersRef.current?.onTurnComplete();
      }
    },
    [
      flushAudio,
      cancelUserCommitTimer,
      appendUserSegment,
      armUserCommitTimer,
      commitUserTurn,
    ]
  );

  /**
   * Connect the Live session with a freshly minted ephemeral token. Used both
   * for the initial call and for reconnection after a transient socket close:
   * `instructionRef` + `handlersRef` persist, so a retry picks up exactly
   * where the call left off (no duplicate system-instruction state).
   */
  const connectLive = useCallback(
    async (instruction: string) => {
      setLiveStatus("connecting");
      try {
        // 1. Mint a short-lived ephemeral token (key stays in the Edge Function).
        const session = (await supabase.auth.getSession()).data.session;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;

        const res = await fetch(`${SUPABASE_URL}/functions/v1/gemini-live-token`, {
          method: "POST",
          headers,
        });
        if (!res.ok) {
          // The Edge Function returns { class, error } — map it to a clear,
          // safe message instead of leaking raw internals.
          let cls: string | undefined;
          let raw = `Live token request failed (${res.status})`;
          try {
            const body = await res.json();
            cls = body?.class;
            if (body?.error) raw = body.error;
          } catch {
            // Non-JSON error body — keep the generic message.
          }
          throw new Error(liveErrorMessage(cls, raw));
        }
        const { token } = await res.json();
        if (!token) throw new Error("No live token returned by server");

        // 2. Connect with the ephemeral token, carrying the full customer
        //    system instruction (name / persona / product / mood / behaviour
        //    rules). Logged for runtime verification that it reached the
        //    session config.
        if (import.meta.env?.DEV) {
          console.info("[BOLO] Gemini Live system instruction (chars):", instruction.length);
          console.info("[BOLO] Gemini Live customer:", instruction.split("\n").slice(0, 6).join(" | "));
        }
        const ai = new GoogleGenAI({
          apiKey: token,
          httpOptions: { apiVersion: "v1alpha" },
        });
        const liveSession = await ai.live.connect({
          model: LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: { parts: [{ text: instruction }] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE } },
            },
            generationConfig: { temperature: 1.1 },
            // ── Conversation-quality tuning ─────────────────────────────
            // Gemini Live DEFAULTS to START_SENSITIVITY_HIGH + END_SENSITIVITY_HIGH
            // — the most aggressive activity detection ("ends speech more
            // often"). That makes short intra-sentence pauses end the user's
            // turn and the model reply mid-sentence. Tuned for a real call:
            // LOW end-sensitivity + 900ms of required silence before the turn
            // ends, while start detection stays responsive (300ms prefix).
            // Automatic (server-side) VAD stays ON — it is the authority for
            // turn boundaries; the client VAD is only a barge-in safety net.
            realtimeInputConfig: {
              automaticActivityDetection: {
                startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
                endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                prefixPaddingMs: 300,
                silenceDurationMs: 900,
              },
              // Documented default for barge-in: user speech interrupts the
              // model's response immediately. Set explicitly for clarity.
              activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
            },
          },
          callbacks: {
            onopen: () => {
              setLiveStatus("live");
              handlersRef.current?.onOpen();
            },
            onmessage: handleServerMessage,
            onerror: (e: any) => {
              const m = e?.error?.message || e?.message || "Live connection error";
              setError(m);
              setLiveStatus("error");
              handlersRef.current?.onError(m);
            },
            onclose: () => {
              setLiveStatus("closed");
              handlersRef.current?.onClose();
            },
          },
        });
        sessionRef.current = liveSession as unknown as { close: () => void };

        // 3. On a RECONNECT the server session is fresh and has no memory of
        //    the call. Re-hydrate the full conversation so far with
        //    sendClientContent({ turns, turnComplete:false }) — the model
        //    gets the history but keeps listening for new audio instead of
        //    answering the recap.
        if (connectCountRef.current > 0) {
          try {
            const history = handlersRef.current?.getHistory?.() ?? [];
            if (history.length > 0) {
              (sessionRef.current as any).sendClientContent?.({
                turns: history.map((h) => ({
                  role: h.role === "user" ? "user" : "model",
                  parts: [{ text: h.text }],
                })),
                turnComplete: false,
              });
              if (import.meta.env?.DEV) {
                console.info("[BOLO] Live reconnect — re-hydrated context with", history.length, "turns");
              }
            }
          } catch {
            // Best-effort — the live call continues either way.
          }
        }
        connectCountRef.current += 1;
      } catch (err: any) {
        const m = String(err?.message || err);
        setError(m);
        setLiveStatus("error");
        handlersRef.current?.onError(m);
      }
    },
    [handleServerMessage]
  );

  const start = useCallback(
    async (systemInstruction: string, handlers: LiveHandlers) => {
      handlersRef.current = handlers;
      setError(null);
      // Hard guard: a Closer call must ALWAYS carry the customer system
      // instruction. Refuse to connect rather than let Gemini improvise a
      // cooperative assistant persona.
      const instruction = (systemInstruction || "").trim();
      if (!instruction) {
        const msg =
          "The live customer was started without a system instruction — refusing to connect.";
        setError(msg);
        setLiveStatus("error");
        handlersRef.current?.onError(msg);
        return;
      }
      instructionRef.current = instruction;
      await connectLive(instruction);
    },
    [connectLive]
  );

  /**
   * Mic Float32 PCM chunk (16 kHz) → Gemini Live. Dropped until live.
   *
   * LATENCY: the shared mic lane delivers ~256ms chunks. Google recommends
   * 20–40ms realtime audio chunks for the Live API, so each chunk is split
   * into 40ms sub-chunks HERE — the server can start acting on the user's
   * speech ~200ms earlier. The 16 kHz pipeline shared with Speechmatics /
   * Deepgram / the stutter DSP is untouched: this split happens only in the
   * Gemini lane, after every other consumer already ran.
   *
   * Also feeds the barge-in VAD per sub-chunk (finer granularity = a more
   * natural cut when the user starts talking over the customer). If the
   * customer is playing and the user just started speaking, the queue is
   * flushed instantly (client-side safety) and the caller is told so it can
   * finalise the cut-off customer partial.
   */
  const sendPcm = useCallback(
    (f32: Float32Array) => {
      if (statusRef.current !== "live") return;

      for (let i = 0; i < f32.length; i += LIVE_AUDIO_CHUNK_SAMPLES) {
        const sub = f32.subarray(i, i + LIVE_AUDIO_CHUNK_SAMPLES);
        // Client-side barge-in: user started talking over the customer.
        if (playingRef.current && vadRef.current.feed(sub)) {
          flushAudio("local");
          handlersRef.current?.onBargeIn();
        }
        try {
          (sessionRef.current as any)?.sendRealtimeInput({
            audio: {
              data: int16ToBase64(float32ToInt16(sub)),
              mimeType: "audio/pcm;rate=16000",
            },
          });
        } catch {
          // Never let one bad chunk kill the call.
        }
      }
    },
    [flushAudio]
  );

  // Keep the latest sendPcm available to the dev test bridge.
  useEffect(() => {
    sendPcmRef.current = sendPcm;
  }, [sendPcm]);

  const close = useCallback(() => {
    try {
      (sessionRef.current as any)?.close();
    } catch {
      // noop
    }
    sessionRef.current = null;
    queueRef.current?.stop();
    queueRef.current = null;
    vadRef.current.reset();
    playingRef.current = false;
    cancelUserCommitTimer();
    userTurnTextRef.current = "";
    setLiveStatus("closed");
  }, [cancelUserCommitTimer]);

  /**
   * Reconnect a Live session that dropped mid-call (transient network blip).
   * Reuses the stored system instruction + handlers so the conversation can
   * resume instead of the call being treated as a hang-up. Returns true once
   * the socket is live again, false if the retry itself failed.
   */
  const reconnect = useCallback(async (): Promise<boolean> => {
    if (!instructionRef.current) return false;
    try {
      (sessionRef.current as any)?.close();
    } catch {
      // noop
    }
    sessionRef.current = null;
    await connectLive(instructionRef.current);
    return statusRef.current === "live";
  }, [connectLive]);

  // ── Dev-only test bridge (automated E2E) ──────────────────────────────
  // Exposes the Gemini lane so a headless harness can inject deterministic
  // PCM (real recorded speech), verify queue flushes, and read Live status.
  useEffect(() => {
    if (!import.meta.env?.DEV) return;
    const bridge = {
      get status() {
        return statusRef.current;
      },
      sendPcm: (f32: Float32Array) => sendPcmRef.current?.(f32),
      flushCount: () => flushCountRef.current,
      lastFlushAt: () => lastFlushAtRef.current,
      lastFlushSource: () => lastFlushSourceRef.current,
      queueDepth: () => queueRef.current?.depth() ?? 0,
      resetFlushCount: () => {
        flushCountRef.current = 0;
      },
    };
    (window as any).__boloLive = bridge;
    return () => {
      if ((window as any).__boloLive === bridge) delete (window as any).__boloLive;
    };
  }, []);

  useEffect(() => () => close(), [close]);

  return { status, error, start, reconnect, sendPcm, close };
}
