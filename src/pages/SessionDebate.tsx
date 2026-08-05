import { useState, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Zap,
  ChevronRight,
  Brain,
  MessageSquare,
  Volume2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Navbar from "../components/Navbar";
import DebateStage from "../components/DebateStage";
import RecordButton from "../components/RecordButton";
import PaceMeter from "../components/PaceMeter";
import DebatePaceSummary from "../components/DebatePaceSummary";
import { usePaceEngine, usePaceSnapshot } from "../hooks/usePaceEngine";
import type { PaceReport } from "../lib/paceEngine";

// ─── AI Debate Topics ────────────────────────────────────────────────────

const DEBATE_TOPICS = [
  {
    topic: "Remote work vs. office work",
    opener:
      "I believe working from an office fosters better collaboration and company culture. How can teams truly innovate without face-to-face interaction?",
  },
  {
    topic: "AI in healthcare",
    opener:
      "Artificial intelligence will revolutionize medicine, but we must be cautious. Can we trust machines with human life?",
  },
  {
    topic: "Social media and mental health",
    opener:
      "Social media connects us globally, but at what cost? Studies show it increases anxiety and depression, especially in young people.",
  },
  {
    topic: "Space exploration funding",
    opener:
      "Why spend billions on space when we have problems on Earth? Isn't it irresponsible to fund Mars missions while people go hungry?",
  },
  {
    topic: "Electric vehicles",
    opener:
      "Electric vehicles are the future, but the transition is happening too fast. Our infrastructure simply isn't ready.",
  },
];

const AI_RESPONSES: Record<string, string[]> = {
  "Remote work vs. office work": [
    "That's a fair point — I agree that spontaneous collaboration has value. But isn't it possible that forced interaction isn't true collaboration? Many people report being more productive at home. Don't we need to redefine what collaboration means?",
    "I understand your perspective, but let me challenge it. The data shows hybrid models actually improve retention and reduce burnout. Are we prioritizing tradition over well-being?",
  ],
  "AI in healthcare": [
    "You raise valid concerns about trust. But consider this — AI doesn't get tired, doesn't have biases in the same way humans do, and can process millions of records in seconds. Isn't it more dangerous not to use every tool we have?",
    "I appreciate your caution. But haven't we always been cautious with new technology? The question isn't whether machines are perfect — it's whether they're better than the alternative.",
  ],
  "Social media and mental health": [
    "I see your concern, but isn't the issue how we use these tools rather than the tools themselves? Social media has also given voice to marginalized communities and connected people who would otherwise be isolated.",
    "The studies you mention are correlational, not causal. Could it be that people who are already struggling are drawn to social media, rather than social media causing the struggle?",
  ],
  "Space exploration funding": [
    "That's a compelling argument. But space exploration has given us countless technologies we use every day — from GPS to medical imaging. Could it be that investing in the future is the most responsible thing we can do?",
    "I hear your concern about priorities. But the same people who work on space technology also contribute to solving Earth's problems. Isn't it possible to do both?",
  ],
  "Electric vehicles": [
    "You make a good point about infrastructure. But didn't we say the same thing about the internet, about smartphones, about renewable energy? Every revolution feels impossible until it isn't.",
    "I understand the infrastructure concern. But isn't waiting for perfect infrastructure a recipe for inaction? We need to build as we go — that's how progress has always worked.",
  ],
};

const AI_CHALLENGES = [
  "Could you elaborate on that? I'm not sure I follow your reasoning.",
  "That's interesting — but have you considered the opposite perspective?",
  "I'd push back on that point. What evidence supports your claim?",
  "You said something just now that I'd like to explore further. Can you rephrase that?",
  "I'm not convinced yet. Help me understand your position more clearly.",
];

// ─── Circular Score ──────────────────────────────────────────────────────

function CircularScore({
  score,
  label,
}: {
  score: number;
  label: string;
}) {
  const circumference = 2 * Math.PI * 36;
  const offset = circumference * (1 - score / 100);
  return (
    <div className="flex flex-col items-center">
      <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
        <circle
          cx="40"
          cy="40"
          r="36"
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="4"
        />
        <circle
          cx="40"
          cy="40"
          r="36"
          fill="none"
          stroke="url(#debateScore)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-1000"
        />
        <defs>
          <linearGradient id="debateScore" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#6D56FF" />
            <stop offset="100%" stopColor="#BD8CFF" />
          </linearGradient>
        </defs>
      </svg>
      <span className="font-heading text-2xl font-bold text-white -mt-12">
        {score}%
      </span>
      <span className="text-[10px] text-soft-gray/60 mt-0.5">{label}</span>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────

export default function SessionDebate() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<
    "choose" | "speaking" | "listening" | "result"
  >("choose");
  const [topicIndex] = useState(0);
  const [, setAiMessageIndex] = useState(0);
  const [, setIsRecording] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [turn, setTurn] = useState(0);
  const maxTurns = 4;
  const [score, setScore] = useState(0);
  const [ambientAudio, setAmbientAudio] = useState(false);
  const [paceReport, setPaceReport] = useState<PaceReport | null>(null);

  // ── Shared Pace Engine (Debate mode = same engine, different display) ──
  const { engine, finalize } = usePaceEngine();
  const paceSnapshot = usePaceSnapshot(phase === "speaking" ? engine : null);

  const currentTopic = selectedTopic
    ? DEBATE_TOPICS.find((t) => t.topic === selectedTopic) || DEBATE_TOPICS[topicIndex]
    : DEBATE_TOPICS[topicIndex];

  const currentAiResponse =
    turn > 0 && selectedTopic
      ? (AI_RESPONSES[selectedTopic]?.[(turn - 1) % (AI_RESPONSES[selectedTopic]?.length || 1)] ||
          AI_CHALLENGES[(turn - 1) % AI_CHALLENGES.length])
      : currentTopic?.opener || "";

  const handleSelectTopic = (topic: string) => {
    setSelectedTopic(topic);
    // Brief delay for dramatic effect, then start
    setTimeout(() => setPhase("speaking"), 300);
  };

  const handleRecordingStart = useCallback(() => {
    setIsRecording(true);
  }, []);

  const handleRecordingStop = useCallback(() => {
    setIsRecording(false);
    if (turn < maxTurns) {
      setPhase("listening");
      setTimeout(() => {
        setTurn((t) => t + 1);
        setIsRecording(true);
        setPhase("speaking");
      }, 2500);
    } else {
      const finalScore = Math.floor(Math.random() * 30) + 65;
      setScore(finalScore);
      setPhase("result");
    }
  }, [turn]);

  return (
    <div className="min-h-screen relative overflow-hidden bg-deep-space">
      <Navbar />

      {/* ── Topic selection overlay ───────────────────────────────── */}
      <AnimatePresence>
        {phase === "choose" && (
          <motion.div
            key="topic-select"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-deeper-space/90 backdrop-blur-sm"
          >
            <div className="glass rounded-2xl p-6 max-w-lg w-full mx-4">
              <button
                onClick={() => navigate("/dashboard")}
                className="flex items-center gap-1.5 text-sm text-soft-gray hover:text-white transition-colors mb-4"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to Dashboard
              </button>

              <h2 className="font-heading text-lg font-semibold text-white mb-1">
                Choose a Debate Topic
              </h2>
              <p className="text-xs text-soft-gray/60 mb-4">
                Step up to the podium. The AI will challenge your perspective.
              </p>
              <div className="space-y-2">
                {DEBATE_TOPICS.map((d) => (
                  <button
                    key={d.topic}
                    onClick={() => handleSelectTopic(d.topic)}
                    className="w-full text-left px-4 py-3 glass rounded-xl hover:border-neon-purple/30 transition-all active:scale-[0.98] cursor-pointer"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-white font-medium">
                        {d.topic}
                      </span>
                      <ChevronRight className="w-4 h-4 text-soft-gray/40" />
                    </div>
                    <p className="text-[10px] text-soft-gray/50 mt-1 line-clamp-1">
                      {d.opener}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Debate Stage (full screen behind everything) ──────────── */}
      {phase !== "choose" && (
        <div className="fixed inset-0 top-0 z-0">
          <DebateStage
            isSpeaking={phase === "speaking"}
            isAIResponding={phase === "listening"}
            turn={turn}
          />
        </div>
      )}

      {/* ── HUD Overlay ───────────────────────────────────────────── */}
      {phase !== "choose" && phase !== "result" && (
        <div className="fixed inset-0 z-10 pointer-events-none">
          {/* Top center — frosted glass topic banner */}
          <div className="absolute top-20 left-1/2 -translate-x-1/2">
            <div className="glass rounded-full px-5 py-2.5 flex items-center gap-2">
              <Zap className="w-3.5 h-3.5 text-neon-purple" />
              <span className="text-sm font-heading font-medium text-white whitespace-nowrap">
                {currentTopic?.topic}
              </span>
              <div className="flex gap-1 ml-2">
                {Array.from({ length: maxTurns + 1 }, (_, i) => (
                  <div
                    key={i}
                    className={`w-1.5 h-1.5 rounded-full transition-all ${
                      i <= turn ? "bg-neon-purple" : "bg-white/10"
                    }`}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Ambient floating transcript captions */}
          <AnimatePresence>
            {phase === "listening" && (
              <motion.div
                key={turn}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="absolute bottom-28 left-1/2 -translate-x-1/2 max-w-lg w-full px-4"
              >
                <div className="glass-strong rounded-2xl p-4 pointer-events-auto">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Brain className="w-3 h-3 text-neon-purple" />
                    <span className="text-[10px] font-medium text-neon-purple/70">
                      AI Debater
                    </span>
                  </div>
                  <p className="text-sm text-soft-gray leading-relaxed">
                    {currentAiResponse}
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Bottom center — controls */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-auto">
            <div className="glass rounded-2xl px-6 py-3 flex items-center gap-4">
              {/* Turn indicator */}
              <span className="text-[10px] font-mono text-soft-gray/50 whitespace-nowrap">
                Turn {turn + 1}/{maxTurns + 1}
              </span>

              {/* Mic Button */}
              {phase === "speaking" && (
                <RecordButton
                  size="md"
                  onStart={handleRecordingStart}
                  onStop={handleRecordingStop}
                />
              )}

              {phase === "listening" && (
                <div className="flex items-center gap-2 text-xs text-soft-gray/50">
                  <div className="flex gap-0.5">
                    <div
                      className="w-1.5 h-1.5 rounded-full bg-neon-purple animate-bounce"
                      style={{ animationDelay: "0ms" }}
                    />
                    <div
                      className="w-1.5 h-1.5 rounded-full bg-neon-purple animate-bounce"
                      style={{ animationDelay: "150ms" }}
                    />
                    <div
                      className="w-1.5 h-1.5 rounded-full bg-neon-purple animate-bounce"
                      style={{ animationDelay: "300ms" }}
                    />
                  </div>
                  AI is responding...
                </div>
              )}

              {/* Ambient toggle */}
              <button
                onClick={() => setAmbientAudio((a) => !a)}
                className={`p-2 rounded-full transition-colors ${
                  ambientAudio
                    ? "text-neon-purple bg-neon-purple/10"
                    : "text-soft-gray/40 hover:text-soft-gray"
                }`}
                title="Ambient audio"
              >
                <Volume2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Results Screen ────────────────────────────────────────── */}
      <AnimatePresence>
        {phase === "result" && (
          <motion.div
            key="results"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-deeper-space/90 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.15, type: "spring", stiffness: 120, damping: 20 }}
              className="glass rounded-2xl p-8 max-w-md w-full mx-4 text-center"
            >
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-electric-violet to-neon-purple flex items-center justify-center mx-auto mb-4">
                <Brain className="w-8 h-8 text-white" />
              </div>
              <h2 className="font-heading text-2xl font-bold text-white mb-1">
                Debate Complete
              </h2>
              <p className="text-sm text-soft-gray/60 mb-6">
                Topic: {selectedTopic} • {turn + 1} exchanges
              </p>

              <div className="flex items-center justify-center gap-8 mb-6">
                <CircularScore score={score} label="Clarity" />
                <CircularScore
                  score={Math.min(score + 8, 99)}
                  label="Fluency"
                />
              </div>

              <div className="glass-subtle rounded-2xl p-4 mb-4 text-left">
                <div className="flex items-center gap-1.5 mb-2">
                  <MessageSquare className="w-3.5 h-3.5 text-electric-violet" />
                  <span className="text-xs font-medium text-electric-violet/70">
                    Coach's Note
                  </span>
                </div>
                <p className="text-xs text-soft-gray/70 leading-relaxed">
                  Great engagement! Try slowing your pace slightly during
                  counter-arguments — it gives you more time to formulate clear
                  responses and reduces filler words.
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <button
                  onClick={() => {
                    setPhase("choose");
                    setTurn(0);
                    setSelectedTopic(null);
                    setAiMessageIndex(0);
                  }}
                  className="flex items-center justify-center gap-1.5 bg-primary hover:bg-primary-hover text-white text-sm font-medium py-2.5 rounded-xl transition-all duration-200 active:scale-[0.97] cursor-pointer"
                >
                  New Debate
                  <Zap className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => navigate("/dashboard")}
                  className="text-sm text-soft-gray/60 hover:text-white transition-colors py-1"
                >
                  Back to Dashboard
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}