import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Square, Sparkles, BarChart3 } from "lucide-react";
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

  // ── Cleanup on unmount ──────────────────────────────────────────
  useEffect(() => {
    return () => {
      audio.stop();
      ws.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const audio = useAudioCapture();
  const ws = useSpeechmaticsWS();

  // ── Acoustic analysis layer (parallel to ASR) ──────────────────────
  const { events: acousticEvents } = useAcousticAnalysis(
    audio.getAnalyser,
    phase === "recording" && audio.isActive
  );

  // ── Fusion + shared scoring (live) ──────────────────────────────────
  const { wordTags, pauseEvents } = useSessionAnalysis(ws.transcripts, acousticEvents);

  // ── Stutter engine (AudioWorklet DSP → conservative fusion) ──────────
  const stutter = useStutterEngine(
    ws.transcripts,
    audio.stutterCandidates,
    phase === "recording" && audio.isActive
  );

  // Align the acoustic clock to the ASR lane once Speechmatics is connected
  useEffect(() => {
    if (ws.status === "connected") audio.pinClock();
  }, [ws.status, audio]);

  // ── Shared Pace Engine ──────────────────────────────────────────────
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

  // ── Wire audio capture → WebSocket ──────────────────────────────
  useEffect(() => {
    audio.setOnAudioData(ws.sendAudio);
  }, [audio, ws.sendAudio]);

  // ── Timer complete → end recording (grace period for final words) ──
  const handleTimerComplete = useCallback(() => {
    if (analysisLockRef.current) return;
    analysisLockRef.current = true;
    setTimerRunning(false);
    setPhase("processing");

    // Snapshot stutter candidates BEFORE stopping the mic (stop() clears them)
    const stutterSnapshot = audio.getStutterCandidates();

    // Stop the mic first: no more audio → no more Speechmatics credits.
    audio.stop();

    // Grace window: let the last finals land (socket stays open, nothing sent).
    // Then snapshot + disconnect + finalize with the COMPLETE transcript.
    const finalize = () => {
      const finals = ws.snapshotTranscripts();
      ws.disconnect();

      // Finalize pace report from the shared engine
      const paceReport = finalizePace();

      // Compute final analysis via shared engine (Phase 5)
      const score = finalizeSessionScore(finals, acousticEvents);

      // Build legacy-compatible analysis data for the Analysis page
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

      // Longest phrase + avg words per burst
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

      // ── Stutter review data (AudioWorklet DSP lane) ─────────────
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
        // Phase 5 engine output
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
        // Pause statistics (Phase: pause detector)
        pauses: score.pauses,
        // Shared Pace Engine report (new)
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
        // Stutter engine review data (AudioWorklet DSP lane)
        stutterEvents,
        stutterSummary,
      };

      saveSessionData(result.clarityScore);

      setTimeout(() => {
        navigate("/analysis", {
          state: { topic: selectedTopic, ...result },
        });
      }, 800);
    };

    setTimeout(finalize, 1100);
  }, [audio, ws, selectedTopic, navigate, saveSessionData, acousticEvents, finalizePace]);

  const handleStopRecording = useCallback(() => {
    if (analysisLockRef.current) return;
    analysisLockRef.current = true;
    handleTimerComplete();
  }, [handleTimerComplete]);

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="min-h-screen relative overflow-hidden bg-deep-space">
      <Navbar />
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

      <AnimatePresence>
        {phase === "recording" && (
          <motion.div
            key="recording-phase"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-20 flex flex-col"
          >
            <div className="absolute inset-0 bg-gradient-to-b from-deep-space via-dark-lavender/20 to-deep-space pointer-events-none" />
            <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[700px] h-[700px] rounded-full bg-neon-purple/8 blur-[140px] pointer-events-none" />
            <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-electric-violet/5 blur-[100px] pointer-events-none" />

            <div className="relative z-10 flex flex-col items-center justify-between h-full pt-24 pb-8 px-4">
              <div className="glass rounded-full px-4 py-2 flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-neon-purple" />
                <span className="text-xs font-medium text-white">{selectedTopic}</span>
              </div>

              {/* Waveform + Timer + Pace Meter */}
              <div className="w-full max-w-lg mx-auto flex flex-col items-center gap-4">
                <ReactiveWaveform
                  getAnalyser={audio.getAnalyser}
                  isActive={audio.isActive}
                  className="w-full h-24"
                />
                <div className="flex items-start gap-4 w-full">
                  <div className="flex-1 min-w-0">
                    <PaceMeter
                      snapshot={paceSnapshot}
                      variant="full"
                    />
                  </div>
                  <div className="shrink-0 flex flex-col items-center">
                    <CountdownTimer
                      duration={60}
                      isRunning={timerRunning}
                      onComplete={handleTimerComplete}
                    />
                  </div>
                </div>
              </div>

              {/* Live transcription with fusion tags + utterance-based lines */}
              <div className="w-full max-w-lg mx-auto flex-1 overflow-y-auto mb-4">
                {ws.status === "error" ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center">
                      <p className="text-xs text-destructive/80 mb-1">Connection error</p>
                      <p className="text-[10px] text-soft-gray/40">{ws.error || "Unable to connect to transcription service"}</p>
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

              {audio.isActive && (
                <motion.button
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleStopRecording}
                  className="flex items-center gap-2 bg-destructive hover:bg-red-600 text-white text-sm font-medium px-6 py-3 rounded-full transition-all duration-200 shadow-[0_0_20px_rgba(255,80,80,0.3)] cursor-pointer"
                >
                  <Square className="w-4 h-4 fill-white" />
                  Stop Recording
                </motion.button>
              )}

              {!audio.isActive && phase === "recording" && (
                <div className="flex items-center gap-2 text-sm text-soft-gray/50">
                  <div className="flex gap-1">
                    <div className="w-2 h-2 rounded-full bg-neon-purple animate-bounce" style={{ animationDelay: "0ms" }} />
                    <div className="w-2 h-2 rounded-full bg-neon-purple animate-bounce" style={{ animationDelay: "150ms" }} />
                    <div className="w-2 h-2 rounded-full bg-neon-purple animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                  Connecting to microphone...
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {phase === "processing" && (
          <motion.div
            key="processing-phase"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-30 flex items-center justify-center bg-deep-space/80 backdrop-blur-sm"
          >
            <div className="text-center">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-electric-violet to-neon-purple flex items-center justify-center mx-auto mb-4 animate-pulse">
                <BarChart3 className="w-8 h-8 text-white" />
              </div>
              <h2 className="font-heading text-xl font-bold text-white mb-2">Analyzing Your Speech</h2>
              <div className="flex gap-2 justify-center">
                <div className="w-2 h-2 rounded-full bg-neon-purple animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-2 h-2 rounded-full bg-neon-purple animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-2 h-2 rounded-full bg-neon-purple animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}