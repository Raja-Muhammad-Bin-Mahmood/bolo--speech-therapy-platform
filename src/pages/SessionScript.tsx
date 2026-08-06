import { useState, useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, BookOpen, StopCircle, Sparkles, ChevronRight, Gauge, TimerReset } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import LiquidBackground from "../components/LiquidBackground";
import Navbar from "../components/Navbar";
import Teleprompter from "../components/Teleprompter";
import RecordButton from "../components/RecordButton";
import SessionTimer from "../components/SessionTimer";
import ScriptWaveform from "../components/ScriptWaveform";
import PaceMeter from "../components/PaceMeter";
import { SLP_PASSAGES, getRandomPassage, SLPPassage } from "../data/slpPassages";
import { useAudioCapture } from "../hooks/useAudioCapture";
import { useSpeechmaticsWS } from "../hooks/useSpeechmaticsWS";
import { useAcousticAnalysis } from "../hooks/useAcousticAnalysis";
import { useScriptMatcher, ScriptMetrics } from "../hooks/useScriptMatcher";
import { usePaceEngine, usePaceSnapshot } from "../hooks/usePaceEngine";
import { useStutterRecovery } from "../hooks/useStutterRecovery";
import { toFeedEvents } from "../lib/feedEvents";

export default function SessionScript() {
  const navigate = useNavigate();
  const [passage, setPassage] = useState<SLPPassage>(() => getRandomPassage());
  const [isRecording, setIsRecording] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [finalMetrics, setFinalMetrics] = useState<ScriptMetrics | null>(null);
  const [teleprompterProgress, setTeleprompterProgress] = useState(0);
  const [selectedPassage, setSelectedPassage] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [speed, setSpeed] = useState(1);

  // ── Speech pipeline hooks ─────────────────────────────────────────
  const audio = useAudioCapture();
  const ws = useSpeechmaticsWS();

  // ── Acoustic layer: parallel waveform-based disfluency analysis ──
  const { events: acousticEvents } = useAcousticAnalysis(
    audio.getAnalyser,
    isRecording
  );

  // Existing detector events in the Detection Feed vocabulary — these are
  // mapped onto the script words by timestamp (informational only).
  const feedEvents = useMemo(
    () => toFeedEvents(acousticEvents),
    [acousticEvents]
  );

  // Real-time word alignment against the passage (now with acoustic fusion)
  const { metrics: scriptMetrics, reset: resetMatcher } = useScriptMatcher(
    passage.text,
    ws.transcripts,
    acousticEvents
  );

  // ── Stage 3: Event-triggered recovery (annotate stuttered script words) ──
  const recovery = useStutterRecovery({
    active: isRecording && ws.status === "connected",
    getStreamTime: audio.getStreamTime,
    setOnPcm: audio.setOnPcm,
    transcripts: ws.transcripts,
    events: acousticEvents,
  });

  // ── Shared Pace Engine (compact mode) ──────────────────────────────
  const { engine, feedTranscripts, feedPauses } = usePaceEngine();
  const paceSnapshot = usePaceSnapshot(isRecording ? engine : null);

  // Feed the engine when recording
  useEffect(() => {
    if (!isRecording) return;
    feedTranscripts(ws.transcripts);
  }, [ws.transcripts, isRecording, feedTranscripts]);

  // Derive pauses from scriptMetrics.pauseEvents
  useEffect(() => {
    if (!isRecording) return;
    if (scriptMetrics.pauseEvents.length > 0) {
      feedPauses(scriptMetrics.pauseEvents);
    }
  }, [scriptMetrics.pauseEvents, isRecording, feedPauses]);

  // Wire PCM → Speechmatics WS
  useEffect(() => {
    audio.setOnAudioData(ws.sendAudio);
  }, [audio, ws.sendAudio]);

  // Unmount cleanup
  useEffect(() => {
    return () => {
      audio.stop();
      ws.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset matcher when passage changes
  useEffect(() => {
    resetMatcher();
    setFinalMetrics(null);
    setTeleprompterProgress(0);
    setIsComplete(false);
  }, [passage, resetMatcher]);

  const handleRecordingStart = useCallback(() => {
    setIsRecording(true);
    setIsComplete(false);
    setFinalMetrics(null);
    audio.start();
    ws.connect();
  }, [audio, ws]);

  const handleRecordingStop = useCallback(() => {
    // Capture final analysis BEFORE disconnecting (disconnect clears transcripts)
    setFinalMetrics(scriptMetrics);
    audio.stop();
    ws.disconnect();
    setIsRecording(false);
    setIsComplete(true);
  }, [audio, ws, scriptMetrics]);

  const handleTimerComplete = useCallback(() => {
    setFinalMetrics(scriptMetrics);
    audio.stop();
    ws.disconnect();
    setIsRecording(false);
    setIsComplete(true);
  }, [audio, ws, scriptMetrics]);

  const handleSelectPassage = (id: string) => {
    const found = SLP_PASSAGES.find((p) => p.id === id);
    if (found) {
      setPassage(found);
      setSelectedPassage(id);
      setTeleprompterProgress(0);
      setIsComplete(false);
      setFinalMetrics(null);
      setShowLibrary(false);
    }
  };

  const allTargets = passage.targets.map((t) => t.grapheme);

  // ── Event ticker (last N events for live feedback) ────────────────
  const liveEvents = useMemo(() => {
    if (!isRecording) return [];
    const evt = scriptMetrics.lastEvent;
    if (!evt) return [];
    return [evt];
  }, [scriptMetrics.lastEvent, isRecording]);

  return (
    <div className="min-h-screen relative overflow-hidden">
      <LiquidBackground />
      <div className="relative z-10">
        <Navbar />

        <main className="pt-24 pb-16 px-4 max-w-4xl mx-auto">
          {/* Back */}
          <button
            onClick={() => navigate("/dashboard")}
            className="flex items-center gap-1.5 text-sm text-soft-gray hover:text-white transition-colors mb-6"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </button>

          {/* Mode indicator */}
          <div className="flex items-center justify-between mb-6">
            <div className="glass rounded-full inline-flex items-center gap-2 px-3 py-1 text-xs text-electric-violet/80">
              <BookOpen className="w-3 h-3" />
              Script Mode — SLP Phonetic Reading
            </div>

            {/* Speed control */}
            {!isRecording && !isComplete && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-soft-gray/40">Speed</span>
                <div className="glass rounded-full flex items-center gap-1 p-0.5">
                  {[0.5, 0.75, 1, 1.25, 1.5].map((s) => (
                    <button
                      key={s}
                      onClick={() => setSpeed(s)}
                      className={`text-[10px] px-2 py-0.5 rounded-full transition-all ${
                        speed === s
                          ? "bg-neon-purple/20 text-neon-purple"
                          : "text-soft-gray/40 hover:text-white"
                      }`}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Passage header */}
          {!showLibrary && (
            <div className="glass rounded-2xl p-4 mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-heading text-base font-semibold text-white">
                  {passage.title}
                </h2>
                <p className="text-xs text-soft-gray/60 mt-0.5">
                  {passage.description}
                </p>
              </div>
              <button
                onClick={() => setShowLibrary(true)}
                className="text-[10px] px-3 py-1.5 glass rounded-full text-soft-gray hover:text-white transition-colors"
              >
                Change Passage
              </button>
            </div>
          )}

          {/* Passage Library */}
          <AnimatePresence>
            {showLibrary && (
              <motion.div
                initial={{ opacity: 0, y: -10, height: 0 }}
                animate={{ opacity: 1, y: 0, height: "auto" }}
                exit={{ opacity: 0, y: -10, height: 0 }}
                className="glass rounded-2xl p-4 mb-4 overflow-hidden"
              >
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-heading text-sm font-semibold text-white flex items-center gap-1.5">
                    <BookOpen className="w-3.5 h-3.5 text-neon-purple" />
                    Passage Library
                  </h3>
                  <button
                    onClick={() => setShowLibrary(false)}
                    className="text-[10px] text-soft-gray/40 hover:text-white"
                  >
                    Close
                  </button>
                </div>
                <div className="grid gap-2 max-h-60 overflow-y-auto">
                  {SLP_PASSAGES.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => handleSelectPassage(p.id)}
                      className={`w-full text-left px-3 py-2.5 rounded-xl transition-all ${
                        selectedPassage === p.id
                          ? "bg-neon-purple/10 border border-neon-purple/20"
                          : "bg-white/5 border border-white/5 hover:bg-white/10"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-white font-medium">{p.title}</p>
                          <p className="text-[10px] text-soft-gray/50 mt-0.5">
                            {p.duration}s • {p.difficulty}
                          </p>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-neon-purple/10 text-neon-purple/70">
                          {p.targets.length} targets
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => handleSelectPassage(getRandomPassage().id)}
                  className="mt-3 flex items-center gap-1.5 text-xs text-neon-purple/60 hover:text-neon-purple transition-colors"
                >
                  <Sparkles className="w-3 h-3" />
                  Surprise me
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Main content area */}
          <div className="grid md:grid-cols-2 gap-4">
            {/* Left panel: Waveform + Teleprompter */}
            <div className="flex flex-col gap-4">
              {/* Audio visualizer on top — canvas only */}
              <div className="glass rounded-2xl overflow-hidden relative" style={{ height: "128px" }}>
                <ScriptWaveform active={isRecording} />
              </div>

              {/* Live metrics strip (only while recording) */}
              <AnimatePresence>
                {isRecording && (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    className="glass rounded-2xl px-4 py-3 flex items-center justify-between gap-2 overflow-x-auto"
                  >
                    <div className="flex items-center gap-4 text-[10px] whitespace-nowrap">
                      <span className="flex items-center gap-1.5">
                        <Gauge className="w-3 h-3 text-neon-purple" />
                        <span className="text-soft-gray/50">Accuracy</span>
                        <span className="text-white font-mono font-medium">
                          {scriptMetrics.accuracyPct}%
                        </span>
                      </span>
                      <span className="w-px h-3 bg-white/10" />
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400/70" />
                        <span className="text-soft-gray/50">Fillers</span>
                        <span className="text-white font-mono font-medium">
                          {scriptMetrics.fillerCount}
                        </span>
                      </span>
                      <span className="w-px h-3 bg-white/10" />
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#F87171]" />
                        <span className="text-soft-gray/50">Stutters</span>
                        <span className="text-white font-mono font-medium">
                          {scriptMetrics.stutters}
                        </span>
                      </span>
                      <span className="w-px h-3 bg-white/10" />
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#BD8CFF]" />
                        <span className="text-soft-gray/50">Stammers</span>
                        <span className="text-white font-mono font-medium">
                          {scriptMetrics.stammers}
                        </span>
                      </span>
                      <span className="w-px h-3 bg-white/10" />
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-white/30" />
                        <span className="text-soft-gray/50">Pauses</span>
                        <span className="text-white font-mono font-medium">
                          {scriptMetrics.pauses.count}
                        </span>
                      </span>
                      <span className="w-px h-3 bg-white/10" />
                      <span className="flex items-center gap-1.5">
                        <TimerReset className="w-3 h-3 text-electric-violet" />
                        <span className="text-soft-gray/50">Pace</span>
                        <span className="text-white font-mono font-medium">
                          <PaceMeter snapshot={paceSnapshot} variant="compact" />
                        </span>
                      </span>
                    </div>

                    {/* Event ticker */}
                    <div className="flex items-center gap-1 text-[10px] font-mono text-amber-300/80 whitespace-nowrap">
                      {liveEvents.length > 0 ? (
                        <motion.span
                          key={liveEvents[0]}
                          initial={{ opacity: 0, x: 6 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="text-amber-300/90"
                        >
                          ✱ {liveEvents[0]}
                        </motion.span>
                      ) : (
                        <span className="text-soft-gray/30">listening…</span>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Teleprompter below */}
              <div className="glass rounded-2xl overflow-hidden flex-1" style={{ height: "300px" }}>
                <Teleprompter
                  text={passage.text}
                  isActive={isRecording}
                  progress={teleprompterProgress}
                  targets={allTargets}
                  speed={speed}
                  onProgressChange={setTeleprompterProgress}
                  tokenDetails={scriptMetrics.tokenDetails}
                  tokenStates={scriptMetrics.tokenStates}
                  activeIndex={scriptMetrics.activeTokenIndex}
                  pauseMarkers={scriptMetrics.pauseMarkers}
                  feedEvents={feedEvents}
                  recovered={recovery.annotations}
                />
              </div>
            </div>

            {/* Right panel: Controls + Report */}
            <div className="glass rounded-2xl p-6 flex flex-col items-center gap-4 relative overflow-hidden" style={{ height: "420px" }}>

              {!isComplete ? (
                <>
                  <p className="text-sm text-soft-gray/60 text-center relative z-10">
                    {isRecording
                      ? "Follow the text — BOLO is tracking your accuracy"
                      : "Press record and read the passage aloud"}
                  </p>

                  {/* Connection error */}
                  {ws.status === "error" && (
                    <div className="w-full glass-subtle rounded-xl px-3 py-2 text-center relative z-10">
                      <p className="text-[10px] text-destructive/80">
                        {ws.error || "Transcription unavailable"}
                      </p>
                    </div>
                  )}

                  {/* Teleprompter progress */}
                  <div className="w-full glass-subtle rounded-full h-1.5 overflow-hidden relative z-10">
                    <motion.div
                      className="h-full bg-gradient-to-r from-electric-violet to-neon-purple rounded-full"
                      initial={{ width: "0%" }}
                      animate={{ width: `${teleprompterProgress * 100}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>

                  <SessionTimer
                    duration={passage.duration}
                    isRunning={isRecording}
                    onComplete={handleTimerComplete}
                  />
                  <RecordButton
                    size="lg"
                    onStart={handleRecordingStart}
                    onStop={handleRecordingStop}
                  />

                  {isRecording && (
                    <button
                      onClick={handleRecordingStop}
                      className="flex items-center gap-1.5 text-xs text-red-400/60 hover:text-red-400 transition-colors relative z-10"
                    >
                      <StopCircle className="w-3.5 h-3.5" />
                      Stop early
                    </button>
                  )}
                </>
              ) : (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="w-full text-center space-y-3 pt-4 overflow-y-auto"
                >
                  <div className="w-14 h-14 rounded-full bg-gradient-to-br from-electric-violet to-neon-purple flex items-center justify-center mx-auto">
                    <Sparkles className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <p className="font-heading text-lg font-semibold text-white">Great Reading!</p>
                    <p className="text-xs text-soft-gray/60 mt-1">
                      Passage: {passage.title}
                    </p>
                  </div>

                  {/* Phonetic targets practiced */}
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {passage.targets.map((t, i) => (
                      <span
                        key={`${t.grapheme}-${i}`}
                        className="text-[10px] px-2 py-0.5 rounded-full bg-neon-purple/10 text-neon-purple/70"
                      >
                        {t.grapheme} ({t.ipa})
                      </span>
                    ))}
                  </div>

                  {/* ── Full speech analysis ── */}
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    {/* Accuracy */}
                    <div className="glass-subtle rounded-xl p-2.5 text-center">
                      <p className="text-xl font-heading font-bold text-white">
                        {finalMetrics ? finalMetrics.accuracyPct : 0}%
                      </p>
                      <p className="text-[9px] text-soft-gray/50 mt-0.5 uppercase tracking-wide">Script Accuracy</p>
                    </div>
                    {/* Clarity */}
                    <div className="glass-subtle rounded-xl p-2.5 text-center">
                      <p className="text-xl font-heading font-bold text-emerald-300">
                        {finalMetrics ? finalMetrics.clarityScore : 0}
                      </p>
                      <p className="text-[9px] text-soft-gray/50 mt-0.5 uppercase tracking-wide">Clarity</p>
                    </div>
                    {/* Pace */}
                    <div className="glass-subtle rounded-xl p-2.5 text-center">
                      <p className="text-xl font-heading font-bold text-white">
                        {finalMetrics ? finalMetrics.wpm : 0}
                      </p>
                      <p className="text-[9px] text-soft-gray/50 mt-0.5 uppercase tracking-wide">WPM</p>
                    </div>
                    {/* Articulation */}
                    <div className="glass-subtle rounded-xl p-2.5 text-center">
                      <p className="text-xl font-heading font-bold text-electric-violet">
                        {finalMetrics ? finalMetrics.articulationWPM : 0}
                      </p>
                      <p className="text-[9px] text-soft-gray/50 mt-0.5 uppercase tracking-wide">Articulation/min</p>
                    </div>
                  </div>

                  {/* Disfluency breakdown */}
                  <div className="flex flex-wrap justify-center gap-1.5">
                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-amber-400/10 text-amber-300/80">
                      {finalMetrics ? finalMetrics.fillerCount : 0} fillers
                    </span>
                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-red-400/10 text-red-300/80">
                      {finalMetrics ? finalMetrics.stutters : 0} stutters
                    </span>
                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-[#BD8CFF]/10 text-[#BD8CFF]/80">
                      {finalMetrics ? finalMetrics.stammers : 0} stammers
                    </span>
                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-orange-400/10 text-orange-300/80">
                      {finalMetrics ? finalMetrics.repetitions : 0} repeats
                    </span>
                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-white/5 text-soft-gray/70">
                      {finalMetrics ? finalMetrics.substitutions : 0} substitutions
                    </span>
                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-white/5 text-soft-gray/70">
                      {finalMetrics ? finalMetrics.pauses.count : 0} pauses
                    </span>
                  </div>

                  {/* Pause detail + phonation */}
                  {finalMetrics && finalMetrics.pauses.count > 0 && (
                    <p className="text-[9px] text-soft-gray/40">
                      Avg pause {(finalMetrics.pauses.avgMs / 1000).toFixed(1)}s · longest{" "}
                      {(finalMetrics.pauses.longestMs / 1000).toFixed(1)}s · phonation{" "}
                      {Math.round(finalMetrics.phonationRatio * 100)}%
                    </p>
                  )}

                  <div className="flex flex-col gap-2 pt-2">
                    <button
                      onClick={() => {
                        setIsComplete(false);
                        setTeleprompterProgress(0);
                        setFinalMetrics(null);
                        resetMatcher();
                      }}
                      className="flex items-center justify-center gap-1.5 bg-primary hover:bg-primary-hover text-white text-sm font-medium py-2.5 rounded-xl transition-all duration-200 active:scale-[0.97] cursor-pointer"
                    >
                      Practice Again
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => navigate("/dashboard")}
                      className="text-sm text-soft-gray/60 hover:text-white transition-colors py-1"
                    >
                      Back to Dashboard
                    </button>
                  </div>
                </motion.div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}