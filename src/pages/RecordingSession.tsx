/**
 * BOLO — RecordingSession (Free Practice)
 *
 * Full speech-analysis experience:
 *   1. Pick a topic → recording starts immediately
 *   2. Mic → AudioWorklet DSP lane (frame classification) + Speechmatics live transcription
 *   3. Live rendering:
 *      - colored transcript (stutters / stammers / blocks / repetitions / prolongations / fillers)
 *      - inline pause badges with the exact time each pause took
 *      - a live detection feed (each stutter, stammer, block, pause as it fires)
 *      - live score, pace (WPM) and counters
 *   4. Stop → full SLP report on /analysis
 */

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  Square,
  BarChart3,
  Sparkles,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import Navbar from "../components/Navbar";
import TopicDrum from "../components/TopicDrum";
import TranscriptionChunks from "../components/TranscriptionChunks";
import ReactiveWaveform from "../components/ReactiveWaveform";
import SessionTimer from "../components/SessionTimer";
import { useAudioCapture } from "../hooks/useAudioCapture";
import { useSpeechmaticsWS } from "../hooks/useSpeechmaticsWS";
import {
  useAcousticAnalysis,
  type AcousticEventType,
} from "../hooks/useAcousticAnalysis";
import {
  useSessionAnalysis,
  buildTimeline,
  finalizeSessionScore,
} from "../hooks/useSessionAnalysis";
import { usePaceEngine } from "../hooks/usePaceEngine";
import { useAuth } from "../context/AuthContext";

type Phase = "topic" | "recording" | "processing";

// ─── Acoustic event display vocabulary (shared with TranscriptionChunks) ──

const ACOUSTIC_LABELS: Record<AcousticEventType, string> = {
  block: "Block",
  repetition: "Repeat",
  prolongation: "Prolong",
  stutter: "Stutter",
  stammer: "Stammer",
};

const ACOUSTIC_COLORS: Record<AcousticEventType, string> = {
  block: "#FDBA74",
  repetition: "#FCA5A5",
  prolongation: "#F9A8D4",
  stutter: "#F87171",
  stammer: "#BD8CFF",
};

interface TickerItem {
  key: string;
  t: number;
  label: string;
  durMs: number;
  color: string;
}

export default function RecordingSession() {
  const navigate = useNavigate();
  const { saveSessionData } = useAuth();

  const [phase, setPhase] = useState<Phase>("topic");
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [micFailed, setMicFailed] = useState(false);
  const finishLockRef = useRef(false);
  const resultRef = useRef<{
    score: number;
    stutters: number;
    stammers: number;
    pauses: number;
  } | null>(null);

  // ── Detection pipeline ──────────────────────────────────────────────
  const audio = useAudioCapture();
  const ws = useSpeechmaticsWS();
  const acoustic = useAcousticAnalysis(audio.getAnalyser, isRecording);
  const analysis = useSessionAnalysis(ws.transcripts, acoustic.events);
  const pace = usePaceEngine();

  // Wire PCM → Speechmatics
  useEffect(() => {
    audio.setOnAudioData(ws.sendAudio);
  }, [audio, ws.sendAudio]);

  // Pin the stutter clock the moment Speechmatics confirms it's ready
  useEffect(() => {
    if (ws.status === "connected") audio.pinClock();
  }, [ws.status, audio]);

  // Feed the shared pace engine live (words + pauses)
  useEffect(() => {
    pace.feedTranscripts(ws.transcripts);
  }, [ws.transcripts, pace]);
  useEffect(() => {
    pace.feedPauses(analysis.pauseEvents);
  }, [analysis.pauseEvents, pace]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      audio.stop();
      ws.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mic-denied detection: if the mic hasn't come up ~2.5s after start, surface it
  useEffect(() => {
    if (phase !== "recording") {
      setMicFailed(false);
      return;
    }
    const t = setTimeout(() => {
      if (!audio.isActive) setMicFailed(true);
    }, 2500);
    return () => clearTimeout(t);
  }, [phase, audio.isActive]);

  // ── Live detection feed: stutters, stammers, blocks + scoreable pauses ──
  const tickerItems = useMemo<TickerItem[]>(() => {
    const items: TickerItem[] = [];
    for (const e of acoustic.events) {
      items.push({
        key: `a-${e.startTime}-${e.type}`,
        t: e.startTime,
        label: ACOUSTIC_LABELS[e.type] ?? e.type,
        durMs: e.durationMs,
        color: ACOUSTIC_COLORS[e.type] ?? "#8B93A7",
      });
    }
    for (const p of analysis.pauseEvents) {
      if (!p.shouldColor) continue;
      items.push({
        key: `p-${p.id}`,
        t: p.startTime,
        label: p.type === "hesitation_sequence" ? "Hesitation" : "Pause",
        durMs: p.durationMs,
        color: p.colorToken,
      });
    }
    return items.sort((a, b) => a.t - b.t).slice(-16).reverse();
  }, [acoustic.events, analysis.pauseEvents]);

  // ── Start: topic selected → mic + Speechmatics immediately ──────────
  const handleTopicSelect = useCallback(
    (topic: string) => {
      setSelectedTopic(topic);
      finishLockRef.current = false;
      pace.reset();
      setPhase("recording");
      setIsRecording(true);
      audio.start();
      ws.connect();
    },
    [audio, ws, pace]
  );

  // ── Finish: capture everything, navigate to /analysis with the report ──
  const finishSession = useCallback(() => {
    if (finishLockRef.current) return;
    finishLockRef.current = true;
    setIsRecording(false);

    // Capture final data BEFORE the pipeline resets (acoustic events live in
    // a ref that clears when `active` flips false).
    const finalTranscripts = ws.snapshotTranscripts();
    const finalAcoustic = acoustic.getEvents();
    const finalScore = finalizeSessionScore(finalTranscripts, finalAcoustic);
    const paceReport = pace.finalize();
    const { taggedWords, pauseEvents } = buildTimeline(
      finalTranscripts,
      finalAcoustic
    );

    // Filler breakdown
    const fillerCounts: Record<string, number> = {};
    for (const w of taggedWords) {
      if (w.tag !== "filler") continue;
      const key = w.word.toLowerCase().replace(/[^a-z]/g, "");
      if (!key) continue;
      fillerCounts[key] = (fillerCounts[key] ?? 0) + 1;
    }
    const topFiller =
      Object.entries(fillerCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
      "none";

    // Phrase bursts — split the word stream at flagged (scoreable) pauses
    const flaggedEnds = pauseEvents
      .filter((p) => p.shouldColor)
      .map((p) => p.endTime);
    let maxBurst = 0;
    let curBurst = 0;
    let pIdx = 0;
    for (const w of taggedWords) {
      while (
        pIdx < flaggedEnds.length &&
        w.startTime >= flaggedEnds[pIdx] - 0.005
      ) {
        maxBurst = Math.max(maxBurst, curBurst);
        curBurst = 0;
        pIdx++;
      }
      curBurst++;
    }
    maxBurst = Math.max(maxBurst, curBurst);
    const burstCount = flaggedEnds.length + (taggedWords.length > 0 ? 1 : 0);
    const avgWordsPerBurst =
      burstCount > 0
        ? Math.round((taggedWords.length / burstCount) * 10) / 10
        : 0;

    const stutters = finalScore.stutters;
    const stammers = finalScore.stammers;
    const disfluentWords = taggedWords.filter((w) => w.tag).length;

    resultRef.current = {
      score: finalScore.score,
      stutters,
      stammers,
      pauses: finalScore.pauses.total,
    };

    try {
      saveSessionData(finalScore.score);
    } catch {
      // non-critical — history persistence is best-effort
    }

    setPhase("processing");

    setTimeout(() => {
      navigate("/analysis", {
        state: {
          topic: selectedTopic,
          clarityScore: Math.max(0, Math.round(100 - finalScore.clarityPenalty)),
          fluencyScore: Math.max(0, Math.round(100 - finalScore.fluencyPenalty)),
          overallScore: finalScore.score,
          totalWords: finalScore.totalWords,
          disfluentWords,
          disfluencyRate: finalScore.disfluencyRate,
          longestPhrase: maxBurst,
          avgWordsPerBurst,
          topFiller,
          fillerWords: fillerCounts,
          stutters,
          stammers,
          pauses: finalScore.pauses,
          wpm: finalScore.wpm,
          paceZone: finalScore.pace.zone,
          paceLabel: finalScore.pace.label,
          reasons: finalScore.reasons,
          paceReport,
        },
      });
    }, 900);
  }, [ws, acoustic, pace, selectedTopic, navigate, saveSessionData]);

  const handleStopRecording = useCallback(() => {
    audio.stop();
    ws.disconnect();
    finishSession();
  }, [audio, ws, finishSession]);

  const handleTimerComplete = useCallback(() => {
    audio.stop();
    ws.disconnect();
    finishSession();
  }, [audio, ws, finishSession]);

  const handleRetry = useCallback(() => {
    setMicFailed(false);
    finishLockRef.current = false;
    setPhase("topic");
    setIsRecording(false);
  }, []);

  const score = analysis.score;
  const scoreablePauses = analysis.pauseEvents.filter(
    (p) => p.shouldColor
  ).length;

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen relative overflow-hidden bg-deep-space">
      <Navbar />

      {/* ─── Ambient Background ─────────────────────────── */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-b from-deep-space via-dark-lavender/[0.08] to-deep-space" />
        <div className="absolute top-1/3 left-1/4 w-[500px] h-[500px] rounded-full bg-neon-purple/[0.04] blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-electric-violet/[0.03] blur-[100px]" />
      </div>

      {/* ─── Topic Selection Phase ──────────────────────── */}
      <AnimatePresence>
        {phase === "topic" && (
          <motion.main
            key="topic-phase"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="relative z-10 pt-28 pb-16 px-4 max-w-2xl mx-auto"
          >
            <div className="text-center mb-8">
              <button
                onClick={() => navigate("/dashboard")}
                className="inline-flex items-center gap-1.5 text-sm text-soft-gray hover:text-white transition-colors mb-6 cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to Dashboard
              </button>
              <h1 className="font-heading text-2xl md:text-3xl font-bold text-white mb-2">
                Free Practice
              </h1>
              <p className="text-sm text-soft-gray/60 max-w-md mx-auto">
                Pick a topic, then speak naturally for 60 seconds. BOLO
                transcribes live and flags every stutter, stammer and pause.
              </p>
            </div>
            <TopicDrum onSelect={handleTopicSelect} />
          </motion.main>
        )}
      </AnimatePresence>

      {/* ─── Recording Phase ────────────────────────────── */}
      <AnimatePresence>
        {phase === "recording" && (
          <motion.div
            key="recording-phase"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-20 overflow-y-auto"
          >
            {/* Glass overlay */}
            <div className="fixed inset-0 bg-deep-space/40 backdrop-blur-[2px]" />

            <div className="relative z-10 flex flex-col min-h-full pt-16 pb-8 px-4 md:px-8 max-w-3xl mx-auto">
              {/* ── Header ─────────────────────────────────── */}
              <div className="text-center mb-4">
                <div className="inline-flex items-center gap-2 glass rounded-full px-4 py-1.5 mb-3">
                  <Sparkles className="w-3 h-3 text-neon-purple" />
                  <span className="text-xs text-white/80 truncate max-w-[220px]">
                    {selectedTopic}
                  </span>
                </div>
                <h2 className="font-heading text-lg font-semibold text-white">
                  Speaking Live
                </h2>
                <p className="text-xs text-soft-gray/50 mt-1">
                  {ws.status === "connected"
                    ? "Transcribing — detection engines active"
                    : ws.status === "connecting"
                      ? "Connecting to transcription…"
                      : "Preparing microphone…"}
                </p>
              </div>

              {/* ── Error / mic banners ───────────────────── */}
              {ws.error && (
                <div className="flex items-start gap-2.5 glass rounded-xl px-4 py-3 mb-3 border border-red-400/20">
                  <AlertTriangle className="w-4 h-4 text-red-300 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-red-200 font-medium">
                      Transcription error
                    </p>
                    <p className="text-[10px] text-soft-gray/70 mt-0.5 break-words">
                      {ws.error}
                    </p>
                  </div>
                  <button
                    onClick={handleRetry}
                    className="shrink-0 flex items-center gap-1 text-[10px] px-2.5 py-1.5 glass rounded-full text-soft-gray hover:text-white transition-colors cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Retry
                  </button>
                </div>
              )}

              {micFailed && !ws.error && (
                <div className="flex items-start gap-2.5 glass rounded-xl px-4 py-3 mb-3 border border-amber-400/20">
                  <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-amber-200 font-medium">
                      Microphone not detected
                    </p>
                    <p className="text-[10px] text-soft-gray/70 mt-0.5">
                      Allow microphone access, then retry.
                    </p>
                  </div>
                  <button
                    onClick={handleRetry}
                    className="shrink-0 flex items-center gap-1 text-[10px] px-2.5 py-1.5 glass rounded-full text-soft-gray hover:text-white transition-colors cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Retry
                  </button>
                </div>
              )}

              {/* ── Live metric strip ─────────────────────── */}
              <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-3">
                <MetricChip
                  label="Score"
                  value={score.score}
                  color="#BD8CFF"
                  accent
                />
                <MetricChip
                  label="Stutters"
                  value={score.stutters}
                  color="#F87171"
                />
                <MetricChip
                  label="Stammers"
                  value={score.stammers}
                  color="#BD8CFF"
                />
                <MetricChip
                  label="Fillers"
                  value={score.fillers}
                  color="#FCD34D"
                />
                <MetricChip
                  label="Pauses"
                  value={scoreablePauses}
                  color="#60A5FA"
                />
                <MetricChip
                  label="WPM"
                  value={score.wpm > 0 ? score.wpm : "—"}
                  color="#34D399"
                />
              </div>

              {/* ── Transcription panel ───────────────────── */}
              <div className="glass rounded-2xl p-3 mb-3 relative overflow-hidden">
                <div className="flex items-center justify-between px-1 pb-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-soft-gray/50 font-medium">
                    Live Transcript
                  </span>
                  {tickerItems.length > 0 && (
                    <span className="text-[10px] text-soft-gray/40">
                      colored = detected disfluency
                    </span>
                  )}
                </div>
                <TranscriptionChunks
                  transcripts={ws.transcripts}
                  wordTags={analysis.wordTags}
                  pauseEvents={analysis.pauseEvents}
                />
              </div>

              {/* ── Live detection feed ───────────────────── */}
              <div className="glass-subtle rounded-xl px-3 py-2.5 mb-3">
                <p className="text-[10px] uppercase tracking-wider text-soft-gray/50 font-medium mb-1.5">
                  Detection Feed
                </p>
                {tickerItems.length === 0 ? (
                  <p className="text-[11px] text-soft-gray/40">
                    No disfluencies yet — keep speaking. Each stutter, stammer,
                    block and pause shows up here with its duration.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {tickerItems.map((item) => (
                      <span
                        key={item.key}
                        className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-mono select-none transition-colors duration-200"
                        style={{
                          color: item.color,
                          backgroundColor: `${item.color}18`,
                          border: `1px solid ${item.color}30`,
                        }}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: item.color }}
                        />
                        {item.label}
                        <span className="opacity-80">
                          {(item.durMs / 1000).toFixed(1)}s
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Waveform ──────────────────────────────── */}
              <div className="h-14 mb-4">
                <ReactiveWaveform
                  getAnalyser={audio.getAnalyser}
                  isActive={audio.isActive}
                  className="w-full h-full"
                />
              </div>

              {/* ── Timer + Stop ──────────────────────────── */}
              <div className="flex flex-col items-center gap-3 pb-4">
                <SessionTimer
                  duration={60}
                  isRunning={isRecording}
                  onComplete={handleTimerComplete}
                />
                {isRecording ? (
                  <motion.button
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={handleStopRecording}
                    className="flex items-center gap-2.5 bg-destructive hover:bg-red-600 text-white text-sm font-medium px-8 py-4 rounded-full transition-all duration-200 shadow-[0_0_25px_rgba(255,80,80,0.35)] cursor-pointer"
                  >
                    <Square className="w-4 h-4 fill-white" />
                    Stop Recording
                  </motion.button>
                ) : (
                  <div className="flex items-center gap-2.5 text-sm text-soft-gray/50">
                    <div className="flex gap-1">
                      <div
                        className="w-2 h-2 rounded-full bg-neon-purple animate-bounce"
                        style={{ animationDelay: "0ms" }}
                      />
                      <div
                        className="w-2 h-2 rounded-full bg-neon-purple animate-bounce"
                        style={{ animationDelay: "150ms" }}
                      />
                      <div
                        className="w-2 h-2 rounded-full bg-neon-purple animate-bounce"
                        style={{ animationDelay: "300ms" }}
                      />
                    </div>
                    Connecting to microphone…
                  </div>
                )}
                <div className="flex items-center gap-1.5 text-[10px] text-soft-gray/40">
                  <GaugeDot color="#34D399" />
                  {score.pace.label}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Processing Phase ────────────────────────────── */}
      <AnimatePresence>
        {phase === "processing" && (
          <motion.div
            key="processing-phase"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-30 flex items-center justify-center"
          >
            {/* Ambient background */}
            <div className="absolute inset-0 bg-deep-space/90 backdrop-blur-md" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-gradient-to-br from-electric-violet/[0.08] to-neon-purple/[0.05] blur-[120px] animate-pulse-glow" />

            <div className="relative z-10 text-center px-4">
              {/* Animated orb */}
              <motion.div
                className="relative w-24 h-24 mx-auto mb-6"
                animate={{
                  scale: [1, 1.08, 1],
                  rotate: [0, 5, -5, 0],
                }}
                transition={{
                  duration: 3,
                  ease: "easeInOut",
                  repeat: Infinity,
                }}
              >
                <div className="absolute inset-0 rounded-full bg-gradient-to-br from-electric-violet to-neon-purple opacity-30 blur-xl animate-pulse" />
                <div className="absolute inset-2 rounded-full bg-gradient-to-br from-electric-violet to-neon-purple flex items-center justify-center">
                  <BarChart3 className="w-10 h-10 text-white" />
                </div>
              </motion.div>

              <h2 className="font-heading text-xl font-bold text-white mb-2">
                Building Your SLP Report
              </h2>
              <p className="text-sm text-soft-gray/60 max-w-xs mx-auto">
                {resultRef.current
                  ? `${resultRef.current.stutters} stutters · ${resultRef.current.stammers} stammers · ${resultRef.current.pauses} pauses detected — scoring fluency, pace and clarity…`
                  : "Scoring fluency, pace and clarity…"}
              </p>

              {/* Progress bar */}
              <div className="flex justify-center mt-6">
                <div className="w-48 h-1.5 rounded-full bg-white/5 overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-gradient-to-r from-electric-violet to-neon-purple"
                    initial={{ width: "0%" }}
                    animate={{ width: "100%" }}
                    transition={{ duration: 0.85, ease: "easeOut" }}
                  />
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Live metric chip ──────────────────────────────────────────────────

function MetricChip({
  label,
  value,
  color,
  accent = false,
}: {
  label: string;
  value: string | number;
  color: string;
  accent?: boolean;
}) {
  return (
    <div
      className="glass-subtle rounded-xl px-2 py-2 text-center"
      style={
        accent
          ? { border: `1px solid ${color}30`, background: `${color}0d` }
          : undefined
      }
    >
      <p
        className="text-base font-heading font-bold leading-none tabular-nums"
        style={{ color }}
      >
        {value}
      </p>
      <p className="text-[9px] text-soft-gray/50 mt-1 uppercase tracking-wide">
        {label}
      </p>
    </div>
  );
}

// ─── Small colored dot (pace label) ────────────────────────────────────

function GaugeDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}
