import { useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Zap,
  BarChart3,
  Brain,
  MessageSquare,
  Lightbulb,
  RotateCcw,
  Gauge,
} from "lucide-react";
import Navbar from "../components/Navbar";

// ─── Stat Card ──────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: string | number;
  icon: any;
  color: string;
}) {
  return (
    <div className="glass rounded-2xl p-4 flex items-center gap-3">
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0`}
        style={{
          background: `linear-gradient(135deg, ${color}20, ${color}08)`,
        }}
      >
        <Icon className="w-5 h-5" style={{ color }} />
      </div>
      <div>
        <p className="text-xs text-soft-gray/50">{label}</p>
        <p className="text-lg font-semibold text-white">{value}</p>
      </div>
    </div>
  );
}

// ─── Score Ring Summary ────────────────────────────────────────────────

/**
 * Interpolate ring color from dark purple (#2e1a47) at low scores to
 * bright purple (#a855f7) near 100 — the Phase 5 progress-ring spec.
 */
function interpolateScoreColor(value: number): string {
  const c1 = { r: 0x2e, g: 0x1a, b: 0x47 }; // #2e1a47
  const c2 = { r: 0xa8, g: 0x55, b: 0xf7 }; // #a855f7
  const t = Math.max(0, Math.min(100, value)) / 100;
  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const b = Math.round(c1.b + (c2.b - c1.b) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function ScoreRing({
  value,
  label,
  radius = 32,
  strokeWidth = 4,
  glow = true,
}: {
  value: number;
  label: string;
  radius?: number;
  strokeWidth?: number;
  glow?: boolean;
}) {
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - value / 100);
  const color = interpolateScoreColor(value);

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative">
        <svg
          width={(radius + strokeWidth) * 2}
          height={(radius + strokeWidth) * 2}
          className="-rotate-90"
        >
          <circle
            cx={radius + strokeWidth}
            cy={radius + strokeWidth}
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.04)"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={radius + strokeWidth}
            cy={radius + strokeWidth}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-all duration-1000"
            style={{
              filter: glow
                ? `drop-shadow(0 0 6px ${color}40)`
                : undefined,
            }}
          />
        </svg>
        <span
          className="absolute inset-0 flex items-center justify-center font-heading text-xl font-bold text-white"
        >
          {value}
        </span>
      </div>
      <span className="text-[10px] text-soft-gray/50">{label}</span>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────

export default function Analysis() {
  const location = useLocation();
  const navigate = useNavigate();
  const data = location.state as any;

  // Default values if navigating directly
  const clarityScore = data?.clarityScore ?? 0;
  const fluencyScore = data?.fluencyScore ?? 0;
  const totalWords = data?.totalWords ?? 0;
  const disfluentWords = data?.disfluentWords ?? 0;
  const disfluencyRate = data?.disfluencyRate ?? 0;
  const longestPhrase = data?.longestPhrase ?? 0;
  const avgWordsPerBurst = data?.avgWordsPerBurst ?? 0;
  const topFiller = data?.topFiller ?? "none";
  const fillerWords: Record<string, number> = data?.fillerWords ?? {};
  const topic = data?.topic ?? "General";

  const overallScore = data?.overallScore ?? Math.round((clarityScore + fluencyScore) / 2);

  // ── Phase 5 new metrics ─────────────────────────────────────────
  const stutters = data?.stutters ?? 0;
  const stammers = data?.stammers ?? 0;
  const pauseStats = data?.pauses ?? {
    total: 0,
    thinking: 0,
    awkward: 0,
    severe: 0,
    totalMs: 0,
    longestMs: 0,
    avgMs: 0,
  };

  // ── Pace engine data (from Phase 5 shared engine) ────────────────
  const wpm = data?.wpm ?? 0;
  const paceZone: "green" | "yellow" | "orange" | "red" = data?.paceZone ?? "green";
  const paceLabel: string = data?.paceLabel ?? "";
  const reasons: string[] = Array.isArray(data?.reasons) ? data.reasons : [];

  const PACE_COLORS: Record<string, string> = {
    green: "#34D399",
    yellow: "#FBBF24",
    orange: "#FB923C",
    red: "#EF4444",
  };
  const PACE_SEGMENTS = [
    { min: 0, max: 75, color: "#EF4444" },
    { min: 75, max: 95, color: "#FB923C" },
    { min: 95, max: 120, color: "#FBBF24" },
    { min: 120, max: 160, color: "#34D399" },
    { min: 160, max: 185, color: "#FBBF24" },
    { min: 185, max: 210, color: "#FB923C" },
    { min: 210, max: 300, color: "#EF4444" },
  ];
  // Where the current WPM sits on the 0–300 pace axis
  const pacePositionPct = Math.min(100, Math.max(0, (wpm / 300) * 100));

  // Generate a coach's note
  const getCoachNote = () => {
    if (disfluencyRate > 15) {
      return `You used filler words in ${disfluencyRate}% of your speech — that's higher than average. Try pausing silently instead of using "${topFiller}" to give yourself time to think.`;
    }
    if (disfluencyRate > 8) {
      return `Your disfluency rate is ${disfluencyRate}%, which is moderate. Focus on reducing "${topFiller}" — try replacing it with a brief pause.`;
    }
    if (avgWordsPerBurst < 5) {
      return `Your speech bursts are shorter than ideal (avg ${avgWordsPerBurst} words). Try connecting more thoughts between pauses for smoother delivery.`;
    }
    return `Great session! Your clarity is solid with only ${disfluencyRate}% disfluency. To level up, try speaking on more complex topics to stretch your fluency.`;
  };

  // Empty state
  if (!data) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-deep-space">
        <Navbar />
        <div className="relative z-10 pt-28 pb-16 px-4 max-w-lg mx-auto text-center">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-soft-gray/20 to-soft-gray/10 flex items-center justify-center mx-auto mb-4">
            <BarChart3 className="w-8 h-8 text-soft-gray/30" />
          </div>
          <h2 className="font-heading text-xl font-bold text-white mb-2">
            No Session Data
          </h2>
          <p className="text-sm text-soft-gray/60 mb-6">
            Complete a recording session first to see your analysis.
          </p>
          <button
            onClick={() => navigate("/session")}
            className="inline-flex items-center gap-1.5 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-6 py-2.5 rounded-xl transition-all duration-200 active:scale-[0.97] cursor-pointer"
          >
            Start a Session
            <Zap className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative overflow-hidden bg-deep-space">
      <Navbar />

      {/* Background orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-electric-violet/5 blur-[120px]" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-neon-purple/5 blur-[120px]" />
      </div>

      <main className="relative z-10 pt-24 pb-16 px-4 max-w-3xl mx-auto">
        {/* Back button */}
        <button
          onClick={() => navigate("/dashboard")}
          className="inline-flex items-center gap-1.5 text-sm text-soft-gray hover:text-white transition-colors mb-6 cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Dashboard
        </button>

        {/* Overall Score Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-10"
        >
          <div className="w-20 h-20 rounded-full bg-gradient-to-br from-electric-violet to-neon-purple flex items-center justify-center mx-auto mb-4 shadow-[0_0_40px_rgba(109,86,255,0.3)]">
            <Brain className="w-10 h-10 text-white" />
          </div>
          <h1 className="font-heading text-2xl md:text-3xl font-bold text-white mb-1">
            Session Complete
          </h1>
          <p className="text-sm text-soft-gray/60">Topic: {topic}</p>
        </motion.div>

        {/* Score Rings */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="flex items-center justify-center gap-8 md:gap-12 mb-10"
        >
          <ScoreRing value={overallScore} label="Overall" radius={40} strokeWidth={5} />
          <ScoreRing value={clarityScore} label="Clarity" radius={32} strokeWidth={4} />
          <ScoreRing value={fluencyScore} label="Fluency" radius={32} strokeWidth={4} />
        </motion.div>

        {/* Stats Grid */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8"
        >
          <StatCard
            label="Total Words"
            value={totalWords.toLocaleString()}
            icon={MessageSquare}
            color="#BD8CFF"
          />
          <StatCard
            label="Disfluencies"
            value={disfluentWords}
            icon={BarChart3}
            color="#FF6B6B"
          />
          <StatCard
            label="Disfluency Rate"
            value={`${disfluencyRate}%`}
            icon={Brain}
            color="#FBBF24"
          />
          <StatCard
            label="Longest Phrase"
            value={`${longestPhrase} words`}
            icon={Lightbulb}
            color="#22D3EE"
          />
        </motion.div>

        {/* Additional Stats */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="grid grid-cols-2 gap-3 mb-8"
        >
          <StatCard
            label="Stutters"
            value={stutters}
            icon={Zap}
            color="#F87171"
          />
          <StatCard
            label="Stammers"
            value={stammers}
            icon={Zap}
            color="#BD8CFF"
          />
          <StatCard
            label="Avg Words per Burst"
            value={avgWordsPerBurst}
            icon={Zap}
            color="#6D56FF"
          />
          <StatCard
            label="Top Filler Word"
            value={topFiller === "none" ? "None — great!" : `"${topFiller}"`}
            icon={MessageSquare}
            color={topFiller === "none" ? "#34D399" : "#FBBF24"}
          />
        </motion.div>

        {/* Pause Summary */}
        {pauseStats.total > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.27 }}
            className="glass rounded-2xl p-5 mb-8"
          >
            <h3 className="font-heading text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-soft-gray" />
              Pause Analysis
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="text-center">
                <p className="text-lg font-bold font-mono text-white">
                  {pauseStats.total}
                </p>
                <p className="text-[10px] text-soft-gray/50">Total Pauses</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-bold font-mono text-blue-400">
                  {pauseStats.thinking}
                </p>
                <p className="text-[10px] text-soft-gray/50">Thinking</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-bold font-mono text-amber-400">
                  {pauseStats.awkward}
                </p>
                <p className="text-[10px] text-soft-gray/50">Awkward</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-bold font-mono text-orange-400">
                  {pauseStats.severe}
                </p>
                <p className="text-[10px] text-soft-gray/50">Severe</p>
              </div>
            </div>
            <div className="flex items-center justify-center gap-4 mt-3 text-[10px] text-soft-gray/60">
              <span>Avg {(pauseStats.avgMs / 1000).toFixed(1)}s</span>
              <span className="w-px h-3 bg-white/10" />
              <span>Longest {(pauseStats.longestMs / 1000).toFixed(1)}s</span>
              <span className="w-px h-3 bg-white/10" />
              <span>Total {(pauseStats.totalMs / 1000).toFixed(1)}s hesitation</span>
            </div>
          </motion.div>
        )}

        {/* Speaking Pace */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.28 }}
          className="glass rounded-2xl p-5 mb-8"
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-heading text-sm font-semibold text-white flex items-center gap-2">
              <Gauge className="w-4 h-4 text-soft-gray" />
              Speaking Pace
            </h3>
            <span
              className="text-lg font-bold font-mono"
              style={{ color: PACE_COLORS[paceZone] }}
            >
              {wpm > 0 ? `${wpm} WPM` : "—"}
            </span>
          </div>

          {/* Pace axis: red → orange → yellow → green(120–160) → … */}
          <div className="relative h-2.5 rounded-full overflow-hidden bg-white/5 mb-2">
            <div className="absolute inset-0 flex">
              {PACE_SEGMENTS.map((seg, i) => {
                const widthPct = ((seg.max - seg.min) / 300) * 100;
                return (
                  <div
                    key={i}
                    className="h-full opacity-60"
                    style={{
                      width: `${widthPct}%`,
                      backgroundColor: seg.color,
                      marginLeft: i === 0 ? 0 : undefined,
                    }}
                  />
                );
              })}
            </div>
            {/* Marker for the 120–160 target band */}
            <div
              className="absolute inset-y-0 w-0.5 bg-white/70"
              style={{ left: `${(120 / 300) * 100}%` }}
            />
            <div
              className="absolute inset-y-0 w-0.5 bg-white/70"
              style={{ left: `${(160 / 300) * 100}%` }}
            />
            {/* Current WPM marker */}
            {wpm > 0 && (
              <div
                className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white border-2 shadow-lg transition-all duration-500"
                style={{
                  borderColor: PACE_COLORS[paceZone],
                  left: `calc(${pacePositionPct}% - 7px)`,
                }}
              />
            )}
          </div>
          <p className="text-xs text-soft-gray/70 leading-relaxed">
            {paceLabel ||
              (wpm >= 120 && wpm <= 160
                ? "Great pace — inside the 120–160 WPM target band."
                : "Keep talking — pace updates as you go.")}
          </p>
        </motion.div>

        {/* Why the score moved */}
        {reasons.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.32 }}
            className="glass rounded-2xl p-5 mb-8 border border-neon-purple/10"
          >
            <h3 className="font-heading text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <Brain className="w-4 h-4 text-neon-purple" />
              Why These Scores
            </h3>
            <ul className="space-y-2">
              {reasons.map((r, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-sm text-soft-gray leading-relaxed"
                >
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-neon-purple/70 shrink-0" />
                  {r}
                </li>
              ))}
            </ul>
          </motion.div>
        )}

        {/* Filler Word Breakdown */}
        {Object.keys(fillerWords).length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="glass rounded-2xl p-5 mb-8"
          >
            <h3 className="font-heading text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-soft-gray" />
              Filler Word Breakdown
            </h3>
            <div className="space-y-2">
              {Object.entries(fillerWords)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 6)
                .map(([word, count]) => {
                  const maxCount = Math.max(
                    ...Object.values(fillerWords),
                    1
                  );
                  const pct = (count / maxCount) * 100;
                  return (
                    <div
                      key={word}
                      className="flex items-center gap-3 text-sm"
                    >
                      <span className="w-16 text-right text-soft-gray/60 font-mono text-xs">
                        x{count}
                      </span>
                      <span className="w-20 text-white/80 font-medium">
                        "{word}"
                      </span>
                      <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-neon-purple to-electric-violet transition-all duration-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          </motion.div>
        )}

        {/* Coach's Note */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
          className="glass-strong rounded-2xl p-5 mb-8 border border-neon-purple/10"
        >
          <div className="flex items-center gap-2 mb-3">
            <Lightbulb className="w-4 h-4 text-amber-400" />
            <h3 className="font-heading text-sm font-semibold text-white">
              Coach's Note
            </h3>
          </div>
          <p className="text-sm text-soft-gray leading-relaxed">
            {getCoachNote()}
          </p>
        </motion.div>

        {/* Action buttons */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="flex flex-col sm:flex-row gap-3 justify-center"
        >
          <button
            onClick={() => navigate("/session")}
            className="flex items-center justify-center gap-1.5 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-6 py-3 rounded-xl transition-all duration-200 active:scale-[0.97] cursor-pointer"
          >
            Practice Again
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => navigate("/dashboard")}
            className="flex items-center justify-center gap-1.5 glass text-soft-gray hover:text-white text-sm font-medium px-6 py-3 rounded-xl transition-all duration-200 active:scale-[0.97] cursor-pointer"
          >
            Go to Dashboard
          </button>
        </motion.div>
      </main>
    </div>
  );
}