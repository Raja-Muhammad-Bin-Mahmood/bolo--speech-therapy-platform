/**
 * BOLO — useDeepgramWS: Secondary real-time disfluency / lexical source
 *
 * Deepgram is NOT a second microphone stream — it consumes the SAME PCM the
 * Speechmatics socket consumes (the page tees the shared Float32 buffer).
 * Both providers therefore share the ONE BOLO session clock: Deepgram word
 * times (seconds, relative to its stream start) are mapped onto the session
 * timeline via the session-clock time captured when the first audio buffer
 * was sent, so a Deepgram "slap" and a Speechmatics "rap" are compared on
 * identical millisecond axes (never raw provider timestamps).
 *
 * Config (exact): model=nova-2, language=en-US, smart_format=true,
 * filler_words=true, punctuate=true, interim_results=true,
 * utterance_end_ms=1200, vad_events=true, no_delay=true.
 *
 * RULES
 *   • FINAL Deepgram word results are the only source of PERMANENT tokens,
 *     and only when a disfluency is detected (isDisfluency=true).
 *   • Interim results are used for live diagnostics + revision detection —
 *     they NEVER create permanent transcript tokens.
 *   • Raw word → detection → lexical normalization → visible word.
 *   • The raw API key never leaves the `deepgram-token` Edge Function; the
 *     browser receives a short-lived temporary key via the WebSocket URL.
 */
import { useRef, useCallback, useEffect, useState } from "react";
import { supabase, SUPABASE_URL } from "../lib/supabase";
import * as sessionClock from "../lib/sessionClock";
import {
  classifyDeepgramWord,
  normalizeLexicalWord,
  type DeepgramDisfluencyType,
} from "../lib/deepgramDisfluency";

// ─── Types ──────────────────────────────────────────────────────────────

export interface DeepgramFinalWord {
  id: string;
  /** Normalized visible lexical word (never raw phonetic stutter text). */
  word: string;
  /** Raw Deepgram output — detection/debugging only. */
  rawWord: string;
  /** Session-relative milliseconds (shared session clock). */
  startTimeMs: number;
  endTimeMs: number;
  confidence: number;
  isDisfluency: boolean;
  disfluencyType?: DeepgramDisfluencyType;
}

export interface DeepgramWSState {
  status: "idle" | "connecting" | "connected" | "disconnected" | "error";
  error: string | null;
  /** Final disfluency tokens — fed to the transcript reconciler. */
  finals: DeepgramFinalWord[];
  /** Latest interim hypothesis (diagnostics only — never permanent). */
  interimText: string;
}

// ─── Endpoint + config (spec: exact params) ─────────────────────────────

const DG_WS_URL = "wss://api.deepgram.com/v1/listen";

const DG_QUERY = [
  "model=nova-2",
  "language=en-US",
  "smart_format=true",
  "filler_words=true",
  "punctuate=true",
  "interim_results=true",
  "utterance_end_ms=1200",
  "vad_events=true",
  "no_delay=true",
  "encoding=linear16",
  "sample_rate=16000",
  "channels=1",
].join("&");

/** Float32 PCM (-1..1) → PCM16 little-endian bytes for Deepgram. */
function toPcm16(buffer: Float32Array): ArrayBuffer {
  const i16 = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const s = Math.max(-1, Math.min(1, buffer[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return i16.buffer;
}

interface RecentWord {
  norm: string;
  raw: string;
  startMs: number;
}

interface InterimWord {
  norm: string;
  startMs: number;
}

let dgUid = 0;

// ─── Hook ───────────────────────────────────────────────────────────────

export function useDeepgramWS() {
  const [state, setState] = useState<DeepgramWSState>({
    status: "idle",
    error: null,
    finals: [],
    interimText: "",
  });
  const wsRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const finalsRef = useRef<DeepgramFinalWord[]>([]);
  const seenFinalRef = useRef<Set<string>>(new Set());
  /** Session-relative ms at the moment Deepgram's stream started. */
  const streamStartMsRef = useRef<number | null>(null);
  /** Rolling recent FINAL words — sequence-level repetition detection. */
  const recentRef = useRef<RecentWord[]>([]);
  /** Latest interim hypothesis — revision (abandoned word) detection. */
  const interimRef = useRef<InterimWord[]>([]);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastActivityRef = useRef(0);
  const SILENCE_TIMEOUT_MS = 15000;

  // ── Connect (mint temp key → open socket) ──────────────────────────
  const connect = useCallback(async () => {
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      console.warn("Deepgram already connected — skipping duplicate session");
      return;
    }
    readyRef.current = false;
    streamStartMsRef.current = null;
    finalsRef.current = [];
    seenFinalRef.current = new Set();
    recentRef.current = [];
    interimRef.current = [];
    setState({
      status: "connecting",
      error: null,
      finals: [],
      interimText: "",
    });

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

      const res = await fetch(
        `${SUPABASE_URL}/functions/v1/deepgram-token`,
        { method: "POST", headers }
      );
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Deepgram token fetch failed: ${res.status} ${errText}`);
      }
      const { token } = await res.json();
      if (!token) throw new Error("No Deepgram temp key in response");

      const ws = new WebSocket(
        `${DG_WS_URL}?${DG_QUERY}&token=${encodeURIComponent(token)}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        readyRef.current = true; // audio may flow immediately (no handshake)
        setState((prev) => ({ ...prev, status: "connected", error: null }));
        lastActivityRef.current = Date.now();
        if (watchdogRef.current) clearInterval(watchdogRef.current);
        watchdogRef.current = setInterval(() => {
          if (Date.now() - lastActivityRef.current > SILENCE_TIMEOUT_MS) {
            console.error("Deepgram watchdog triggered — no activity");
            setState((prev) => ({
              ...prev,
              status: "error",
              error: "Deepgram lane not reporting back",
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
          lastActivityRef.current = Date.now();

          if (msg.type === "Metadata") return;
          if (msg.type === "SpeechStarted" || msg.type === "SpeechEnded" || msg.type === "UtteranceEnd") {
            return;
          }
          if (msg.type === "Error" || msg.type === "error") {
            console.error("DEEPGRAM SERVER ERROR:", msg);
            setState((prev) => ({
              ...prev,
              status: "error",
              error: msg.err_msg || msg.message || "Deepgram API error",
            }));
            return;
          }
          if (msg.type !== "Results") return;

          const words: {
            word?: string;
            start?: number;
            end?: number;
            confidence?: number;
          }[] = msg.channel?.alternatives?.[0]?.words ?? [];
          if (words.length === 0) return;

          const base = streamStartMsRef.current ?? 0;
          if (msg.is_final) {
            // FINAL → disfluency detection → permanent token candidates.
            for (const w of words) {
              const raw = (w.word ?? "").trim();
              if (!raw) continue;
              const startMs = Math.round(base + (w.start ?? 0) * 1000);
              const endMs = Math.max(
                startMs + 1,
                Math.round(base + (w.end ?? (w.start ?? 0)) * 1000)
              );
              const conf = w.confidence ?? 0.9;

              const key = `${startMs}-${endMs}-${raw.toLowerCase()}`;
              if (seenFinalRef.current.has(key)) continue;
              seenFinalRef.current.add(key);

              const verdict = classifyDeepgramWord(raw);
              let type = verdict.disfluencyType;
              const norm = normalizeLexicalWord(raw).toLowerCase().replace(/[^a-z0-9']/g, "");

              // Sequence-level detection (needs context across tokens):
              // word repetition "I I I" (separate tokens) + phrase repetition.
              const recent = recentRef.current;
              const prev = recent.length > 0 ? recent[recent.length - 1] : null;
              if (
                !type &&
                prev &&
                norm.length > 0 &&
                prev.norm === norm &&
                startMs - prev.startMs < 1500
              ) {
                type = "word_repetition";
              } else if (
                !type &&
                prev &&
                norm.length > 0 &&
                prev.norm.length > 0
              ) {
                // 2-gram [prev, cur] seen earlier within the last 4s = phrase repetition.
                const gram = `${prev.norm}|${norm}`;
                const found = recent
                  .slice(0, -1)
                  .some((r, i) => {
                    const nxt = recent[i + 1];
                    return (
                      nxt &&
                      `${r.norm}|${nxt.norm}` === gram &&
                      startMs - nxt.startMs < 4000
                    );
                  });
                if (found) type = "phrase_repetition";
              }

              // Revision / abandoned word: an interim word occupied this
              // interval with a DIFFERENT lexical form (the speaker revised).
              if (!type) {
                const interim = interimRef.current.find(
                  (iw) => iw.norm !== norm && Math.abs(iw.startMs - startMs) <= 350
                );
                if (interim) type = "revision";
              }

              // Keep every final word as sequence context (fluent too).
              recentRef.current = [
                ...recentRef.current.filter(
                  (r) => startMs - r.startMs < 8000
                ),
                { norm, raw, startMs },
              ].slice(-60);

              if (verdict.isDisfluency || type) {
                const final: DeepgramFinalWord = {
                  id: `dg-${Date.now().toString(36)}-${(dgUid++).toString(36)}`,
                  word: normalizeLexicalWord(raw),
                  rawWord: raw,
                  startTimeMs: startMs,
                  endTimeMs: endMs,
                  confidence: conf,
                  isDisfluency: true,
                  disfluencyType: type,
                };
                finalsRef.current = [...finalsRef.current, final];
                setState((prev) => ({ ...prev, finals: finalsRef.current }));
              }
            }
          } else {
            // INTERIM → diagnostics + revision detection only. Never tokens.
            interimRef.current = words
              .filter((w) => w.word && w.word.trim())
              .map((w) => ({
                norm: normalizeLexicalWord(w.word!.trim())
                  .toLowerCase()
                  .replace(/[^a-z0-9']/g, ""),
                startMs: Math.round(base + (w.start ?? 0) * 1000),
              }));
            setState((prev) => ({
              ...prev,
              interimText: words.map((w) => w.word).join(" "),
            }));
          }
        } catch {
          // Non-JSON / malformed frames — ignore
        }
      };

      ws.onerror = () => {
        setState((prev) => ({
          ...prev,
          status: "error",
          error: "Deepgram WebSocket error",
        }));
      };

      ws.onclose = () => {
        if (watchdogRef.current) {
          clearInterval(watchdogRef.current);
          watchdogRef.current = null;
        }
        readyRef.current = false;
        setState((prev) => ({ ...prev, status: "disconnected" }));
        wsRef.current = null;
      };
    } catch (err: any) {
      setState((prev) => ({
        ...prev,
        status: "error",
        error: err.message || "Unknown Deepgram error",
      }));
    }
  }, []);

  // ── Send the SAME audio the Speechmatics socket receives ────────────
  const sendAudio = useCallback((buffer: Float32Array) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!readyRef.current) return;
    // Pin Deepgram's stream origin to the shared session clock on the FIRST
    // audio buffer. Both providers consume the same PCM from the same
    // instant, so Deepgram word times now live on the BOLO session timeline.
    if (streamStartMsRef.current == null) {
      const now = sessionClock.now();
      streamStartMsRef.current = now != null ? now * 1000 : 0;
    }
    ws.send(toPcm16(buffer));
  }, []);

  // ── Disconnect ─────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    if (watchdogRef.current) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close(1000, "Session ended");
      wsRef.current = null;
    }
    readyRef.current = false;
    setState((prev) => ({ ...prev, status: "idle" }));
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

  return { ...state, connect, sendAudio, disconnect };
}
