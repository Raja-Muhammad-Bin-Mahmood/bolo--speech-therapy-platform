import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Square, Sparkles, BarChart3, Gauge } from "lucide-react";
import Navbar from "../components/Navbar";
import TopicDrum from "../components/TopicDrum";
import ReactiveWaveform from "../components/ReactiveWaveform";
import CountdownTimer from "../components/CountdownTimer";
import PaceMeter from "../components/PaceMeter";
import TranscriptionChunks from "../components/TranscriptionChunks";
import { useAudioCapture } from "../hooks/useAudioCapture";
import { useSpeechmaticsWS } from "../hooks/useSpeechmaticsWS";
import { useAcousticAnalysis } from "../hooks/useAcousticAnalysis";
import { useSessionAnalysis, finalizeSessionScore } from "../hooks/useSessionAnalysis";
import { usePaceEngine, usePaceSnapshot } from "../hooks/usePaceEngine";
import { useStutterEngine } from "../hooks/useStutterEngine";
import { fuseStutterEvents, summarizeStutterEvents } from "../lib/stutterFusion";
import { useAuth } from "../context/AuthContext";
import type { StutterEvent } from "../lib/stutterTypes";

const FILLER_WORDS = [
  "um", "uh", "ah", "er", "hmm", "like", "you know", "sort of",
  "kind of", "actually", "basically", "literally", "i mean",
  "you see", "well", "so yeah", "right", "okay", "anyway",
];

type Phase = "topic" | "recording" | "processing";

export default function RecordingSession() {
  const navigate = useNavigate();
  const { saveSessionData } = useAuth();

  const [phase, setPhase] = useState<Phase>("topic");
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [timerRunning, setTimerRunning] = useState(false);
  const analysisLockRef = useRef(false);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      audio.stop();
      ws.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const audio = useAudioCapture();
  const ws = useSpeechmaticsWS();

  // Acoustic analysis layer (parallel to ASR)
  const { events: acousticEvents } = useAcousticAnalysis(
    audio.getAnalyser,
    phase === "recording" && audio.isActive
  );

  // Fusion + shared scoring (live)
  const { wordTags, pauseEvents } = useSessionAnalysis(ws.transcripts, acousticEvents);

  // Stutter engine (AudioWorklet DSP → conservative fusion)
  const stutter = useStutterEngine(
    ws.transcripts,
    audio.stutterCandidates,
    phase === "recording" && audio.isActive
  );

  // Align the acoustic clock to the ASR lane once Speechmatics is connected
  useEffect(() => {
    if (ws.status === "connected") audio.pinClock();
  }, [ws.status, audio]);

  // Shared Pace Engine
  const { engine, feedTranscripts, feedPauses, finalize: finalizePace } = usePaceEngine();
  const paceSnapshot = usePaceSnapshot(engine);

  // Feed the engine whenever transcripts or pauses update
  useEffect(() => {
    if (phase !== "recording") return;
    feedTranscripts(ws.transcripts);
  }, [ws.transcripts, phase, feedTranscripts]);

  useEffect(() => {
    if (phase !== "recording") return;
    feedPauses(pauseEvents);
  }, [pauseEvents, phase, feedPauses]);

  // ── Topic selected → start recording immediately ────────────────
  const handleTopicSelect = useCallback(
    (topic: string) => {
      setSelectedTopic(topic);
      setPhase("recording");
      audio.start();
      ws.connect();
      setTimerRunning(true);
    },
    [audio, ws]
  );

  // Wire audio capture → WebSocket
  useEffect(() => {
    audio.setOnAudioData(ws.sendAudio);
  }, [audio, ws.sendAudio]);

  // ── Run final analysis (shared between timer-complete and manual stop) ──
  const runAnalysis = useCallback(() => {
    // Stop the mic FIRST — no more audio means no more Speechmatics credits.
    audio.stop();

    // Disconnect the WebSocket immediately — no grace period waste.
    const finals = ws.snapshotTranscripts();
    ws.disconnect();

    // Snapshot stutter candidates before they're cleared
    const stutterSnapshot = audio.getStutterCandidates();
    finalizePace();

    // Build the analysis result
    const paceReport = finalizePace();
    const score = finalizeSessionScore(finals, acousticEvents);

    const allWords = finals
      .filter((t) => t.isFinal)
      .flatMap((t) => t.words)
      .map((w: any) => w.word || w.text || "")
      .filter(Boolean);

    const fillerMap: Record<string, number> = {};
    for (const w of allWords) {
      const clean = w.toLowerCase().replace(/[^a-z]/g, "");
      if (FILLER_WORDS.includes(clean)) {
        fillerMap[clean] = (fillerMap[clean] || 0) + 1;
      }
    }

    let longestPhrase = 0;
    let currentPhrase = 0;
    const bursts: number[] = [];
    let currentBurst = 0;
    for (const w of allWords) {
      const clean = w.toLowerCase().replace(/[^a-z]/g, "");
      const isFiller = FILLER_WORDS.includes(clean);
      if (!isFiller) {
        currentPhrase++;
        currentBurst++;
        longestPhrase = Math.max(longestPhrase, currentPhrase);
      } else {
        currentPhrase = 0;
        if (currentBurst > 0) { bursts.push(currentBurst); currentBurst = 0; }
      }
    }
    if (currentBurst > 0) bursts.push(currentBurst);
    const avgWordsPerBurst =
      bursts.length > 0
        ? Math.round(bursts.reduce((a, b) => a + b, 0) / bursts.length)
        : 0;

    // Stutter review data
    const finalWords = finals
      .filter((t) => t.isFinal)
      .flatMap((t) => t.words)
      .map((w: any) => ({
        text: w.word || w.text || "",
        startTime: w.startTime,
        endTime: w.endTime,
        confidence: w.confidence ?? 0.9,
      }))
      .filter((w) => w.text.length > 0);
    const fusedStutter = fuseStutterEvents({
      candidates: stutterSnapshot,
      words: finalWords,
    });
    const stutterEvents: StutterEvent[] = fusedStutter.events;
    const stutterSummary = summarizeStutterEvents(stutterEvents, finalWords);

    const result = {
      clarityScore: Math.round(100 - score.fluencyPenalty - score.clarityPenalty),
      fluencyScore: Math.round(100 - score.pacingPenalty),
      totalWords: score.totalWords,
      disfluentWords:
        score.fillers +
        score.blocks +
        score.repetitions +
        score.prolongations +
        score.stutters +
        score.stammers,
      disfluencyRate: score.disfluencyRate,
      longestPhrase,
      avgWordsPerBurst,
      fillerWords: fillerMap,
      topFiller:
        Object.keys(fillerMap).length > 0
          ? Object.entries(fillerMap).sort((a, b) => b[1] - a[1])[0][0]
          : "none",
      overallScore: score.score,
      blocks: score.blocks,
      repetitions: score.repetitions,
      prolongations: score.prolongations,
      stutters: score.stutters,
      stammers: score.stammers,
      wpm: score.wpm,
      avgConfidence: score.avgConfidence,
      paceZone: score.pace.zone,
      paceTrend: score.pace.trend,
      paceLabel: score.pace.label,
      reasons: score.reasons,
      pauses: score.pauses,
      paceReport: {
        finalWpm: paceReport.totalWpm,
        rollingWpm: paceReport.finalSnapshot.rollingWpm,
        currentWpm: paceReport.finalSnapshot.currentWpm,
        clarity: paceReport.clarityScore,
        paceState: paceReport.finalSnapshot.paceState,
        trend: paceReport.trend,
        pauseSummary: paceReport.pauseSummary,
        averageClarity: paceReport.averageClarity,
        pacingConsistency: paceReport.pacingConsistency,
        labels: paceReport.labels,
        explanation: paceReport.explanation,
      },
      stutterEvents,
      stutterSummary,
    };

    saveSessionData(result.clarityScore);

    setTimeout(() => {
      navigate("/analysis", {
        state: { topic: selectedTopic, ...result },
      });
    }, 800);
  }, [audio, ws, selectedTopic, navigate, saveSessionData, acousticEvents, finalizePace]);

  // ── Timer complete → end recording ─────────────────────────────────
  const handleTimerComplete = useCallback(() => {
    if (analysisLockRef.current) return;
    analysisLockRef.current = true;
    setTimerRunning(false);
    setPhase("processing");
    runAnalysis();
  }, [runAnalysis]);

  // ── Manual stop ────────────────────────────────────────────────────
  const handleStopRecording = useCallback(() => {
    if (analysisLockRef.current) return;
    analysisLockRef.current = true;
    setTimerRunning(false);
    setPhase("processing");
    runAnalysis();
  }, [runAnalysis]);

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="min-h-screen relative overflow-hidden bg-deep-space">
      <Navbar />

      {/* ─── Ambient Background ─────────────────────────── */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-b from-deep-space via-dark-lavender/[0.08] to-deep-space" />
        <div className="absolute top-1/3 left-1/4 w-[500px] h-[500px] rounded-full bg-neon-purple/[0.04] blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-electric-violet/[0.03] blur-[100px]" />
        {/* Grain particles */}
        {Array.from({ length: 30 }).map((_, i) => (
          <div
            key={i}
            className="grain-particle"
            style={{
              width: `${2 + Math.random() * 4}px`,
              height: `${2 + Math.random() * 4}px`,
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              opacity: 0.15 + Math.random() * 0.2,
              animationDelay: `${Math.random() * 15}s`,
              animationDuration: `${12 + Math.random() * 18}s`,
            }}
          />
        ))}
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
                New Recording Session
              </h1>
              <p className="text-sm text-soft-gray/60 max-w-md mx-auto">
                Pull the lever to pick a topic, then start speaking.
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
            className="fixed inset-0 z-20"
          >
            {/* Glass overlay */}
            <div className="absolute inset-0 bg-deep-space/40 backdrop-blur-[2px]" />

            <div className="relative z-10 flex h-full pt-20 pb-6 px-4 md:px-8 max-w-7xl mx-auto gap-6">
              {/* ── Left Sidebar: Timer + Pace + Stats ──────────────── */}
              <div className="hidden md:flex flex-col gap-6 w-[220px] shrink-0 pt-8">
                {/* Topic badge */}
                <div className="glass rounded-2xl px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5 text-neon-purple" />
                    <span className="text-xs font-medium text-white truncate">{selectedTopic}</span>
                  </div>
                </div>

                {/* Timer */}
                <div className="glass rounded-2xl p-5 flex flex-col items-center">
                  <CountdownTimer
                    duration={60}
                    isRunning={timerRunning}
                    onComplete={handleTimerComplete}
                  />
                </div>

                {/* Pace meter (compact) */}
                <div className="glass rounded-2xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Gauge className="w-3.5 h-3.5 text-neon-purple" />
                    <span className="text-[10px] font-medium text-soft-gray uppercase tracking-wider">
                      Pace
                    </span>
                  </div>
                  <PaceMeter
                    snapshot={paceSnapshot}
                    variant="compact"
                  />
                </div>

                {/* Clarity snapshot */}
                {paceSnapshot.clarityScore > 0 && (
                  <div className="glass rounded-2xl p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-medium text-soft-gray uppercase tracking-wider">
                        Clarity
                      </span>
                      <span
                        className="font-heading text-xl font-bold tabular-nums"
                        style={{
                          color:
                            paceSnapshot.clarityScore >= 80
                              ? "#34D399"
                              : paceSnapshot.clarityScore >= 60
                                ? "#FBBF24"
                                : "#F87171",
                        }}
                      >
                        {paceSnapshot.clarityScore}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Mobile sidebar (compact horizontal strip) ───────── */}
              <div className="flex md:hidden items-center gap-3 absolute top-20 left-4 right-4">
                <div className="glass rounded-full px-3 py-1.5 flex items-center gap-1.5 shrink-0">
                  <Sparkles className="w-3 h-3 text-neon-purple" />
                  <span className="text-[10px] font-medium text-white truncate max-w-[120px]">
                    {selectedTopic}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <PaceMeter snapshot={paceSnapshot} variant="compact" />
                </div>
              </div>

              {/* ── Main Content ────────────────────────────────────── */}
              <div className="flex-1 flex flex-col min-w-0 pt-4 md:pt-8 gap-5">
                {/* Waveform */}
                <div className="glass rounded-2xl px-6 py-4">
                  <ReactiveWaveform
                    getAnalyser={audio.getAnalyser}
                    isActive={audio.isActive}
                    className="w-full h-20 md:h-24"
                  />
                </div>

                {/* Mobile timer + clarity row */}
                <div className="flex md:hidden items-center justify-between gap-3">
                  <CountdownTimer
                    duration={60}
                    isRunning={timerRunning}
                    onComplete={handleTimerComplete}
                  />
                  {paceSnapshot.clarityScore > 0 && (
                    <div className="glass rounded-2xl px-4 py-3">
                      <div className="text-[10px] text-soft-gray/50 uppercase tracking-wider mb-0.5">
                        Clarity
                      </div>
                      <span
                        className="font-heading text-2xl font-bold tabular-nums"
                        style={{
                          color:
                            paceSnapshot.clarityScore >= 80
                              ? "#34D399"
                              : paceSnapshot.clarityScore >= 60
                                ? "#FBBF24"
                                : "#F87171",
                        }}
                      >
                        {paceSnapshot.clarityScore}
                      </span>
                    </div>
                  )}
                </div>

                {/* Transcription */}
                <div className="flex-1 glass rounded-2xl p-4 overflow-hidden flex flex-col min-h-0">
                  <div className="text-[10px] text-soft-gray/40 uppercase tracking-wider mb-2 px-1">
                    Live Transcription
                  </div>
                  <div className="flex-1 overflow-hidden">
                    {ws.status === "error" ? (
                      <div className="flex items-center justify-center h-full">
                        <div className="text-center">
                          <p className="text-xs text-destructive/80 mb-1">Connection error</p>
                          <p className="text-[10px] text-soft-gray/40">
                            {ws.error || "Unable to connect to transcription service"}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <TranscriptionChunks
                        transcripts={ws.transcripts}
                        wordTags={wordTags}
                        pauseEvents={pauseEvents}
                        stutterEvents={stutter.events}
                      />
                    )}
                  </div>
                </div>

                {/* ── Stop Button ───────────────────────────────────── */}
                <div className="flex justify-center pb-2">
                  {audio.isActive ? (
                    <motion.button
                      initial={{ scale: 0.9, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={handleStopRecording}
                      className="flex items-center gap-2.5 bg-destructive hover:bg-red-600 text-white text-sm font-medium px-7 py-3.5 rounded-full transition-all duration-200 shadow-[0_0_25px_rgba(255,80,80,0.35)] cursor-pointer"
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
                      Connecting to microphone...
                    </div>
                  )}
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

            <div className="relative z-10 text-center">
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
                {/* Orbiting rings */}
                <motion.div
                  className="absolute inset-0 rounded-full border border-neon-purple/30"
                  animate={{ rotate: 360 }}
                  transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
                >
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-neon-purple" />
                </motion.div>
                <motion.div
                  className="absolute inset-[-8px] rounded-full border border-electric-violet/20"
                  animate={{ rotate: -360 }}
                  transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
                >
                  <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-1.5 h-1.5 rounded-full bg-electric-violet" />
                </motion.div>
              </motion.div>

              <h2 className="font-heading text-xl font-bold text-white mb-2">
                Analyzing Your Speech
              </h2>
              <p className="text-sm text-soft-gray/60 mb-6 max-w-xs mx-auto">
                Running acoustic analysis, pacing evaluation, and fluency scoring...
              </p>

              {/* Progress bars */}
              <div className="flex flex-col items-center gap-3 w-64 mx-auto">
                {["Transcription", "Pacing", "Fluency", "Clarity"].map((label, i) => (
                  <div key={label} className="w-full flex items-center gap-3">
                    <span className="text-[10px] text-soft-gray/50 uppercase tracking-wider w-20 text-right">
                      {label}
                    </span>
                    <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                      <motion.div
                        className="h-full rounded-full bg-gradient-to-r from-electric-violet to-neon-purple"
                        initial={{ width: "0%" }}
                        animate={{ width: "100%" }}
                        transition={{
                          duration: 0.8 + i * 0.3,
                          delay: i * 0.2,
                          ease: "easeOut",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}