import { useCallback, useEffect, useRef, useState } from "react";
import { GoogleGenAI, Modality } from "@google/genai";
import { supabase, SUPABASE_URL } from "../lib/supabase";
import { AudioQueue, float32ToPcmBlob } from "../lib/closerAudio";

/**
 * Gemini Live model used for the customer's voice + conversational brain.
 * The API key never reaches the browser — a short-lived, single-use
 * ephemeral token is minted server-side by the `gemini-live-token`
 * Edge Function and used for this one call session.
 */
const LIVE_MODEL = "gemini-live-2.5-flash-preview";
const LIVE_VOICE = "Puck";

export type LiveStatus = "idle" | "connecting" | "live" | "error" | "closed";

export interface LiveHandlers {
  onOpen: () => void;
  /** Streaming text of the customer's current reply (may arrive in parts). */
  onAiText: (text: string) => void;
  /** The customer finished their reply. */
  onTurnComplete: () => void;
  /** The customer barged in over the user's speech. */
  onInterrupted: () => void;
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

  const setLiveStatus = useCallback((s: LiveStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  /** Parse `serverContent` → text transcript + PCM16 audio playback. */
  const handleServerMessage = useCallback((msg: unknown) => {
    const sc = (msg as { serverContent?: any })?.serverContent;
    if (!sc) return;

    if (sc.interrupted) handlersRef.current?.onInterrupted();

    const parts = sc.modelTurn?.parts ?? [];
    let text = "";
    for (const p of parts) {
      if (p.text) text += p.text;
      if (p.inlineData?.data) {
        if (!queueRef.current) queueRef.current = new AudioQueue();
        queueRef.current.enqueue(p.inlineData.data);
      }
    }
    if (text) handlersRef.current?.onAiText(text);
    if (sc.turnComplete) handlersRef.current?.onTurnComplete();
  }, []);

  const start = useCallback(
    async (systemInstruction: string, handlers: LiveHandlers) => {
      handlersRef.current = handlers;
      setError(null);
      setLiveStatus("connecting");
      try {
        // 1. Mint a short-lived ephemeral token (key stays in the Edge Function).
        const session = (await supabase.auth.getSession()).data.session;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;

        const res = await fetch(`${SUPABASE_URL}/functions/v1/gemini-live-token`, {
          method: "POST",
          headers,
        });
        if (!res.ok) throw new Error(`Live token request failed (${res.status})`);
        const { token } = await res.json();
        if (!token) throw new Error("No live token returned by server");

        // 2. Connect with the ephemeral token (v1alpha constrained endpoint).
        const ai = new GoogleGenAI({
          apiKey: token,
          httpOptions: { apiVersion: "v1alpha" },
        });
        const liveSession = await ai.live.connect({
          model: LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO, Modality.TEXT],
            systemInstruction: { parts: [{ text: systemInstruction }] },
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
              const m =
                e?.error?.message || e?.message || "Live connection error";
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

  /** Mic Float32 PCM chunk (16 kHz) → Gemini Live. Dropped until live. */
  const sendPcm = useCallback((f32: Float32Array) => {
    if (statusRef.current !== "live") return;
    try {
      (sessionRef.current as any)?.sendRealtimeInput({
        media: float32ToPcmBlob(f32),
      });
    } catch {
      // Never let one bad chunk kill the call.
    }
  }, []);

  const close = useCallback(() => {
    try {
      (sessionRef.current as any)?.close();
    } catch {
      // noop
    }
    sessionRef.current = null;
    queueRef.current?.stop();
    queueRef.current = null;
    setLiveStatus("closed");
  }, []);

  useEffect(() => () => close(), [close]);

  return { status, error, start, sendPcm, close };
}
