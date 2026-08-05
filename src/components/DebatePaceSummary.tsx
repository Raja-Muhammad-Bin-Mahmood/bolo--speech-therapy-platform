import { useMemo } from "react";
import { motion } from "framer-motion";
import { Gauge, TrendingUp, TrendingDown, Minus, Zap } from "lucide-react";
import type { PaceReport, PaceSnapshot, PaceState } from "../lib/paceEngine";

interface DebatePaceSummaryProps {
  report: PaceReport;
  className?: string;
}

interface Segment {
  key: string;
  title: string;
  wpm: number;
  state: PaceState;
  description: string;
}

const STATE_COLORS: Record<PaceState, string> = {
  slow: "#60A5FA",
  ideal: "#34D399",
  fast: "#FBBF24",
  unstable: "#F87171",
};

/**
 * Debate-mode pace summary. Uses the SAME PaceReport data as every other
 * mode — only the presentation language changes. Splits the response's
 * timeline into four phases (opening / rebuttal / counterexample / closing)
 * and labels each one with how the pace felt.
 */
export default function DebatePaceSummary({ report, className }: DebatePaceSummaryProps) {
  const segments = useMemo(() => segmentTimeline(report), [report]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className={`glass-strong rounded-2xl p-4 ${className ?? ""}`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-neon-purple" />
          <span className="text-xs font-semibold text-white">Pace Under Pressure</span>
        </div>
        <span className="text-[10px] font-mono text-soft-gray/60">
          {report.totalWpm > 0 ? `${report.totalWpm} WPM avg` : "—"}
        </span>
      </div>

      {/* Four phase chips */}
      <div className="grid grid-cols-2 gap-2">
        {segments.map((seg, i) => {
          const color = STATE_COLORS[seg.state];
          return (
            <motion.div
              key={seg.key}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 + i * 0.08 }}
              className="rounded-xl px-3 py-2"
              style={{ backgroundColor: `${color}0d`, border: `1px solid ${color}22` }}
            >
              <div className="flex items-center justify-between">
                <span className="text-[9px] uppercase tracking-wide text-soft-gray/60">
                  {seg.title}
                </span>
                <span className="text-[10px] font-mono" style={{ color }}>
                  {seg.wpm > 0 ? `${seg.wpm}` : "—"}
                </span>
              </div>
              <p className="text-[10px] text-white/80 font-medium mt-0.5">
                {seg.description}
              </p>
            </motion.div>
          );
        })}
      </div>

      {/* Overall trend */}
      <div className="flex items-center gap-2 mt-3 pt-2 border-t border-white/5">
        <TrendIcon trend={report.trend} />
        <span className="text-[10px] text-soft-gray/70">
          Overall: {report.labels.trend.toLowerCase()} · {report.labels.pace}
        </span>
      </div>
    </motion.div>
  );
}

function TrendIcon({ trend }: { trend: PaceReport["trend"] }) {
  if (trend === "speeding_up")
    return <TrendingUp className="w-3.5 h-3.5 text-amber-400" />;
  if (trend === "slowing_down")
    return <TrendingDown className="w-3.5 h-3.5 text-blue-400" />;
  return <Minus className="w-3.5 h-3.5 text-emerald-400" />;
}

// ─── Timeline segmentation ───────────────────────────────────────────

function segmentTimeline(report: PaceReport): Segment[] {
  const timeline = report.timeline;
  if (timeline.length === 0) {
    return [
      { key: "opening", title: "Opening", wpm: 0, state: "ideal", description: "Awaiting your response" },
      { key: "rebuttal", title: "Rebuttal", wpm: 0, state: "ideal", description: "Awaiting your response" },
      { key: "counter", title: "Counterexample", wpm: 0, state: "ideal", description: "Awaiting your response" },
      { key: "closing", title: "Closing", wpm: 0, state: "ideal", description: "Awaiting your response" },
    ];
  }

  // Split the timeline into 4 equal quarters by timestamp
  const start = timeline[0].timestamp;
  const end = timeline[timeline.length - 1].timestamp;
  const span = Math.max(1, end - start);
  const quarters: PaceSnapshot[][] = [[], [], [], []];
  for (const entry of timeline) {
    const idx = Math.min(3, Math.floor(((entry.timestamp - start) / span) * 4));
    quarters[idx].push(entry.snapshot);
  }

  const labels: { key: string; title: string; desc: (w: number) => string }[] = [
    { key: "opening", title: "Opening", desc: (w) => pacePhrase(w) },
    { key: "rebuttal", title: "Rebuttal", desc: (w) => pacePhrase(w) },
    { key: "counter", title: "Counterexample", desc: (w) => pacePhrase(w) },
    { key: "closing", title: "Closing", desc: (w) => pacePhrase(w) },
  ];

  return labels.map((l, i) => {
    const snaps = quarters[i].filter((s) => s.rollingWpm > 0);
    const wpm =
      snaps.length > 0
        ? Math.round(snaps.reduce((a, s) => a + s.rollingWpm, 0) / snaps.length)
        : 0;
    const state: PaceState = snaps.length > 0 ? snaps[snaps.length - 1].paceState : "ideal";
    return {
      key: l.key,
      title: l.title,
      wpm,
      state,
      description: l.desc(wpm),
    };
  });
}

function pacePhrase(wpm: number): string {
  if (wpm <= 0) return "No speech yet";
  if (wpm < 120) return "hesitant start";
  if (wpm > 160) return "rushed section";
  return "controlled";
}

// ─── Re-export for use in Debate page ────────────────────────────────

export { Gauge };