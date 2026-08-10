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
 * Config (exact, per spec):
 *   model=nova-2, language=en-US, smart_format=true, filler_words=true,
 *   interim_results=true, punctuate=true, vad_events=true, no_delay=true,
 *   utterance_end_ms=1200, encoding=linear16, sample_rate=16000, channels=1.
 *
 * DISFLUENCY REPORTING (free-speech rule): Deepgram's listen API has NO
 * dedicated `disfluencies=true` query parameter (verified against the
 * streaming API reference — no disfluency option exists in the param list).
 * Reporting is therefore achieved two ways:
 *   1. `filler_words=true` keeps every filler ("um", "uh", "er"…) in the
 *      word stream — without it Deepgram would drop them entirely.
 *   2. The RAW `word` field IS Deepgram's own verdict on how the word was
 *      spoken. smart_format=true only affects the `punctuated_word` display
 *      form — the raw `word` field still carries stutter spellings
 *      ("ssssslap", "b-b-ball"), so they remain inspectable. When the raw
 *      token is itself disfluent, the word is tagged UNCONDITIONALLY in the
 *      message handler (classifyDeepgramVerdict) — never gated by BOLO's
 *      rule set, confidence bands, zHR/A levels or the fusion floor.
 *
 * RULES
 *   • EVERY FINAL Deepgram word becomes a permanent transcript token —
 *     fluent words AND disfluent words (this is the PRIMARY engine).
 *   • Interim results are display-only (interimWords/interimText) — they
 *     NEVER create permanent tokens and never duplicate finalized words.
 *   • AUTHORITATIVE VERDICT: if the RAW Deepgram token is itself disfluent
 *     (filler / sound repetition / prolongation / intra-token word
 *     repetition) it is tagged immediately. The BOLO detector runs ONLY as
 *     a backstop for words Deepgram already normalized clean ("ssssslap" →
 *     "slap"), then the raw phonetic spelling is normalized to the intended
 *     lexical word so the live transcript never shows "ssssslap"/"b-b-ball".
 *   • Block detection uses Deepgram word-timing gaps gated by the BOLO
 *     RMS/isSpeaking energy gate — ordinary silence is NOT a block.
 *   • The raw API key never leaves the `deepgram-token` Edge Function; the
 *     browser receives a short-lived temporary API key (scope `member`, TTL
 *     600s) via the Sec-WebSocket-Protocol subprotocol ("token", <temp key>)
 *     — the ONLY header browsers may set during a WebSocket handshake.
 */
import { useRef, useCallback, useEffect, useState } from "react";
import { supabase, SUPABASE_URL } from "../lib/supabase";
import {
  onPin,
  shiftValue,
  now as sessionClockNow,
} from "../lib/sessionClock";
import {
  normalizeLexicalWord,
  DeepgramDisfluencyDetector,
  classifyDeepgramVerdict,
  type DeepgramDisfluencyTag,
  type DeepgramDisfluencyType,
  type DeepgramProcessedToken,
} from "../lib/deepgramDisfluency";
import type { AcousticEvent } from "./useAcousticAnalysis";

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
  /** STRUCTURED tag — the LIVE TRANSCRIPT renderer underlines on this. */
  disfluency: DeepgramDisfluencyTag | null;
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
  /**
   * ACTUAL AudioContext sample rate — the rate of the PCM sent to Deepgram.
   * Used to declare `sample_rate` in the connection query so the declared
   * format always matches the transmitted bytes (spec §1). Falls back to
   * 16000 when not provided.
   */
  getSampleRate?: () => number | null;
  /**
   * BOLO acoustic/DSP-lane events (shared pool). When Deepgram already
   * normalized a phonetic stutter away ("ssssslap" → "slap"), the detector
   * corroborates the disfluency from the acoustic evidence overlapping the
   * word's time window.
   */
  acousticEvents?: AcousticEvent[];
}

// ─── Endpoint + config (spec: exact params) ─────────────────────────────

const DG_WS_URL = "wss://api.deepgram.com/v1/listen";

/**
 * Sanitized config actually used for the connection (spec §4). `token` is
 * appended SEPARATELY (never in this list — it must not be logged).
 * `sample_rate` is derived from the real AudioContext at connect time (spec
 * §1: the declared rate MUST describe the actual PCM).
 */
function buildDgQuery(sampleRate: number): string {
  return [
    "model=nova-2",
    "language=en-US",
    "smart_format=true",
    "filler_words=true",
    "interim_results=true",
    "punctuate=true",
    "vad_events=true",
    "no_delay=true",
    "utterance_end_ms=1200",
    "encoding=linear16",
    `sample_rate=${sampleRate}`,
    "channels=1",
  ].join("&");
}

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

let dgUid = 0;

/**
 * Map the closest BOLO acoustic/DSP-lane event to a Deepgram word window to
 * the nearest Deepgram disfluency type. Used ONLY when Deepgram already
 * normalized the phonetic stutter away ("ssssslap" → "slap") so the lexical
 * string carries no evidence — the acoustic lane is the independent physical
 * evidence that the word was disfluent.
 *
 * Three tolerance sources are handled here so corroboration actually fires:
 *   1. Clock-axis offset    — handled by the pin rebase in the hook (both
 *      axes aligned); nothing to do here.
 *   2. ASR word-latency lag — Deepgram word starts land later than the true
 *      speech time (network + processing), so an acoustic event usually
 *      ENDS before the word BEGINS. The event is eligible when its window
 *      OVERLAPS the word OR ends within a small lookbehind of the word
 *      start (the event is physical evidence for the speech that produced
 *      this word).
 *   3. Preserved fragments  — 2-run voiced repetitions ("woh-woh") are the
 *      most common stutter form; their acoustic event carries the run
 *      structure. They are mapped to `sound_repetition` exactly like
 *      classified repetitions/stutters.
 */
function mapAcousticEvidence(
  events: AcousticEvent[],
  startMs: number,
  endMs: number
): DeepgramDisfluencyType | null {
  // Deepgram word starts lag the true speech time by network + processing;
  // a corroborating acoustic event typically ends shortly BEFORE the word
  // start. Allow that lag (the event must still overlap the word window OR
  // end within this lookbehind of the word start).
  const ASR_LAG_TOLERANCE_MS = 700;
  let best: AcousticEvent | null = null;
  let bestScore = -1;
  const s = startMs / 1000;
  const e = endMs / 1000;
  for (const evt of events) {
    if (evt.type === "fragment" && !evt.fragmentDetail) continue;
    const ov = Math.max(0, Math.min(e, evt.endTime) - Math.max(s, evt.startTime));
    if (ov > 0) {
      const score = ov; // strict interval overlap
      if (score > bestScore) {
        bestScore = score;
        best = evt;
      }
      continue;
    }
    // No overlap — allow the ASR-latency lookbehind: the event's END falls
    // within [start − tolerance, start). Prefer the event closest to the
    // word start.
    const evEnd = evt.endTime;
    const startS = s;
    if (evEnd <= startS && startS - evEnd <= ASR_LAG_TOLERANCE_MS / 1000) {
      const proximity = 1 - (startS - evEnd) / (ASR_LAG_TOLERANCE_MS / 1000);
      if (proximity > bestScore) {
        bestScore = proximity;
        best = evt;
      }
    }
  }
  if (!best) return null;
  switch (best.type) {
    case "prolongation":
      return "prolongation";
    case "block":
      return "block";
    case "stammer":
      // A STAMMER is a SUSTAINED fricative hold ("ssssssslap" = a long /s/),
      // not a bursty repetition — the acoustic equivalent of a prolongation.
      return "prolongation";
    case "repetition":
    case "stutter":
    case "fragment":
      return "sound_repetition";
    default:
      return null;
  }
}

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
  /** Actual PCM sample rate declared in the live connection (spec §1). */
  const actualSampleRateRef = useRef<number>(16000);
  const readyRef = useRef(false);
  const finalsRef = useRef<DeepgramFinalWord[]>([]);
  const seenFinalRef = useRef<Set<string>>(new Set());
  /**
   * Session-relative ms at the moment Deepgram's stream started, on the
   * PROVISIONAL axis. Deepgram is treated like every other producer: the
   * pin event rebases it to the pinned axis (sessionClock.shiftValue()).
   * Without that rebase the acoustic-event axis shifts away from the
   * Deepgram-word axis at the pin, and acoustic corroboration (the purple
   * underline's main evidence source) can never overlap a word.
   */
  const streamStartMsRef = useRef<number | null>(null);
  /**
   * Persistent, history-aware disfluency detector (ONE per recording
   * session). It holds the finalized-token history + interim hypothesis
   * internally and applies rules A–F (sound repetition, prolongation, word
   * repetition, phrase repetition, revision, block) to EVERY finalized
   * Deepgram word. Returns a structured `disfluency` tag or null.
   */
  const detectorRef = useRef<DeepgramDisfluencyDetector | null>(null);
  if (!detectorRef.current) {
    detectorRef.current = new DeepgramDisfluencyDetector({
      // Deepgram word-timing gap gated by the BOLO RMS isSpeaking gate —
      // ordinary silence is NOT a block (acoustic DSP block system untouched).
      isSpeaking: () => speakingRef.current,
    });
  }
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastActivityRef = useRef(0);
  const SILENCE_TIMEOUT_MS = 15000;
  /** Block detection state. */
  const speakingRef = useRef(false);
  const speechSampleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rmsBufRef = useRef<Float32Array<ArrayBuffer>>(new Float32Array(0));
  /**
   * Live acoustic-events snapshot. The WebSocket message handler is created
   * once at connect time, so it must read the CURRENT events through a ref
   * (never the connect-time `options` closure).
   */
  const acousticEventsRef = useRef<AcousticEvent[]>([]);
  acousticEventsRef.current = options?.acousticEvents ?? [];

  // ── Pin rebase (session-clock origin lands) ──────────────────────────
  // Deepgram's stream origin was captured on the PROVISIONAL axis; when the
  // shared clock pins, every provisional timestamp shifts by the same delta.
  // Rebase the stream origin AND the detector's internal history so both
  // Deepgram words and acoustic events live on ONE axis thereafter — without
  // this, the acoustic corroboration (purple underline) can never overlap a
  // Deepgram word emitted after the pin.
  useEffect(() => {
    return onPin(() => {
      const deltaMs = Math.round(shiftValue() * 1000); // −shift, 0 pre-pin
      if (deltaMs === 0) return;
      if (streamStartMsRef.current != null) {
        streamStartMsRef.current += deltaMs;
      }
      detectorRef.current?.rebase(deltaMs);
    });
  }, []);

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
    detectorRef.current?.reset();
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

      // ── REAL sample rate (spec §1) — the declared rate MUST match the
      // actual PCM. Derived from the live AudioContext; fallback 16000.
      const actualSampleRate =
        options?.getSampleRate?.() ?? 16000;
      actualSampleRateRef.current = actualSampleRate;
      const dgQuery = buildDgQuery(actualSampleRate);

      // ── AUTHENTICATION (verified, spec §3) ──────────────────────────
      // Browser WebSockets CANNOT set an Authorization header, and Deepgram
      // does NOT accept a `?token=` query parameter (returns HTTP 401 —
      // verified against the live API). The documented browser-safe
      // mechanism is the Sec-WebSocket-Protocol header with the temp key as
      // the subprotocol ("token", <key>) — the ONLY header browsers are
      // allowed to set during the handshake. The temp key NEVER appears in
      // the URL, logs, or UI.
      const ws = new WebSocket(`${DG_WS_URL}?${dgQuery}`, [
        "token",
        token,
      ]);
      wsRef.current = ws;

      // ── RUNTIME CONFIG TRACE (spec §4) — sanitized, token NEVER logged.
      console.info(
        `[DG·CFG] model=nova-2 language=en-US smart_format=true filler_words=true ` +
          `interim_results=true punctuate=true vad_events=true no_delay=true ` +
          `utterance_end_ms=1200 encoding=linear16 sample_rate=${actualSampleRate} ` +
          `channels=1 | auth=Sec-WebSocket-Protocol subprotocol "token" ` +
          `(temp key redacted, len=${String(token).length})`
      );

      ws.onopen = () => {
        readyRef.current = true; // audio may flow immediately (no handshake)
        setState((prev) => ({ ...prev, status: "connected", error: null }));
        // ── AUTH PROOF (acceptance §2) ────────────────────────────────
        // `ws.protocol` is the Sec-WebSocket-Protocol subprotocol the SERVER
        // actually negotiated. Deepgram echoes back "token" when it accepted
        // the handshake auth — anything else (or "") means the temp JWT was
        // NOT accepted and the socket will die or never transcribe.
        console.info(
          `[DG·WS] connection OPENED | url=wss://api.deepgram.com/v1/listen?${dgQuery} | ` +
            `auth=Sec-WebSocket-Protocol | ` +
            `negotiatedSubprotocol=${JSON.stringify(ws.protocol)}`
        );
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

          if (msg.type === "Metadata") {
            // Spec §5: capture model metadata from the CONNECTED connection
            // (never assume from source). Sanitized — no key material.
            console.info(
              `[DG·META] request_id=${msg.request_id ?? "?"} ` +
                `model=${msg.model_info?.name ?? "?"} ` +
                `sample_rate=${msg.sample_rate ?? "?"} ` +
                `channels=${msg.channels ?? "?"} ` +
                `duration=${msg.duration ?? "?"}`
            );
            return;
          }
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
          if (msg.type === "Results") {
            // ── RAW RESPONSE TRACE (acceptance §5) ─────────────────────
            // Log the RAW Deepgram frame EXACTLY as received — BEFORE any
            // normalization, filtering, confidence guards, word dedup, or
            // disfluency detection. This is the ground truth: whatever the
            // server returned is preserved verbatim in the runtime log.
            console.info(
              `[DG·RAW] is_final=${String(msg.is_final ?? "?")} ` +
                `words=${(msg.channel?.alternatives?.[0]?.words ?? []).length} ` +
                `raw=${JSON.stringify(msg)}`
            );
          }
          if (msg.type !== "Results") return;

          const words: {
            word?: string;
            /** smart_format=true: the punctuated display form ("Hello."). */
            punctuated_word?: string;
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
              // KEEP BOTH VALUES (spec): the RAW Deepgram word (which may
              // preserve phonetic stutter spelling "ssssslap") AND the
              // normalized display form ("slap"). The detector inspects
              // rawWord; the transcript renders word. punctuated_word
              // (smart_format=true) is preserved for display when present.
              const raw = (w.word ?? "").trim();
              if (!raw) continue;
              const punctuated = (w.punctuated_word ?? "").trim() || raw;
              const startMs = Math.round(base + (w.start ?? 0) * 1000);
              const endMs = Math.max(
                startMs + 1,
                Math.round(base + (w.end ?? (w.start ?? 0)) * 1000)
              );
              const conf = w.confidence ?? 0.9;

              const key = `${startMs}-${endMs}-${raw.toLowerCase()}`;
              if (seenFinalRef.current.has(key)) continue;
              seenFinalRef.current.add(key);

              // ── AUTHORITATIVE DEEPGRAM VERDICT (free-speech rule) ─────
              // The RAW token Deepgram returns IS Deepgram's own verdict on
              // how this word was spoken. If that raw form is itself
              // disfluent (filler / sound repetition / prolongation /
              // intra-token word repetition), the structured tag is set
              // IMMEDIATELY and UNCONDITIONALLY — never gated by BOLO's
              // lexical rule set, confidence bands, zHR/A levels or the
              // evidence-fusion visibility floor. Deepgram said it is a
              // disfluency → it IS a disfluency → purple underline.
              const dgVerdict = classifyDeepgramVerdict(raw);

              // ── BOLO DETECTOR (backstop only) ────────────────────────
              // Runs ONLY when Deepgram's own raw token carries no
              // disfluency evidence (e.g. it already normalized
              // "ssssslap"→"slap"): structured WordToken → processToken →
              // rules A–F (word/phrase repetition, revision, block,
              // acoustic corroboration) on sequence history. Detection runs
              // on the RAW token FIRST; normalization happens AFTER, only
              // for the display layer.
              const norm = normalizeLexicalWord(raw)
                .toLowerCase()
                .replace(/[^a-z0-9']/g, "");
              const displayWord = normalizeLexicalWord(raw);
              const wordToken = {
                word: displayWord,
                normalizedWord: norm,
                rawWord: raw,
                startTimeMs: startMs,
                endTimeMs: endMs,
                confidence: conf,
                source: "deepgram" as const,
                isFinal: true as const,
              };

              // Acoustic/DSP corroboration: BOLO's independent physical lane
              // may carry the evidence Deepgram's normalized spelling erased
              // ("ssssslap" → "slap"). Map the closest overlapping event.
              const acousticEvidence = mapAcousticEvidence(
                acousticEventsRef.current,
                startMs,
                endMs
              );

              // The Deepgram verdict wins whenever present; the BOLO
              // detector is consulted ONLY as a backstop for words
              // Deepgram already normalized clean. (No threshold below
              // "Deepgram itself flagged it" can suppress the tag.)
              const processed: DeepgramProcessedToken =
                dgVerdict != null
                  ? {
                      token: wordToken,
                      disfluency: dgVerdict,
                      rule: dgVerdict.type,
                      evaluated: [
                        "sound_repetition",
                        "prolongation",
                        "filler",
                      ] satisfies DeepgramDisfluencyType[],
                      acousticEvidence,
                    }
                  : detectorRef.current!.processToken(wordToken, {
                      acousticEvidence,
                    });
              const tag = processed.disfluency;
              const type = tag?.type;

              // ── MANDATORY DEBUG TRACE (spec: "ssssslap" test) ─────────
              // Log the FULL 13-point path so a miss is diagnosable without
              // guessing: raw → punctuated → normalized → timing →
              // confidence → WordToken → rules evaluated → matched rule →
              // verdict → TranscriptToken → isDisfluency → renderer.
              console.info(
                `[DG·TRACE] raw="${raw}" punctuated="${punctuated}" norm="${norm}"` +
                  ` start=${startMs}ms end=${endMs}ms conf=${conf.toFixed(3)}` +
                  ` | WordToken=${JSON.stringify({
                    word: wordToken.word,
                    normalizedWord: wordToken.normalizedWord,
                    rawWord: wordToken.rawWord,
                    startTimeMs: wordToken.startTimeMs,
                    endTimeMs: wordToken.endTimeMs,
                    confidence: wordToken.confidence,
                    source: wordToken.source,
                    isFinal: wordToken.isFinal,
                  })}` +
                  ` | acousticEvidence=${processed.acousticEvidence ?? "none"}` +
                  ` | rulesEvaluated=${processed.evaluated.join(",") || "none"}` +
                  ` | matchedRule=${processed.rule}` +
                  ` | verdict=${type ?? "FLUENT"}` +
                  ` | isDisfluency=${tag != null}` +
                  ` | rendererUnderline=${tag != null}`
              );

              const final: DeepgramFinalWord = {
                id: `dg-${Date.now().toString(36)}-${(dgUid++).toString(36)}`,
                word: displayWord,
                rawWord: raw,
                startTimeMs: startMs,
                endTimeMs: endMs,
                confidence: conf,
                isDisfluency: tag != null,
                disfluency: tag,
                disfluencyType: type,
              };
              finalsRef.current = [...finalsRef.current, final];
              setState((prev) => ({ ...prev, finals: finalsRef.current }));
            }
          } else {
            // INTERIM → display-only ghost + revision detection. Never tokens.
            // The detector's interim hypothesis is updated here so the
            // revision rule (E) sees the abandoned word when the final lands.
            const interim = words
              .filter((w) => w.word && w.word.trim())
              .map((w) => ({
                norm: normalizeLexicalWord(w.word!.trim())
                  .toLowerCase()
                  .replace(/[^a-z0-9']/g, ""),
                startMs: Math.round(base + (w.start ?? 0) * 1000),
              }));
            detectorRef.current?.setInterim(interim);
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

      ws.onclose = (ev: CloseEvent) => {
        // Spec §3: log the close reason — distinguishes clean session end
        // (1000) from a rejected handshake (1006 = no close frame, typically
        // an HTTP-level auth/param rejection) and server-side closes.
        console.info(
          `[DG·WS] CLOSED code=${ev.code} reason="${ev.reason || ""}" ` +
            `clean=${ev.wasClean}`
        );
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
    // The origin is captured on the PROVISIONAL axis and rebased onto the
    // pinned axis when the session clock pins (onPin listener above) — so
    // Deepgram words and acoustic events always share ONE timeline.
    if (streamStartMsRef.current == null) {
      const now = sessionClockNow();
      streamStartMsRef.current = now != null ? now * 1000 : 0;
      // ── TRANSPORT FORMAT TRACE (spec §1 + §8) — ONE line per session:
      // what is actually being transmitted (format, rate, channels, and a
      // sanity amplitude of the first chunk so a dead/zeroed mic is visible).
      let peak = 0;
      for (let i = 0; i < buffer.length; i++) {
        const a = Math.abs(buffer[i]);
        if (a > peak) peak = a;
      }
      console.info(
        `[DG·AUDIO] transmitted=PCM16 little-endian (linear16) | ` +
          `sample_rate=${actualSampleRateRef.current ?? "?"} | channels=1 | ` +
          `chunkBytes=${buffer.length * 2} | firstChunkPeak=${peak.toFixed(4)}`
      );
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
