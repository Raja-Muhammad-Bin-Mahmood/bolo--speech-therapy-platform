import { useRef, useCallback, useEffect, useState } from "react";
import { supabase, SUPABASE_URL } from "../lib/supabase";

// ─── Types ──────────────────────────────────────────────────────────────

export interface TranscriptWord {
  word: string;
  startTime: number;
  endTime: number;
  confidence?: number;
}

export interface TranscriptChunk {
  text: string;
  /** True for AddPartialTranscript (interim hypothesis), false for AddTranscript (final). */
  isFinal: boolean;
  /** Alias of !isFinal — structured token metadata for the UI. */
  isPartial: boolean;
  words: TranscriptWord[];
  /** Index of the utterance this chunk belongs to (increments on EndOfUtterance) */
  utterance?: number;
  /** Start time (seconds) of the first word in this chunk — as returned by the API. */
  startTime: number;
  /** End time (seconds) of the last word in this chunk — as returned by the API. */
  endTime: number;
}

export interface SpeechmaticsWSState {
  status: "idle" | "connecting" | "connected" | "disconnected" | "error";
  transcripts: TranscriptChunk[];
  /** Number of EndOfUtterance messages received (line-break signal) */
  utteranceCount: number;
  error: string | null;
}

// ─── Speechmatics endpoint (eu2 region, language pinned via path) ────────

const WS_URL = "wss://eu2.rt.speechmatics.com/v2/en";

// ─── Hook ───────────────────────────────────────────────────────────────
//
// NOTE — no disfluency/filler filtering exists in this module, on purpose.
// The Speechmatics request disables filtering (remove_disfluencies: false)
// and the parser below stores the returned word text VERBATIM. Nothing in
// BOLO removes, normalizes, deduplicates, or "corrects" Speechmatics output
// before it reaches the transcript UI.

export function useSpeechmaticsWS() {
  const [state, setState] = useState<SpeechmaticsWSState>({
    status: "idle",
    transcripts: [],
    utteranceCount: 0,
    error: null,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const transcriptsRef = useRef<TranscriptChunk[]>([]);
  // Guards the handshake ordering: binary audio must NEVER reach the socket
  // before the StartRecognition JSON config has been sent.
  const configSentRef = useRef(false);
  // Strict two-way handshake: Speechmatics must send RecognitionStarted
  // BEFORE any audio is allowed to flow. Sending audio earlier makes
  // Speechmatics permanently drop the connection in silence.
  const isReadyRef = useRef(false);
  // Watchdog: if the socket is open but Speechmatics sends nothing for this
  // long, we surface "API NOT REPORTING BACK" so the user knows the provider
  // (not the app) is at fault.
  const lastActivityRef = useRef(0);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const SILENCE_TIMEOUT_MS = 15000;
  // EndOfUtterance counter: each EoU message increments this; stamped onto
  // subsequent final chunks so TranscriptionChunks can break lines naturally.
  const utteranceCountRef = useRef(0);

  // ── Connect (guarded: no-op if already connected — saves credits) ──
  const connect = useCallback(async () => {
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      console.warn("Speechmatics already connected — skipping duplicate session");
      return;
    }
    // Clear transcripts for a fresh session
    transcriptsRef.current = [];
    setState((prev) => ({
      ...prev,
      status: "connecting",
      error: null,
      transcripts: [],
      utteranceCount: 0,
    }));
    configSentRef.current = false;
    isReadyRef.current = false;
    utteranceCountRef.current = 0;

    try {
      // 1. Fetch JWT from Edge Function.
      //    Local/demo mode has no Supabase session, so omit the Authorization
      //    header entirely instead of sending "Bearer undefined" — the edge
      //    function is intentionally open to unauthenticated callers.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const accessToken = session?.access_token;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

      const res = await fetch(
        `${SUPABASE_URL}/functions/v1/speechmatics-token`,
        {
          method: "POST",
          headers,
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Token fetch failed: ${res.status} ${errText}`);
      }

      const { token: jwt } = await res.json();
      console.log("Fetched temporary JWT:", jwt ? "SUCCESS" : "FAILED");
      if (!jwt) throw new Error("No JWT in response");

      // 2. Open WebSocket
      console.log("Opening Speechmatics WebSocket...");
      const ws = new WebSocket(
        `${WS_URL}?jwt=${encodeURIComponent(jwt)}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        setState((prev) => ({ ...prev, status: "connected", error: null }));
        lastActivityRef.current = Date.now();

        // 3. Send StartRecognition message.
        //    V2 SCHEMA (validated against the official Realtime API reference):
        //    `transcript_filtering_config` is a TOP-LEVEL StartRecognition field
        //    (sibling of `transcription_config`) — NOT nested inside it. It
        //    controls disfluency removal. `remove_disfluencies: false` keeps
        //    fillers ("um", "uh") AND all raw disfluent forms verbatim — the
        //    rawest lexical output the API provides. `enable_partials: true`
        //    streams AddPartialTranscript (interim) results so the UI sees a
        //    word while it's still being spoken. `conversation_config` makes
        //    the server emit EndOfUtterance after ~0.7s of real silence.
        //    `max_delay` stays above end_of_utterance_silence_trigger (API
        //    requirement). No LLM, no cleanup, no normalization of results.
        const config = {
          message: "StartRecognition",
          audio_format: {
            type: "raw",
            encoding: "pcm_f32le",
            sample_rate: 16000,
          },
          transcription_config: {
            language: "en",
            operating_point: "enhanced",
            enable_partials: true,
            max_delay: 0.8,
            conversation_config: {
              end_of_utterance_silence_trigger: 0.7,
            },
          },
          transcript_filtering_config: {
            remove_disfluencies: false, // keep ALL disfluencies verbatim
          },
        };
        ws.send(JSON.stringify(config));
        configSentRef.current = true;
        console.log("📡 StartRecognition config sent (audio may now flow)");

        // 4. Start watchdog: if Speechmatics sends no messages for
        //    SILENCE_TIMEOUT_MS, flag it as API-not-reporting.
        lastActivityRef.current = Date.now();
        if (watchdogRef.current) clearInterval(watchdogRef.current);
        watchdogRef.current = setInterval(() => {
          const idle = Date.now() - lastActivityRef.current;
          if (idle > SILENCE_TIMEOUT_MS) {
            console.error("Speechmatics watchdog triggered — no activity for", idle, "ms");
            setState((prev) => ({
              ...prev,
              status: "error",
              error: "API NOT REPORTING BACK",
            }));
            if (watchdogRef.current) {
              clearInterval(watchdogRef.current);
              watchdogRef.current = null;
            }
          }
        }, 2000);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (!msg || typeof msg !== "object") return;

          // Any JSON from the API counts as activity (AudioAdded acks too)
          lastActivityRef.current = Date.now();

          // ── Strict two-way handshake ───────────────────────────────
          // Speechmatics must confirm it's ready BEFORE we send audio.
          if (msg.message === "RecognitionStarted") {
            console.log("HANDSHAKE COMPLETE: Speechmatics is ready for audio.");
            isReadyRef.current = true;
            return;
          }

          // Surface API errors/warnings instead of dropping them silently
          if (msg.message === "Error" || msg.message === "Warning") {
            console.error("SPEECHMATICS SERVER ERROR:", msg);
            setState((prev) => ({
              ...prev,
              status: msg.message === "Error" ? "error" : prev.status,
              error:
                msg.reason ||
                msg.type ||
                msg.message ||
                "Speechmatics API error",
            }));
            return;
          }

          // ── EndOfUtterance: user has fully stopped (silence trigger hit) ──
          // This is the native line-break signal — close the current line
          // and open a fresh one.
          if (msg.message === "EndOfUtterance") {
            utteranceCountRef.current += 1;
            setState((prev) => ({
              ...prev,
              utteranceCount: utteranceCountRef.current,
            }));
            return;
          }

          // Acks/control messages — ignore cleanly, never break execution
          if (
            msg.message === "AudioAdded" ||
            msg.message === "EndOfTranscript" ||
            !Array.isArray(msg.results) ||
            msg.results.length === 0
          ) {
            return;
          }

          const isFinal = msg.message === "AddTranscript";
          const words = msg.results.map((r: any) => ({
            word: r.alternatives?.[0]?.content || r.content || "",
            startTime: r.start_time || 0,
            endTime: r.end_time || 0,
            confidence: r.alternatives?.[0]?.confidence ?? 0.9,
          }));
          // Verbatim join — no cleanup, no normalization, no dedup. "sssslap"
          // stays "sssslap"; "rhrhrhro" stays "rhrhrhro"; repeated lexical
          // material is preserved exactly as Speechmatics returned it.
          const text = words.map((w: any) => w.word).join(" ");

          const chunk: TranscriptChunk = {
            text,
            isFinal,
            isPartial: !isFinal,
            words,
            utterance: utteranceCountRef.current,
            // Structured token metadata (seconds, as returned by the API).
            startTime: words.length > 0 ? words[0].startTime : 0,
            endTime:
              words.length > 0 ? words[words.length - 1].endTime : 0,
          };

          // For partials, replace the last partial; for finals, append
          if (!isFinal) {
            const prev = transcriptsRef.current;
            const filtered = prev.filter((t) => t.isFinal);
            transcriptsRef.current = [...filtered, chunk];
          } else {
            // A final supersedes the trailing partial that previewed it —
            // drop every non-final chunk so words never render twice.
            const prev = transcriptsRef.current.filter((t) => t.isFinal);
            transcriptsRef.current = [...prev, chunk];
          }

          setState((prev) => ({
            ...prev,
            transcripts: transcriptsRef.current,
          }));
        } catch {
          // Non-JSON messages (audio echo, etc.) — ignore
        }
      };

      ws.onerror = () => {
        setState((prev) => ({
          ...prev,
          status: "error",
          error: "WebSocket connection error",
        }));
      };

      ws.onclose = () => {
        if (watchdogRef.current) {
          clearInterval(watchdogRef.current);
          watchdogRef.current = null;
        }
        setState((prev) => ({
          ...prev,
          status: "disconnected",
        }));
        wsRef.current = null;
      };
    } catch (err: any) {
      setState((prev) => ({
        ...prev,
        status: "error",
        error: err.message || "Unknown error",
      }));
    }
  }, []);

  // ── Send audio (silent drop if not ready — removes per-chunk log) ──
  const sendAudio = useCallback((buffer: Float32Array) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!isReadyRef.current) return;
    ws.send(buffer.buffer);
  }, []);

  // ── Disconnect (keeps transcripts so final scoring can read them) ──
  const disconnect = useCallback(() => {
    if (watchdogRef.current) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close(1000, "Session ended");
      wsRef.current = null;
    }
    isReadyRef.current = false;
    configSentRef.current = false;
    setState((prev) => ({
      ...prev,
      status: "idle",
    }));
  }, []);

  // ── Snapshot: copy of the current transcript list (for final scoring) ──
  const snapshotTranscripts = useCallback((): TranscriptChunk[] => {
    return transcriptsRef.current.map((c) => ({
      ...c,
      words: c.words.map((w) => ({ ...w })),
    }));
  }, []);

  useEffect(() => {
    return () => {
      if (watchdogRef.current) {
        clearInterval(watchdogRef.current);
        watchdogRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close(1000, "Component unmount");
      }
    };
  }, []);

  return { ...state, connect, sendAudio, disconnect, snapshotTranscripts };
}