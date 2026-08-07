import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Mic,
  BookOpen,
  Zap,
  ChevronRight,
  Clock,
  BarChart3,
  Flame,
  Trophy,
} from "lucide-react";
import { motion } from "framer-motion";
import LiquidBackground from "../components/LiquidBackground";
import Navbar from "../components/Navbar";
import { useAuth } from "../context/AuthContext";

interface PracticeMode {
  id: "closer" | "script" | "unprompted";
  title: string;
  description: string;
  icon: typeof Mic;
  gradient: string;
  duration: string;
  features: string[];
  route: string;
}

const modes: PracticeMode[] = [
  {
    id: "closer",
    title: "Closer Mode",
    description: "Practice realistic cold calls with AI customers. The customer interrupts, objects, and might hang up on you.",
    icon: Zap,
    gradient: "from-vibrant-indigo/20 via-neon-purple/10 to-transparent",
    duration: "2 min",
    features: ["AI customer", "Real objections", "Full sales report"],
    route: "/closer",
  },
  {
    id: "script",
    title: "Script Mode",
    description: "Read targeted passages with SLP phonetic annotations. Perfect for structured articulation and fluency practice.",
    icon: BookOpen,
    gradient: "from-electric-violet/20 via-neon-indigo/10 to-transparent",
    duration: "1-2 min",
    features: ["Phonetic targets", "Speed control", "SLP-designed"],
    route: "/session/script",
  },
  {
    id: "unprompted",
    title: "Free Practice",
    description: "Pick a random topic and speak freely. Real-time transcription, disfluency tracking, and full SLP analysis report.",
    icon: Mic,
    gradient: "from-neon-purple/20 via-vibrant-indigo/10 to-transparent",
    duration: "1-2 min",
    features: ["Topic wheel", "Live SiriLine", "Transcription + analysis"],
    route: "/session",
  },
];

// ─── Mini Progress Chart ──────────────────────────────────────────────

function ProgressChart({ history }: { history: { clarity: number; date: string }[] }) {
  if (history.length === 0) return null;
  const recent = history.slice(-14); // Last 14 sessions
  const maxClarity = Math.max(...recent.map((h) => h.clarity), 100);
  const chartH = 48;

  return (
    <div className="mt-3">
      <div className="flex items-end gap-[2px]" style={{ height: `${chartH}px` }}>
        {recent.map((h, i) => {
          const pct = (h.clarity / maxClarity) * chartH;
          return (
            <div
              key={i}
              className="flex-1 rounded-t-sm transition-all duration-500"
              style={{
                height: `${Math.max(pct, 4)}px`,
                background: `linear-gradient(to top, rgba(109,86,255,0.3), rgba(189,140,255,${0.3 + (h.clarity / 100) * 0.5}))`,
              }}
              title={`${h.clarity}% - ${new Date(h.date).toLocaleDateString()}`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[8px] text-soft-gray/30 mt-1">
        <span>{recent.length > 0 ? new Date(recent[0].date).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}</span>
        <span>Clarity Progress</span>
        <span>{recent.length > 0 ? new Date(recent[recent.length - 1].date).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}</span>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate();
  const { streak, totalSessions, averageClarity, getSessionHistory } = useAuth();
  const [selectedMode, setSelectedMode] = useState<string | null>(null);

  const handleStartSession = () => {
    const mode = modes.find((m) => m.id === selectedMode);
    if (mode) {
      navigate(mode.route);
    }
  };

  const sessionHistory = getSessionHistory();

  return (
    <div className="min-h-screen relative overflow-hidden">
      <LiquidBackground />
      <div className="relative z-10">
        <Navbar />

        <main className="pt-28 pb-16 px-4 max-w-5xl mx-auto">
          {/* Header with Gamification Stats */}
          <div className="text-center mb-8 animate-fade-in">
            <h1 className="font-heading text-3xl md:text-4xl font-bold text-white">
              Your Practice Dashboard
            </h1>
            <p className="text-soft-gray mt-3 max-w-lg mx-auto">
              Each mode targets different aspects of speech fluency. Pick the one that fits your goals today.
            </p>
          </div>

          {/* Stats Row */}
          <div className="grid grid-cols-3 gap-3 mb-10 max-w-lg mx-auto">
            <div className="glass rounded-2xl p-3 text-center">
              <div className="flex items-center justify-center gap-1 text-amber-400/80 mb-1">
                <Flame className="w-4 h-4" />
                <span className="font-heading text-lg font-bold text-white">{streak}</span>
              </div>
              <p className="text-[10px] text-soft-gray/50">Day Streak</p>
            </div>
            <div className="glass rounded-2xl p-3 text-center">
              <div className="flex items-center justify-center gap-1 text-neon-purple mb-1">
                <BarChart3 className="w-4 h-4" />
                <span className="font-heading text-lg font-bold text-white">{totalSessions}</span>
              </div>
              <p className="text-[10px] text-soft-gray/50">Sessions</p>
            </div>
            <div className="glass rounded-2xl p-3 text-center">
              <div className="flex items-center justify-center gap-1 text-electric-violet mb-1">
                <Trophy className="w-4 h-4" />
                <span className="font-heading text-lg font-bold text-white">{averageClarity}%</span>
              </div>
              <p className="text-[10px] text-soft-gray/50">Avg Clarity</p>
            </div>
          </div>

          {/* Mode Cards */}
          <div className="grid md:grid-cols-3 gap-6 mb-8">
            {modes.map((mode, i) => {
              const Icon = mode.icon;
              const isSelected = selectedMode === mode.id;
              return (
                <motion.button
                  key={mode.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 * i, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                  onClick={() => setSelectedMode(mode.id)}
                  className={`text-left glass rounded-2xl p-6 transition-all duration-300 active:scale-[0.98] group cursor-pointer ${
                    isSelected
                      ? "ring-2 ring-neon-purple/50 neon-glow-sm"
                      : "hover:translate-y-[-2px] hover:neon-glow-sm"
                  }`}
                >
                  <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${mode.gradient} flex items-center justify-center mb-4`}>
                    <Icon className="w-6 h-6 text-neon-purple" />
                  </div>
                  <h3 className="font-heading text-lg font-semibold text-white mb-1">{mode.title}</h3>
                  <p className="text-xs text-soft-gray/50 mb-3">~{mode.duration}</p>
                  <p className="text-sm text-soft-gray leading-relaxed mb-4">{mode.description}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {mode.features.map((f) => (
                      <span key={f} className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-soft-gray/60">{f}</span>
                    ))}
                  </div>
                </motion.button>
              );
            })}
          </div>

          {/* Start Button */}
          <div className="flex justify-center animate-slide-up">
            {selectedMode ? (
              <button
                onClick={handleStartSession}
                className="flex items-center gap-2 font-heading font-semibold text-white bg-primary hover:bg-primary-hover px-8 py-3.5 rounded-full transition-all duration-200 active:scale-[0.97] neon-glow cursor-pointer"
              >
                Start {modes.find((m) => m.id === selectedMode)?.title} Session
                <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <p className="text-sm text-soft-gray/40">Select a practice mode above to begin</p>
            )}
          </div>

          {/* Recent Sessions */}
          <div className="mt-16">
            <h2 className="font-heading text-xl font-semibold text-white mb-4 flex items-center gap-2">
              <Clock className="w-5 h-5 text-soft-gray" />
              Your Progress
            </h2>
            {sessionHistory.length > 0 ? (
              <div className="glass rounded-2xl p-5">
                <ProgressChart history={sessionHistory} />
                <div className="mt-4 space-y-2">
                  {sessionHistory.slice(-5).reverse().map((s, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="text-soft-gray/50">
                        {new Date(s.date).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <div className="flex items-center gap-2">
                        <div className="w-20 h-1.5 rounded-full bg-white/5 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-neon-purple to-electric-violet transition-all"
                            style={{ width: `${s.clarity}%` }}
                          />
                        </div>
                        <span className="text-white font-mono w-8 text-right">{s.clarity}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="glass rounded-2xl p-8 text-center">
                <BarChart3 className="w-8 h-8 text-soft-gray/30 mx-auto mb-3" />
                <p className="text-soft-gray/50 text-sm">
                  No sessions yet. Complete your first practice to see your progress here.
                </p>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}