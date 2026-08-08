import { useCallback, useEffect, useRef, useState } from "react";
import { GoogleGenAI, Modality } from "@google/genai";
import { supabase, SUPABASE_URL } from "../lib/supabase";
import { AudioQueue, float32ToPcmBlob } from "../lib/closerAudio";
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
 * Interruptions:
 *   1. Server signal: `serverContent.interrupted` → flush the audio queue.
 *   2. Client fallback: a lightweight RMS voice-activity detector watches
 *      the live mic. If the customer is speaking and the user starts
 *      talking, flush immediately (barge-in without waiting for the server).
 *   3. The session stays open in both cases — mic keeps flowing, Gemini
 *      keeps listening.
 */
const LIVE_MODEL = "gemini-3.1-flash-live-preview";
const LIVE_VOICE = "Puck";

export type LiveStatus = "idle" | "connecting" | "live" | "error" | "closed";

export interface LiveHandlers {
  onOpen: () => void;
  /** Streaming text of the customer's current reply (may arrive in parts). */
  onAiText: (text: string) => void;
  /** The customer finished their reply. */
  onTurnComplete: () => void;
  /** Server told us the user interrupted the model. */
  onInterrupted: () => void;
  /** Streaming transcript of what the user just said (interim). */
  onUserTranscript: (text: string) => void;
  /** Final transcript of the user's utterance. */
  onUserFinalTranscript: (text: string) => void;
  onError: (err: string) => void;
  /** Socket closed unexpectedly (without our close()). */
  onClose: () => void;
}

export function useGeminiLive() {
  const sessionRef = useRef<{ close: () => void } | null>(null);
  const queueRef = useRef<AudioQueue | null>(null);
  const handlersRef = useRef<LiveHandlers | null>(null);
  const statusRef = useRef<LiveStatus>("idle");
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // Lightweight barge-in VAD (RMS gate on the live mic stream).
  const vadRef = useRef(createVoiceActivity());
  // True while customer audio is actively playing (armed for barge-in).
  const playingRef = useRef(false);

  const setLiveStatus = useCallback((s: LiveStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  /** Flush the customer's playback queue immediately (barge-in). */
  const flushAudio = useCallback(() => {
    playingRef.current = false;
    queueRef.current?.flush();
  }, []);

  /** Parse `serverContent` → transcript + PCM16 audio playback. */
  const handleServerMessage = useCallback(
    (msg: unknown) => {
      const sc = (msg as { serverContent?: any })?.serverContent;
      if (!sc) return;

      if (sc.interrupted) {
        flushAudio();
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
      if (text) handlersRef.current?.onAiText(text);

      // Streaming transcriptions (independent of the model turn).
      if (sc.inputTranscription?.text) {
        if (sc.inputTranscription.finished) {
          handlersRef.current?.onUserFinalTranscript(sc.inputTranscription.text);
        } else {
          handlersRef.current?.onUserTranscript(sc.inputTranscription.text);
        }
      }
      if (sc.interimInputTranscription?.text) {
        handlersRef.current?.onUserTranscript(sc.interimInputTranscription.text);
      }
      if (sc.outputTranscription?.text) {
        // Customer text from transcription (finalized speech).
        handlersRef.current?.onAiText(sc.outputTranscription.text);
      }

      if (sc.turnComplete) handlersRef.current?.onTurnComplete();
    },
    [flushAudio]
  );

  const start = useCallback(
    async (systemInstruction: string, handlers: LiveHandlers) => {
      handlersRef.current = handlers;
      setError(null);
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
        if (!res.ok) throw new Error(`Live token request failed (${res.status})`);
        const { token } = await res.json();
        if (!token) throw new Error("No live token returned by server");

        // 2. Connect with the ephemeral token.
        const ai = new GoogleGenAI({
          apiKey: token,
          httpOptions: { apiVersion: "v1alpha" },
        });
        const liveSession = await ai.live.connect({
          model: LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: { parts: [{ text: systemInstruction }] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE } },
            },
            generationConfig: { temperature: 1.1 },
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
      } catch (err: any) {
        const m = String(err?.message || err);
        setError(m);
        setLiveStatus("error");
        handlersRef.current?.onError(m);
      }
    },
    [handleServerMessage]
  );

  /**
   * Mic Float32 PCM chunk (16 kHz) → Gemini Live. Dropped until live.
   * Also feeds the barge-in VAD: if the customer is playing and the user
   * just started speaking, flush the queue instantly.
   */
  const sendPcm = useCallback(
    (f32: Float32Array) => {
      if (statusRef.current !== "live") return;

      // Client-side barge-in: user started talking over the customer.
      if (playingRef.current && vadRef.current.feed(f32)) {
        flushAudio();
      }

      try {
        (sessionRef.current as any)?.sendRealtimeInput({
          media: float32ToPcmBlob(f32),
        });
      } catch {
        // Never let one bad chunk kill the call.
      }
    },
    [flushAudio]
  );

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
    setLiveStatus("closed");
  }, []);

  useEffect(() => () => close(), [close]);

  return { status, error, start, sendPcm, close };
}
