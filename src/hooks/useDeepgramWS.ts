/**
 * BOLO — useDeepgramWS: PRIMARY live transcription engine
 *
 * Deepgram is the PRIMARY live transcript source. It consumes the SAME PCM
 * the Speechmatics socket consumes (the page tees the shared Float32 buffer),
 * so both providers live on the ONE BOLO session clock: Deepgram word times
 * (seconds, relative to its stream start) are mapped onto the session
 * timeline via the session-clock time captured when the first audio buffer
 * was sent.
 *
 * Config (exact, per spec — no smart_format / no cleanup / no smoothing):
 *   model=nova-2, language=en-US, filler_words=true, interim_results=true,
 *   punctuate=true, vad_events=true, no_delay=true, utterance_end_ms=1200.
 *
 * RULES
 *   • EVERY FINAL Deepgram word becomes a permanent transcript token —
 *     fluent words AND disfluent words (this is the PRIMARY engine).
 *   • Interim results are display-only (interimWords/interimText) — they
 *     NEVER create permanent tokens and never duplicate finalized words.
 *   • Disfluency detection runs on the RAW token FIRST (never normalized),
 *     then the raw phonetic spelling is normalized to the intended lexical
 *     word so the live transcript never shows "ssssslap"/"b-b-ball".
 *   • Block detection uses Deepgram word-timing gaps gated by the BOLO
 *     RMS/isSpeaking energy gate — ordinary silence is NOT a block.
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

/** Latest interim hypothesis word — display-only ghost (never permanent). */
export interface DeepgramInterimWord {
  word: string;
  startMs: number;
}

export interface DeepgramWSState {
  status: "idle" | "connecting" | "connected" | "disconnected" | "error";
  error: string | null;
  /** FINAL words (fluent + disfluent) — fed to the transcript reconciler. */
  finals: DeepgramFinalWord[];
  /** Latest interim hypothesis words (display-only). */
  interimWords: DeepgramInterimWord[];
  /** Latest interim hypothesis text (display-only). */
  interimText: string;
}

export interface UseDeepgramWSOptions {
  /** Shared analyser (RMS) — the BOLO isSpeaking gate for block detection. */
  getAnalyser?: () => AnalyserNode | null;
}

// ─── Endpoint + config (spec: exact params) ─────────────────────────────

const DG_WS_URL = "wss://api.deepgram.com/v1/listen";

const DG_QUERY = [
  "model=nova-2",
  "language=en-US",
  "filler_words=true",
  "interim_results=true",
  "punctuate=true",
  "vad_events=true",
  "no_delay=true",
  "utterance_end_ms=1200",
  "encoding=linear16",
  "sample_rate=16000",
  "channels=1",
].join("&");

/** Float32 PCM (-1..1) → PCM16 little-endian bytes for Deepgram. */
function toPcm16(buffer: Float32Array): ArrayBuffer {
  const copy = new Float32Array(buffer); // normalize to ArrayBuffer-backed
  const i16 = new Int16Array(copy.length);
  for (let i = 0; i < copy.length; i++) {
    const s = Math.max(-1, Math.min(1, copy[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return i16.buffer;
}

// ─── Block gate: RMS voice-activity (shared with the DSP lane) ──────────
// Ordinary silence must NOT become a block — only a timing gap while the
// mic energy says the user is (or just was) speaking counts.

const SPEAK_ON_RMS = 0.02;
const SPEAK_OFF_RMS = 0.01;
const SPEAK_SAMPLE_MS = 120;

interface RecentWord {
  norm: string;
  raw: string;
  startMs: number;
}

let dgUid = 0;

// ─── Hook ───────────────────────────────────────────────────────────────

export function useDeepgramWS(options?: UseDeepgramWSOptions) {
  const [state, setState] = useState<DeepgramWSState>({
    status: "idle",
    error: null,
    finals: [],
    interimWords: [],
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
  const interimRef = useRef<{ norm: string; startMs: number }[]>([]);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastActivityRef = useRef(0);
  const SILENCE_TIMEOUT_MS = 15000;
  /** Block detection state. */
  const lastWordEndMsRef = useRef<number | null>(null);
  const speakingRef = useRef(false);
  const speechSampleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rmsBufRef = useRef<Float32Array<ArrayBuffer>>(new Float32Array(0));

  // ── RMS isSpeaking gate (BOLO energy gate, hysteresis) ──────────────
  const sampleSpeaking = useCallback(() => {
    const analyser = options?.getAnalyser?.();
    if (!analyser) return;
    let buf = rmsBufRef.current;
    if (buf.length !== analyser.fftSize) {
      buf = new Float32Array(analyser.fftSize);
      rmsBufRef.current = buf;
    }
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / Math.max(1, buf.length));
    if (!speakingRef.current && rms > SPEAK_ON_RMS) speakingRef.current = true;
    else if (speakingRef.current && rms < SPEAK_OFF_RMS) speakingRef.current = false;
  }, [options]);

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
    lastWordEndMsRef.current = null;
    speakingRef.current = false;
    setState({
      status: "connecting",
      error: null,
      finals: [],
      interimWords: [],
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
        // BOLO isSpeaking gate — sampled while the lane is live.
        if (speechSampleRef.current) clearInterval(speechSampleRef.current);
        speechSampleRef.current = setInterval(sampleSpeaking, SPEAK_SAMPLE_MS);
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
            // FINAL → disfluency detection → PERMANENT token (fluent too —
            // Deepgram is the PRIMARY transcript source).
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

              // ── Block: Deepgram word-timing gap gated by the BOLO
              //    RMS/isSpeaking gate — ordinary silence is NOT a block.
              if (
                !type &&
                lastWordEndMsRef.current != null &&
                startMs - lastWordEndMsRef.current > 450 &&
                speakingRef.current
              ) {
                type = "block";
              }
              lastWordEndMsRef.current = endMs;

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

              const final: DeepgramFinalWord = {
                id: `dg-${Date.now().toString(36)}-${(dgUid++).toString(36)}`,
                word: normalizeLexicalWord(raw),
                rawWord: raw,
                startTimeMs: startMs,
                endTimeMs: endMs,
                confidence: conf,
                isDisfluency: verdict.isDisfluency || type != null,
                disfluencyType: type,
              };
              finalsRef.current = [...finalsRef.current, final];
              setState((prev) => ({ ...prev, finals: finalsRef.current }));
            }
          } else {
            // INTERIM → display-only ghost + revision detection. Never tokens.
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
              interimWords: words
                .filter((w) => w.word && w.word.trim())
                .map((w) => ({
                  word: w.word!.trim(),
                  startMs: Math.round(base + (w.start ?? 0) * 1000),
                })),
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
        if (speechSampleRef.current) {
          clearInterval(speechSampleRef.current);
          speechSampleRef.current = null;
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
  }, [options, sampleSpeaking]);

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
    if (speechSampleRef.current) {
      clearInterval(speechSampleRef.current);
      speechSampleRef.current = null;
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
      if (speechSampleRef.current) {
        clearInterval(speechSampleRef.current);
        speechSampleRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close(1000, "Component unmount");
      }
    };
  }, []);

  return { ...state, connect, sendAudio, disconnect };
}
