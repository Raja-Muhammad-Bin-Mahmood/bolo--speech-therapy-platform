import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, StopCircle, Sparkles, MessageSquare } from "lucide-react";
import LiquidBackground from "../components/LiquidBackground";
import Navbar from "../components/Navbar";
import RecordButton from "../components/RecordButton";
import SessionTimer from "../components/SessionTimer";
import TopicDrum from "../components/TopicDrum";
import SensorSidebar from "../components/SensorSidebar";
import { useSpeechRecognition, type StyledSegment } from "../hooks/useSpeechRecognition";
import { useLiveSensor } from "../hooks/useLiveSensor";
import { useAuth } from "../context/AuthContext";

/** Simulated SLP report — in production Speechmatics + AI */
function generateMockReport(_prompt: string, _words?: any[], disfluencies?: any[]) {
  const clarity = Math.floor(Math.random() * 20) + 72;
  const silentBlocks = disfluencies?.filter((d) => d.type === "silent_block").length || Math.floor(Math.random() * 4);
  const repetitions = disfluencies?.filter((d) => d.type === "repetition").length || Math.floor(Math.random() * 6) + 1;
  const prolongations = disfluencies?.filter((d) => d.type === "prolongation").length || Math.floor(Math.random() * 5);
  const interjections = disfluencies?.filter((d) => d.type === "interjection").length || Math.floor(Math.random() * 3);

  return {
    overallClarity: clarity,
    disfluencyBreakdown: {
      silentBlocks,
      repetitions,
      prolongations,
      interjections,
      totalBlocks: silentBlocks + repetitions + prolongations + interjections,
    },
    actionPlan: {
      exercises: [
        {
          name: "Easy Onset Breathing",
          description: "Begin each phrase with a gentle exhale before phonating. Place your hand on your abdomen and feel it rise slowly.",
          duration: "5 minutes, 3x daily",
          difficulty: "Beginner",
        },
        {
          name: "Slow Pacing with Tapping",
          description: "Tap your finger on each syllable at a slow, steady rhythm. Gradually increase speed while maintaining clarity.",
          duration: "3 minutes per session",
          difficulty: "Intermediate",
        },
        {
          name: "Prolonged Vowel Stretching",
          description: "Hold each vowel sound for 3 seconds before moving to the next. Focus on steady airflow throughout.",
          duration: "4 minutes, 2x daily",
          difficulty: "Beginner",
        },
      ],
      tips: [
        "Pause briefly between phrases instead of filling silence with filler words",
        "Keep your jaw relaxed — tension in the jaw tightens the vocal folds",
        "Visualize the sound before you produce it",
      ],
    },
  };
}

// ─── Styled segment rendering ───────────────────────────────────────────

const SEGMENT_STYLES: Record<StyledSegment["kind"], { color: string; className: string }> = {
  filler: {
    color: "#FACC15",
    className: "",
  },
  repetition: {
    color: "#FB923C",
    className: "",
  },
  tonic_block: {
    color: "#EF4444",
    className: "",
  },
  prolongation: {
    color: "#C084FC",
    className: "italic underline decoration-wavy",
  },
  clean: {
    color: "rgba(200,200,220,0.7)",
    className: "",
  },
  listening: {
    color: "rgba(156,163,175,0.6)",
    className: "animate-pulse",
  },
};

function SegmentSpan({ segment }: { segment: StyledSegment }) {
  const style = SEGMENT_STYLES[segment.kind] ?? SEGMENT_STYLES.clean;
  return (
    <span
      className={`inline transition-all duration-150 ${style.className}`}
      style={{ color: style.color }}
    >
      {segment.symbol && <span className="inline-block">{segment.symbol}</span>}
      {segment.prefix && <span className="inline-block text-[0.7em] opacity-60">{segment.prefix}</span>}
      {segment.text}{" "}
    </span>
  );
}

/** Auto-scrolls its children to the bottom when new content arrives */
function AutoScrollContainer({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [children]);

  return (
    <div ref={scrollRef} className="overflow-y-auto" style={{ height: "100%", scrollbarWidth: "none" }}>
      {children}
    </div>
  );
}

export default function Session() {
  const location = useLocation();
  const navigate = useNavigate();
  const { saveSessionData } = useAuth();
  const state = location.state as { mode?: string; prompt?: string } | null;

  const [isRecording, setIsRecording] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [report, setReport] = useState<ReturnType<typeof generateMockReport> | null>(null);
  const [showTopicPicker, setShowTopicPicker] = useState(!state?.prompt);
  const [prompt, setPrompt] = useState(state?.prompt ?? "");

  const {
    transcript,
    interimTranscript,
    segments,
    disfluencyLog,
    words,
    stopListening,
    resetTranscript,
    startListening,
    isSupported,
    error: speechError,
  } = useSpeechRecognition();

  const sensor = useLiveSensor();

  const promptText = prompt || "Describe your ideal day.";

  const handleRecordingStart = useCallback(() => {
    setIsRecording(true);
    setIsComplete(false);
    setReport(null);
    resetTranscript();
    startListening();
    sensor.start();
  }, [startListening, resetTranscript, sensor]);

  const handleRecordingStop = useCallback(() => {
    setIsRecording(false);
    stopListening();
    sensor.stop();
  }, [stopListening, sensor]);

  const handleTimerComplete = useCallback(() => {
    setIsRecording(false);
    setIsComplete(true);
    stopListening();
    sensor.stop();
    const mockReport = generateMockReport(promptText, words, disfluencyLog);
    setReport(mockReport);
    saveSessionData(mockReport.overallClarity);
  }, [promptText, words, disfluencyLog, stopListening, saveSessionData, sensor]);

  const handleTopicSelect = useCallback((topic: string) => {
    setPrompt(topic);
    setShowTopicPicker(false);
  }, []);

  return (
    <div className="min-h-screen relative overflow-hidden">
      <LiquidBackground />
      <div className="relative z-10">
        <Navbar />

        {/* ── Sensor Sidebar ──────────────────────────────────────────────── */}
        <SensorSidebar sensor={sensor} isRecording={isRecording} />

        <main className="pt-24 pb-16 px-4 max-w-3xl mx-auto">
          {/* Back */}
          <button
            onClick={() => navigate("/dashboard")}
            className="flex items-center gap-1.5 text-sm text-soft-gray hover:text-white transition-colors mb-6 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </button>

          {/* Mode indicator */}
          <div className="glass rounded-full inline-flex items-center gap-2 px-3 py-1 text-xs text-neon-purple/80 mb-4">
            <div className="w-1.5 h-1.5 rounded-full bg-neon-purple animate-pulse" />
            Unprompted Mode — Spontaneous Speech
          </div>

          {/* Topic Picker */}
          {showTopicPicker ? (
            <TopicDrum onSelect={handleTopicSelect} onBack={() => navigate("/dashboard")} />
          ) : (
            <>
              {/* Prompt card */}
              <div className="glass rounded-2xl p-5 mb-6 relative overflow-hidden">
                <div className="absolute -top-16 -right-16 w-32 h-32 rounded-full bg-neon-purple/5 blur-3xl pointer-events-none" />
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <h2 className="font-heading text-sm font-semibold text-white mb-1.5 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-neon-purple" />
                      Your Topic
                    </h2>
                    <p className="text-soft-gray text-sm leading-relaxed">{promptText}</p>
                  </div>
                  {!isRecording && !isComplete && (
                    <button
                      onClick={() => setShowTopicPicker(true)}
                      className="shrink-0 text-[10px] px-2.5 py-1.5 glass rounded-full text-soft-gray hover:text-white transition-colors cursor-pointer"
                    >
                      Change
                    </button>
                  )}
                </div>
              </div>

              {/* Recording area */}
              <div className="glass rounded-2xl p-6 md:p-8 flex flex-col items-center gap-5 relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-b from-neon-purple/[0.03] to-transparent pointer-events-none" />

                {!isComplete ? (
                  <>
                    <p className="text-sm text-soft-gray/60 text-center">
                      {isRecording
                        ? "Speak naturally — BOLO is listening"
                        : "Press record and speak for 60 seconds"}
                    </p>

                    {/* Styled segment rolling transcript */}
                    {(segments.length > 0 || interimTranscript) && (
                      <div className="w-full glass-subtle rounded-xl overflow-hidden relative" style={{ height: "4.5rem" }}>
                        <div className="p-3 leading-relaxed text-xs overflow-hidden" style={{ height: "100%" }}>
                          <AutoScrollContainer>
                            {segments.map((seg) => (
                              <SegmentSpan key={seg.id} segment={seg} />
                            ))}
                            {interimTranscript && (
                              <span className="text-neon-purple/50">{interimTranscript}</span>
                            )}
                          </AutoScrollContainer>
                        </div>
                      </div>
                    )}

                    {/* Disfluency badges */}
                    {disfluencyLog.length > 0 && isRecording && (
                      <div className="flex flex-wrap gap-1.5 justify-center">
                        {(["interjection", "repetition", "silent_block"] as const).map((type) => {
                          const count = disfluencyLog.filter((d) => d.type === type).length;
                          if (count === 0) return null;
                          const labels: Record<string, string> = {
                            interjection: "Filler",
                            repetition: "Repeat",
                            silent_block: "Block",
                          };
                          return (
                            <span
                              key={type}
                              className="text-[10px] px-2 py-0.5 rounded-full bg-neon-purple/10 text-neon-purple/70"
                            >
                              {labels[type]}: {count}
                            </span>
                          );
                        })}
                      </div>
                    )}

                    {/* Speech not supported warning */}
                    {!isSupported && speechError && (
                      <p className="text-[10px] text-soft-gray/40 text-center">{speechError}</p>
                    )}

                    {/* Waveform */}
                    <div className="h-16 flex items-center justify-center">
                      <div className="flex items-end gap-1 h-12" aria-hidden="true">
                        {Array.from({ length: 7 }, (_, i) => (
                          <div
                            key={i}
                            className="w-[3px] rounded-full"
                            style={{
                              height: `${30 + Math.random() * 50}%`,
                              background: "linear-gradient(to top, rgba(109,86,255,0.4), rgba(189,140,255,0.8))",
                              animation: isRecording
                                ? `waveform 1.2s ease-in-out ${i * 0.12}s infinite`
                                : "none",
                              transform: isRecording ? undefined : "scaleY(0.3)",
                            }}
                          />
                        ))}
                      </div>
                    </div>

                    {/* Timer & Record Button */}
                    <div className="flex flex-col items-center gap-4">
                      <SessionTimer
                        duration={60}
                        isRunning={isRecording}
                        onComplete={handleTimerComplete}
                      />
                      <RecordButton
                        size="lg"
                        onStart={handleRecordingStart}
                        onStop={handleRecordingStop}
                      />
                    </div>

                    {isRecording && (
                      <button
                        onClick={handleRecordingStop}
                        className="flex items-center gap-1.5 text-xs text-red-400/60 hover:text-red-400 transition-colors cursor-pointer"
                      >
                        <StopCircle className="w-3.5 h-3.5" />
                        Stop early
                      </button>
                    )}
                  </>
                ) : (
                  /* SLP Report Results */
                  <div className="w-full animate-fade-in">
                    {report && (
                      <div className="space-y-6">
                        {/* Clarity Score */}
                        <div className="text-center">
                          <p className="text-sm text-soft-gray/60 mb-2">Overall Clarity Score</p>
                          <div className="relative inline-flex items-center justify-center">
                            <svg className="w-28 h-28 -rotate-90" viewBox="0 0 100 100">
                              <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
                              <circle cx="50" cy="50" r="42" fill="none" stroke="url(#scoreGradient)" strokeWidth="6" strokeLinecap="round"
                                strokeDasharray={`${2 * Math.PI * 42}`}
                                strokeDashoffset={`${2 * Math.PI * 42 * (1 - report.overallClarity / 100)}`}
                                className="transition-all duration-1000"
                              />
                              <defs>
                                <linearGradient id="scoreGradient" x1="0" y1="0" x2="1" y2="1">
                                  <stop offset="0%" stopColor="#6D56FF" /><stop offset="100%" stopColor="#BD8CFF" />
                                </linearGradient>
                              </defs>
                            </svg>
                            <span className="absolute font-heading text-3xl font-bold text-white">{report.overallClarity}%</span>
                          </div>
                        </div>

                        {/* Disfluency Breakdown */}
                        <div>
                          <h3 className="font-heading text-sm font-semibold text-white mb-3">Disfluency Breakdown</h3>
                          <div className="grid grid-cols-4 gap-2">
                            {[
                              { label: "Silent Blocks", value: report.disfluencyBreakdown.silentBlocks, color: "text-neon-purple", bg: "bg-neon-purple/10" },
                              { label: "Repetitions", value: report.disfluencyBreakdown.repetitions, color: "text-electric-violet", bg: "bg-electric-violet/10" },
                              { label: "Prolongations", value: report.disfluencyBreakdown.prolongations, color: "text-vibrant-indigo", bg: "bg-vibrant-indigo/10" },
                              { label: "Filler Words", value: report.disfluencyBreakdown.interjections, color: "text-lavender-mist", bg: "bg-lavender-mist/10" },
                            ].map((item) => (
                              <div key={item.label} className={`${item.bg} rounded-xl p-3 text-center`}>
                                <p className={`text-xl font-bold ${item.color}`}>{item.value}</p>
                                <p className="text-[9px] text-soft-gray/60 mt-0.5">{item.label}</p>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Transcript */}
                        {transcript && (
                          <div>
                            <h3 className="font-heading text-sm font-semibold text-white mb-2 flex items-center gap-1.5">
                              <MessageSquare className="w-3.5 h-3.5 text-soft-gray/50" />
                              Your Speech
                            </h3>
                            <div className="bg-white/5 rounded-xl p-3.5 max-h-28 overflow-y-auto">
                              <p className="text-xs text-soft-gray/60 leading-relaxed">{transcript}</p>
                            </div>
                          </div>
                        )}

                        {/* Action Plan */}
                        <div>
                          <h3 className="font-heading text-sm font-semibold text-white mb-3">Your SLP Action Plan</h3>
                          <div className="space-y-2">
                            {report.actionPlan.exercises.map((ex) => (
                              <div key={ex.name} className="bg-white/5 rounded-xl p-3.5">
                                <div className="flex items-start justify-between gap-2">
                                  <div>
                                    <p className="text-sm font-medium text-white">{ex.name}</p>
                                    <p className="text-xs text-soft-gray/60 mt-1 leading-relaxed">{ex.description}</p>
                                  </div>
                                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-soft-gray/50 shrink-0">{ex.difficulty}</span>
                                </div>
                                <p className="text-[10px] text-neon-purple/50 mt-2">{ex.duration}</p>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Tips */}
                        <div>
                          <h3 className="font-heading text-sm font-semibold text-white mb-3">Coach's Tips</h3>
                          <ul className="space-y-1.5">
                            {report.actionPlan.tips.map((tip, i) => (
                              <li key={i} className="text-xs text-soft-gray/70 flex items-start gap-2">
                                <span className="text-neon-purple mt-0.5">✦</span>
                                {tip}
                              </li>
                            ))}
                          </ul>
                        </div>

                        {/* Actions */}
                        <div className="flex flex-col sm:flex-row gap-3 pt-2">
                          <button onClick={() => { setIsComplete(false); setReport(null); resetTranscript(); }}
                            className="flex-1 bg-primary hover:bg-primary-hover text-white font-medium px-6 py-3 rounded-full transition-all duration-200 active:scale-[0.97] text-sm cursor-pointer">
                            Practice Again
                          </button>
                          <button onClick={() => navigate("/dashboard")}
                            className="flex-1 glass text-soft-gray hover:text-white font-medium px-6 py-3 rounded-full transition-all duration-200 active:scale-[0.97] text-sm cursor-pointer">
                            Back to Dashboard
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}