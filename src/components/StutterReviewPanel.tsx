import { memo } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  Activity,
  Clock,
  TrendingUp,
  Zap,
  BarChart3,
} from "lucide-react";
import type { StutterEvent, StutterSummary } from "../lib/stutterTypes";
import { STUTTER_COLORS, STUTTER_LABELS } from "../lib/stutterTypes";

interface StutterReviewPanelProps {
  events: StutterEvent[];
  summary: StutterSummary;
}

/**
 * Review panel for the Analysis page.
 * Shows a detailed per-type breakdown, event timeline, recovery quality,
 * and phonation ratio — matching the spec's review screen requirements.
 *
 * Displayed only when stutter events exist.
 */
function StutterReviewPanelBase({ events, summary }: StutterReviewPanelProps) {
  if (events.length === 0 && summary.total === 0) return null;

  const highlighted = events.filter((e) => e.shouldHighlight);

  // ── Recovery label ──────────────────────────────────────────────
  const recoveryLabel = (() => {
    switch (summary.recoveryQuality) {
      case "quick":
        return { text: "Quick recovery", color: "#34D399", desc: "Resumed speech smoothly after events." };
      case "moderate":
        return { text: "Moderate recovery", color: "#FBBF24", desc: "Some hesitation after events, but recovered." };
      case "slow":
        return { text: "Slow recovery", color: "#F87171", desc: "Took time to resume fluent speech after events." };
      default:
        return null;
    }
  })();

  const eventTypeIcon = (type: StutterEventType) => {
    switch (type) {
      case "repetition":
        return "🔄";
      case "prolongation":
        return "↗";
      case "block":
        return "▨";
      case "tense_block":
        return "⚡";
      case "hesitation_sequence":
        return "…";
      default:
        return "·";
    }
  };

  if (highlighted.length === 0 && summary.uncertain === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.26 }}
      className="glass rounded-2xl p-5 mb-8 border border-neon-purple/10"
    >
      <h3 className="font-heading text-sm font-semibold text-white mb-4 flex items-center gap-2">
        <Activity className="w-4 h-4 text-neon-purple" />
        Stutter Analysis
        <span className="text-[10px] font-normal text-soft-gray/50 ml-1">
          — acoustic DSP
        </span>
      </h3>

      {/* Per-type breakdown */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
        <EventCountCard
          type="repetition"
          count={summary.repetitions}
        />
        <EventCountCard
          type="prolongation"
          count={summary.prolongations}
        />
        <EventCountCard
          type="block"
          count={summary.blocks}
        />
        <EventCountCard
          type="tense_block"
          count={summary.tenseBlocks}
        />
        <EventCountCard
          type="hesitation_sequence"
          count={summary.hesitationSequences}
        />
      </div>

      {/* Contextual stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatBox
          icon={Clock}
          label="Longest event"
          value={`${(summary.longestMs / 1000).toFixed(1)}s`}
          color="#C084FC"
        />
        <StatBox
          icon={TrendingUp}
          label="Flow breaks"
          value={summary.flowBreaks}
          color="#F87171"
        />
        <StatBox
          icon={Zap}
          label="Avg confidence"
          value={`${(summary.avgConfidence * 100).toFixed(0)}%`}
          color="#FBBF24"
        />
        <StatBox
          icon={BarChart3}
          label="Phonation"
          value={`${(summary.phonationRatio * 100).toFixed(0)}%`}
          color="#34D399"
        />
      </div>

      {/* Recovery quality */}
      {recoveryLabel && (
        <div
          className="glass-subtle rounded-xl px-4 py-3 mb-4 flex items-center gap-3"
          style={{
            borderLeft: `3px solid ${recoveryLabel.color}`,
          }}
        >
          <AlertTriangle
            className="w-4 h-4 shrink-0"
            style={{ color: recoveryLabel.color }}
          />
          <div>
            <p
              className="text-xs font-semibold"
              style={{ color: recoveryLabel.color }}
            >
              {recoveryLabel.text}
            </p>
            <p className="text-[10px] text-soft-gray/60">
              {recoveryLabel.desc}
            </p>
          </div>
        </div>
      )}

      {/* Uncertain events note */}
      {summary.uncertain > 0 && (
        <p className="text-[10px] text-soft-gray/40 italic">
          {summary.uncertain} uncertain event{summary.uncertain > 1 ? "s" : ""}{" "}
          detected but not highlighted (low confidence).
        </p>
      )}
    </motion.div>
  );
}

export const StutterReviewPanel = memo(StutterReviewPanelBase);

// ─── Sub-components ─────────────────────────────────────────────────────

function EventCountCard({
  type,
  count,
}: {
  type: StutterEventType;
  count: number;
}) {
  const color = STUTTER_COLORS[type];
  return (
    <div
      className="glass-subtle rounded-xl px-3 py-2.5 text-center"
      style={{
        borderColor: `${color}25`,
        borderWidth: count > 0 ? 1 : 0,
      }}
    >
      <p className="text-lg font-heading font-bold" style={{ color }}>
        {count}
      </p>
      <p className="text-[9px] text-soft-gray/50 mt-0.5 uppercase tracking-wide">
        {STUTTER_LABELS[type]}
      </p>
    </div>
  );
}

function StatBox({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: any;
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div className="glass-subtle rounded-xl px-3 py-2.5 flex items-center gap-2.5">
      <Icon className="w-3.5 h-3.5 shrink-0" style={{ color }} />
      <div>
        <p className="text-xs font-semibold text-white">{value}</p>
        <p className="text-[9px] text-soft-gray/50">{label}</p>
      </div>
    </div>
  );
}