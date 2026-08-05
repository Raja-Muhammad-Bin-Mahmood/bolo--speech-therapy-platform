import { useState, useRef, useCallback, useEffect } from "react";
import { supabase, SUPABASE_URL } from "../lib/supabase";

// ─── Types ──────────────────────────────────────────────────────────────

export interface SpeechEvent {
  type: "recognition" | "transcript" | "disfluency" | "end-of-stream" | "error";
  data?: string;
  startTime?: number;
  duration?: number;
  /** The raw word-level transcription array */
  words?: SpeechWord[];
}

export interface SpeechWord {
  word: string;
  startTime: number;
  duration: number;
  confidence?: number;
  /** Speechmatics may flag disfluent words at the API level */
  disfluency?: boolean;
}

export interface DisfluencyEvent {
  type: "repetition" | "prolongation" | "silent_block" | "interjection";
  word?: string;
  startTime: number;
  duration: number;
}

/** A styled segment for inline rendering */
export interface StyledSegment {
  id: string;
  text: string;
  kind: "filler" | "repetition" | "tonic_block" | "prolongation" | "clean" | "listening";
  /** Typographic symbol prepended (e.g. ⟳, !, •) */
  symbol?: string;
  /** Prefix text (e.g. "s-s-" for repetition) */
  prefix?: string;
  /** Word start time in stream-seconds */
  startTime?: number;
}

export interface SpeechRecognitionState {
  isListening: boolean;
  /** Plain-text transcript (for backward compat) */
  transcript: string;
  /** Plain-text interim (for backward compat) */
  interimTranscript: string;
  /** Styled segments — the source of truth for UI rendering */
  segments: StyledSegment[];
  disfluencyLog: DisfluencyEvent[];
  words: SpeechWord[];
  error: string | null;
  isSupported: boolean;
}

// ─── Speechmatics Constants ─────────────────────────────────────────────

const WS_URL = "wss://eu2.rt.speechmatics.com/v2/en";
const SAMPLE_RATE = 16000;
const INTERJECTIONS = new Set(["um", "uh", "ah", "er", "hmm", "like", "you know", "sort of", "kind of"]);

/** How often (in ms) to flush buffered audio to the WebSocket */
const FLUSH_INTERVAL_MS = 200;

/** Monitor the AnalyserNode at this rate (ms) */
const ANALYSER_INTERVAL_MS = 60;

/** RMS threshold below which we consider audio "quiet" (silence) */
const RMS_THRESHOLD = 0.03;

/** RMS threshold for "strong voicing" (prolongation / block) */
const STRONG_VOICING_THRESHOLD = 0.10;

/** Gap in ms without a word, combined with audio energy, triggers tonic-block arm */
const GAP_ARM_MS = 500;

/** Continuous strong voicing in ms before prolongation is armed */
const PROLONGATION_ARM_MS = 800;

// ─── Helpers ────────────────────────────────────────────────────────────

let segmentCounter = 0;
function nextSegmentId(): string {
  return `seg-${++segmentCounter}-${Date.now()}`;
}

function createSegment(
  text: string,
  kind: StyledSegment["kind"],
  symbol?: string,
  prefix?: string,
  startTime?: number
): StyledSegment {
  return { id: nextSegmentId(), text, kind, symbol, prefix, startTime };
}

// ─── Helper: fetch a temporary Speechmatics JWT via Supabase Edge Function ─

async function fetchSpeechmaticsToken(): Promise<string> {
  console.log("Fetching Speechmatics temp JWT from edge function...");

  // Local/demo mode has no Supabase session, so omit the Authorization
  // header entirely instead of sending "Bearer undefined" — the edge
  // function is intentionally open to unauthenticated callers.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  }

  const res = await fetch(`${SUPABASE_URL}/functions/v1/speechmatics-token`, {
    method: "POST",
    headers,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token fetch failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const token = data?.token;
  console.log("Fetched temporary JWT:", token ? "SUCCESS" : "FAILED");
  if (!token) throw new Error("No token in edge function response");
  return token;
}

// ─── Compute RMS from a Float32Array ────────────────────────────────────

function computeRms(samples: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSq += samples[i] * samples[i];
  }
  return Math.sqrt(sumSq / samples.length);
}

// ─── Hook ───────────────────────────────────────────────────────────────

export function useSpeechRecognition() {
  const [state, setState] = useState<SpeechRecognitionState>({
    isListening: false,
    transcript: "",
    interimTranscript: "",
    segments: [],
    disfluencyLog: [],
    words: [],
    error: null,
    isSupported: true,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analyserTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioBuffersRef = useRef<ArrayBuffer[]>([]);
  const seqNoRef = useRef(0);

  // Refs tracking semantic state (not re-render-driven)
  const transcriptRef = useRef("");
  const disfluencyLogRef = useRef<DisfluencyEvent[]>([]);
  const wordsRef = useRef<SpeechWord[]>([]);
  const segmentsRef = useRef<StyledSegment[]>([]);

  // Disfluency detector state (refs to avoid re-render loops)
  const lastWordTimeRef = useRef<number | null>(null);
  const listeningDotActiveRef = useRef(false);
  const voicedStartRef = useRef<number | null>(null);
  const prolongationArmedRef = useRef(false);

  // ─── Sync state to React ─────────────────────────────────────────────

  function syncState(overrides?: Partial<SpeechRecognitionState>) {
    setState((prev) => ({
      ...prev,
      transcript: transcriptRef.current,
      segments: [...segmentsRef.current],
      disfluencyLog: [...disfluencyLogRef.current],
      words: [...wordsRef.current],
      ...overrides,
    }));
  }

  // ─── Detect browser Audio support ────────────────────────────────────

  useEffect(() => {
    const hasUserMedia = !!navigator.mediaDevices?.getUserMedia;
    const hasAudioContext = !!(window.AudioContext || (window as any).webkitAudioContext);
    if (!hasUserMedia || !hasAudioContext) {
      setState((s) => ({
        ...s,
        isSupported: false,
        error: "Audio capture not available in this browser.",
      }));
    }
  }, []);

  // ─── Analyser monitor ────────────────────────────────────────────────

  function startAnalyserMonitor() {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const floatBuffer = new Float32Array(analyser.fftSize);

    analyserTimerRef.current = setInterval(() => {
      const now = Date.now();

      // Get time-domain data for RMS
      analyser.getFloatTimeDomainData(floatBuffer);
      const rms = computeRms(floatBuffer);

      // Get frequency data for band-specific analysis
      analyser.getByteFrequencyData(dataArray);

      // High-band energy indicator (rough proxy for tension / effort)
      const halfBinCount = analyser.frequencyBinCount >> 1;
      let highSum = 0;
      for (let i = halfBinCount; i < analyser.frequencyBinCount; i++) {
        highSum += dataArray[i];
      }
      const highAvg = highSum / (analyser.frequencyBinCount - halfBinCount) / 255;

      // ── Gap / tonic-block detection ─────────────────────────────────
      // Conditions: no word for > 500ms AND audio RMS above threshold (speaker
      // is trying but stuck), OR high-band energy suggests tension.
      const gapCondition =
        rms > RMS_THRESHOLD || highAvg > 0.15;

      if (
        lastWordTimeRef.current !== null &&
        gapCondition &&
        now - lastWordTimeRef.current > GAP_ARM_MS
      ) {
        if (!listeningDotActiveRef.current) {
          listeningDotActiveRef.current = true;
          segmentsRef.current = [
            ...segmentsRef.current,
            createSegment("•", "listening", "•"),
          ];
          syncState({ interimTranscript: "…" });
        }
      } else if (!gapCondition && listeningDotActiveRef.current) {
        // Ambient silence ended without a word — maybe it was a false alarm
        // Keep the dot until the next word resolves the state.
      }

      // ── Prolongation detection ─────────────────────────────────────
      // Sustained strong voicing (RMS > threshold) for > 800ms
      if (rms > STRONG_VOICING_THRESHOLD) {
        if (voicedStartRef.current === null) {
          voicedStartRef.current = now;
        } else if (
          now - voicedStartRef.current > PROLONGATION_ARM_MS &&
          !prolongationArmedRef.current
        ) {
          prolongationArmedRef.current = true;
        }
      } else {
        voicedStartRef.current = null;
      }
    }, ANALYSER_INTERVAL_MS);
  }

  // ─── Add a word to segments ──────────────────────────────────────────

  function addWordSegment(
    word: string,
    startTime: number,
    apiDisfluency?: boolean
  ) {
    const now = Date.now();
    const lower = word.toLowerCase();

    // Resolve pending prolongation
    if (prolongationArmedRef.current) {
      prolongationArmedRef.current = false;
      voicedStartRef.current = null;
      // Remove last listening dot if present
      if (listeningDotActiveRef.current) {
        listeningDotActiveRef.current = false;
        segmentsRef.current = segmentsRef.current.filter(
          (s) => s.kind !== "listening"
        );
      }
      segmentsRef.current = [
        ...segmentsRef.current,
        createSegment(word, "prolongation", undefined, undefined, startTime),
      ];
      transcriptRef.current += (transcriptRef.current ? " " : "") + word;
      syncState({ interimTranscript: "" });
      lastWordTimeRef.current = now;
      return;
    }

    // Resolve pending tonic block
    if (listeningDotActiveRef.current) {
      listeningDotActiveRef.current = false;
      // Remove the listening dot segment
      segmentsRef.current = segmentsRef.current.filter(
        (s) => s.kind !== "listening"
      );
      segmentsRef.current = [
        ...segmentsRef.current,
        createSegment(word, "tonic_block", "!", undefined, startTime),
      ];
      transcriptRef.current += (transcriptRef.current ? " " : "") + word;
      syncState({ interimTranscript: "" });
      lastWordTimeRef.current = now;
      return;
    }

    // Filler detection (API flag OR known interjection)
    const isFiller = apiDisfluency === true || INTERJECTIONS.has(lower);

    if (isFiller) {
      segmentsRef.current = [
        ...segmentsRef.current,
        createSegment(word, "filler", "⟳", undefined, startTime),
      ];
    } else {
      // Repetition check (word repeated 2+ times in a row in recent context)
      const recentClean = segmentsRef.current
        .filter((s) => s.kind === "clean" || s.kind === "repetition")
        .slice(-4);
      const repeated = recentClean.filter(
        (s) => s.text.toLowerCase() === lower
      ).length;

      if (repeated >= 2) {
        segmentsRef.current = [
          ...segmentsRef.current,
          createSegment(
            word,
            "repetition",
            undefined,
            word.slice(0, 2).toLowerCase() + "-",
            startTime
          ),
        ];
      } else {
        segmentsRef.current = [
          ...segmentsRef.current,
          createSegment(word, "clean", undefined, undefined, startTime),
        ];
      }
    }

    transcriptRef.current += (transcriptRef.current ? " " : "") + word;
    syncState({ interimTranscript: "" });
    lastWordTimeRef.current = now;
  }

  // ─── Core start ──────────────────────────────────────────────────────

  const startListening = useCallback(async () => {
    try {
      setState((s) => ({ ...s, isListening: true, error: null }));

      // Reset refs
      transcriptRef.current = "";
      disfluencyLogRef.current = [];
      wordsRef.current = [];
      segmentsRef.current = [];
      lastWordTimeRef.current = null;
      listeningDotActiveRef.current = false;
      voicedStartRef.current = null;
      prolongationArmedRef.current = false;
      audioBuffersRef.current = [];
      seqNoRef.current = 0;

      // 1. Fetch temporary token
      const token = await fetchSpeechmaticsToken();

      // 2. Open WebSocket
      const ws = new WebSocket(`${WS_URL}?jwt=${token}`);

      ws.onopen = () => {
        // Send StartRecognition message with EXACT config
        const startMsg = JSON.stringify({
          message: "StartRecognition",
          audio_format: {
            type: "raw",
            encoding: "pcm_s16le",
            sample_rate: SAMPLE_RATE,
          },
          transcription_config: {
            language: "en",
            max_delay: 0.7,
            enable_partials: true,
            operating_point: "enhanced",
          },
          transcript_filtering_config: {
            remove_disfluencies: false,
          },
        });
        ws.send(startMsg);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          switch (msg.message) {
            case "AddTranscript": {
              // Final transcript
              const results = msg.results || [];
              const text = results
                .map((r: any) => r.alternatives?.[0]?.content || "")
                .filter(Boolean)
                .join(" ");

              // Process each word individually for fine-grained styling
              const newWords: SpeechWord[] = [];
              for (const result of results) {
                const alt = result.alternatives?.[0];
                if (alt?.words) {
                  for (const w of alt.words) {
                    const word: SpeechWord = {
                      word: w.content,
                      startTime: w.start_time ?? performance.now(),
                      duration: (w.end_time ?? w.start_time ?? 0) - (w.start_time ?? 0) || 0.3,
                      confidence: w.confidence,
                      disfluency: w.disfluency === true,
                    };
                    newWords.push(word);

                    // Add styled segment for each word
                    addWordSegment(
                      w.content,
                      w.start_time ?? 0,
                      w.disfluency === true
                    );
                  }
                }
              }
              wordsRef.current = [...wordsRef.current, ...newWords];

              // Client-side disfluency events (for report compat)
              const newDisfluencies = detectDisfluencies(text);
              disfluencyLogRef.current = [
                ...disfluencyLogRef.current,
                ...newDisfluencies,
              ];

              syncState({ interimTranscript: "" });
              break;
            }

            case "AddPartialTranscript": {
              // Interim / partial transcript
              const partial =
                msg.results
                  ?.map((r: any) => r.alternatives?.[0]?.content || "")
                  .filter(Boolean)
                  .join(" ") || "";

              setState((prev) => ({
                ...prev,
                interimTranscript: partial,
              }));
              break;
            }

            case "EndOfTranscript": {
              break;
            }

            case "AudioAdded": {
              break;
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onerror = () => {
        setState((s) => ({ ...s, error: "WebSocket connection error" }));
      };

      ws.onclose = (event) => {
        if (event.code !== 1000) {
          setState((s) => ({
            ...s,
            error: `Connection closed (${event.code})`,
          }));
        }
      };

      wsRef.current = ws;

      // 3. Start mic capture
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 4. Create unified audio pipeline: mic → analyser → processor → buffers
      const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.85;
      source.connect(analyser);
      analyserRef.current = analyser;

      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      analyser.connect(processor);
      processor.connect(audioCtx.destination);

      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        const input = e.inputBuffer.getChannelData(0);
        // Convert Float32 → PCM S16LE
        const pcm16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        audioBuffersRef.current.push(pcm16.buffer);
      };

      // 5. Start analyser monitor for gap/prolongation detection
      startAnalyserMonitor();

      // 6. Flush audio buffers on an interval
      flushTimerRef.current = setInterval(() => {
        const buffers = audioBuffersRef.current;
        audioBuffersRef.current = [];

        if (buffers.length === 0) return;
        if (ws.readyState !== WebSocket.OPEN) return;

        // Concatenate all buffers
        const totalLen = buffers.reduce((acc, b) => acc + b.byteLength, 0);
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const buf of buffers) {
          merged.set(new Uint8Array(buf), offset);
          offset += buf.byteLength;
        }

        seqNoRef.current += 1;
        ws.send(merged);
      }, FLUSH_INTERVAL_MS);
    } catch (err: any) {
      setState((s) => ({
        ...s,
        isListening: false,
        error: err.message || "Failed to start recording",
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Stop ────────────────────────────────────────────────────────────

  const stopListening = useCallback(() => {
    // Stop analyser monitor
    if (analyserTimerRef.current) {
      clearInterval(analyserTimerRef.current);
      analyserTimerRef.current = null;
    }

    // Stop audio processor & context
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    analyserRef.current = null;

    // Stop mic tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    // Clear flush timer
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    // Send EndOfStream over WebSocket
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          message: "EndOfStream",
          last_seq_no: seqNoRef.current,
        })
      );

      // Give it a moment to process, then close
      setTimeout(() => {
        ws.close(1000);
      }, 1000);
    }

    wsRef.current = null;
    seqNoRef.current = 0;

    // Clean up any lingering listening dot
    if (listeningDotActiveRef.current) {
      listeningDotActiveRef.current = false;
      segmentsRef.current = segmentsRef.current.filter(
        (s) => s.kind !== "listening"
      );
    }

    setState((s) => ({
      ...s,
      isListening: false,
      interimTranscript: "",
      segments: [...segmentsRef.current],
    }));
  }, []);

  // ─── Reset ───────────────────────────────────────────────────────────

  const resetTranscript = useCallback(() => {
    transcriptRef.current = "";
    disfluencyLogRef.current = [];
    wordsRef.current = [];
    segmentsRef.current = [];
    lastWordTimeRef.current = null;
    listeningDotActiveRef.current = false;
    voicedStartRef.current = null;
    prolongationArmedRef.current = false;
    setState((s) => ({
      ...s,
      transcript: "",
      interimTranscript: "",
      segments: [],
      disfluencyLog: [],
      words: [],
    }));
  }, []);

  // ─── Cleanup on unmount ──────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (analyserTimerRef.current) clearInterval(analyserTimerRef.current);
      if (audioCtxRef.current) audioCtxRef.current.close();
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
      if (wsRef.current) wsRef.current.close(1000);
    };
  }, []);

  return {
    ...state,
    startListening,
    stopListening,
    resetTranscript,
  };
}

// ─── Disfluency Detection (client-side, for legacy report compat) ──────

function detectDisfluencies(text: string): DisfluencyEvent[] {
  const events: DisfluencyEvent[] = [];
  const lower = text.toLowerCase();
  const now = performance.now();

  // Interjections
  INTERJECTIONS.forEach((interj) => {
    const idx = lower.indexOf(interj);
    if (idx !== -1) {
      events.push({
        type: "interjection",
        word: interj,
        startTime: now,
        duration: 0.3,
      });
    }
  });

  // Repetitions (same word 3+ times consecutively)
  const wordList = text.split(/\s+/);
  for (let i = 2; i < wordList.length; i++) {
    if (
      wordList[i].toLowerCase() === wordList[i - 1].toLowerCase() &&
      wordList[i].toLowerCase() === wordList[i - 2].toLowerCase()
    ) {
      events.push({
        type: "repetition",
        word: wordList[i],
        startTime: now,
        duration: 0.4,
      });
      break;
    }
  }

  // Prolongations (word with 3+ same consecutive letters like "soooo")
  for (const w of wordList) {
    const clean = w.toLowerCase().replace(/[^a-z]/g, "");
    for (let i = 2; i < clean.length; i++) {
      if (clean[i] === clean[i - 1] && clean[i] === clean[i - 2]) {
        events.push({
          type: "prolongation",
          word: w,
          startTime: now,
          duration: 0.5,
        });
        break;
      }
    }
  }

  return events;
}