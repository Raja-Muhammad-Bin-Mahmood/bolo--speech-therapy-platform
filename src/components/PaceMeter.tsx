import { memo } from "react";
import { motion } from "framer-motion";
import { Gauge, TrendingDown, TrendingUp, Minus } from "lucide-react";
import type { PaceSnapshot, PaceState, PaceTrend } from "../lib/paceEngine";

export type PaceVariant = "compact" | "full" | "debate";

interface PaceMeterProps {
  snapshot: PaceSnapshot;
  variant?: PaceVariant;
  className?: string;
}

/**
 * ONE component renders pace data for EVERY mode — only the layout
 * changes. The engine below is identical everywhere.
 *
 * - compact: small badge + mini bar (Script Mode — don't steal attention)
 * - full:    prominent bar + all readouts (Free Speech Mode)
 * - debate:  medium bar tuned for the debate HUD
 */
function PaceMeterBase({ snapshot, variant = "full", className }: PaceMeterProps) {
  if (variant === "compact") {
    return <CompactPace snapshot={snapshot} className={className} />;
  }
  if (variant === "debate") {
    return <DebatePace snapshot={snapshot} className={className} />;
  }
  return <FullPace snapshot={snapshot} className={className} />;
}

export const PaceMeter = memo(PaceMeterBase);
export default PaceMeter;

// ─── Shared pieces ───────────────────────────────────────────────────

const STATE_COLORS: Record<PaceState, string> = {
  slow: "#60A5FA",
  ideal: "#34D399",
  fast: "#FBBF24",
  unstable: "#F87171",
};

const STATE_LABELS: Record<PaceState, string> = {
  slow: "Slow",
  ideal: "Ideal",
  fast: "Fast",
  unstable: "Unstable",
};

const TREND_ICON: Record<PaceTrend, React.ComponentType<{ className?: string }>> = {
  slowing_down: TrendingDown,
  stable: Minus,
  speeding_up: TrendingUp,
};

const TREND_LABEL: Record<PaceTrend, string> = {
  slowing_down: "Slowing",
  stable: "Steady",
  speeding_up: "Speeding up",
};

/** 0–300 WPM axis with the 120–160 ideal band drawn on it */
function PaceAxis({
  wpm,
  height = "h-2",
  showMarker = true,
  markerSize = "w-3 h-3",
}: {
  wpm: number;
  height?: string;
  showMarker?: boolean;
  markerSize?: string;
}) {
  const pct = Math.min(100, Math.max(0, (wpm / 300) * 100));
  const stateColor = wpm < 120 ? "#60A5FA" : wpm > 160 ? "#FBBF24" : "#34D399";
  const isUnstable = wpm === 0;

  return (
    <div className={`relative w-full ${height} rounded-full bg-white/5 overflow-visible`}>
      {/* Zone coloring: red-ish slow, green ideal, amber fast */}
      <div className="absolute inset-0 flex rounded-full overflow-hidden">
        <div className="h-full bg-[#EF4444]/20" style={{ width: "25%" }} />
        <div className="h-full bg-[#34D399]/25" style={{ width: "13.33%" }} />
        <div className="h-full bg-[#FBBF24]/20" style={{ width: "61.67%" }} />
      </div>
      {/* Ideal band edges */}
      <div className="absolute inset-y-0 w-px bg-white/30" style={{ left: `${(120 / 300) * 100}%` }} />
      <div className="absolute inset-y-0 w-px bg-white/30" style={{ left: `${(160 / 300) * 100}%` }} />
      {/* Live marker — smooth 500ms transitions */}
      {showMarker && (
        <motion.div
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full border-2 bg-white shadow-lg ${markerSize}`}
          style={{ borderColor: isUnstable ? "#F87171" : stateColor }}
          animate={{ left: `${pct}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 18 }}
        />
      )}
    </div>
  );
}

function TrendTag({ trend }: { trend: PaceTrend }) {
  const Icon = TREND_ICON[trend];
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-soft-gray/60">
      <Icon className="w-3 h-3" />
      {TREND_LABEL[trend]}
    </span>
  );
}

// ─── Compact (Script Mode) ───────────────────────────────────────────

function CompactPace({ snapshot, className }: { snapshot: PaceSnapshot; className?: string }) {
  const color = STATE_COLORS[snapshot.paceState];
  return (
    <div className={`flex items-center gap-2.5 min-w-[120px] ${className ?? ""}`}>
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium"
        style={{
          color,
          backgroundColor: `${color}18`,
          border: `1px solid ${color}30`,
        }}
      >
        <Gauge className="w-3 h-3" />
        {snapshot.rollingWpm > 0 ? `${snapshot.rollingWpm}` : "—"} WPM
        <span className="opacity-70">· {STATE_LABELS[snapshot.paceState]}</span>
      </span>
      <div className="flex-1 min-w-[64px]">
        <PaceAxis wpm={snapshot.rollingWpm} height="h-1.5" markerSize="w-2.5 h-2.5" />
      </div>
    </div>
  );
}

// ─── Full (Free Speech Mode — most visual) ───────────────────────────

function FullPace({ snapshot, className }: { snapshot: PaceSnapshot; className?: string }) {
  const color = STATE_COLORS[snapshot.paceState];
  const clarityColor =
    snapshot.clarityScore >= 80 ? "#34D399" : snapshot.clarityScore >= 60 ? "#FBBF24" : "#F87171";

  return (
    <div className={`glass rounded-2xl p-4 ${className ?? ""}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4" style={{ color }} />
          <span className="text-xs font-medium text-white">Pace</span>
        </div>
        <div className="flex items-center gap-3">
          <TrendTag trend={snapshot.trend} />
          <span
            className="text-[10px] px-2 py-0.5 rounded-full font-mono"
            style={{ color, backgroundColor: `${color}18`, border: `1px solid ${color}30` }}
          >
            {STATE_LABELS[snapshot.paceState]}
          </span>
        </div>
      </div>

      {/* WPM readouts */}
      <div className="flex items-end gap-6 mb-3">
        <div>
          <p className="text-[10px] text-soft-gray/50 uppercase tracking-wide">Rolling</p>
          <p className="font-heading text-3xl font-bold text-white tabular-nums leading-none">
            {snapshot.rollingWpm > 0 ? snapshot.rollingWpm : "—"}
            <span className="text-xs text-soft-gray/50 ml-1">WPM</span>
          </p>
        </div>
        <div>
          <p className="text-[10px] text-soft-gray/50 uppercase tracking-wide">Current</p>
          <p className="font-heading text-lg font-semibold text-soft-gray tabular-nums leading-none">
            {snapshot.currentWpm > 0 ? snapshot.currentWpm : "—"}
            <span className="text-[10px] text-soft-gray/40 ml-1">WPM</span>
          </p>
        </div>
        <div className="ml-auto text-right">
          <p className="text-[10px] text-soft-gray/50 uppercase tracking-wide">Clarity</p>
          <p className="font-heading text-lg font-bold tabular-nums leading-none" style={{ color: clarityColor }}>
            {snapshot.clarityScore}
          </p>
        </div>
      </div>

      {/* The pace bar — rises with speed, falls with slow, band shown clearly */}
      <PaceAxis wpm={snapshot.rollingWpm} height="h-2.5" markerSize="w-3.5 h-3.5" />

      {/* Band legend + pause impact */}
      <div className="flex items-center justify-between mt-2">
        <span className="text-[9px] text-soft-gray/40">
          Ideal band 120–160 WPM
        </span>
        {snapshot.pauseImpact > 0 && (
          <span
            className="text-[9px] font-mono px-1.5 py-0.5 rounded"
            style={{
              color: "#FBBF24",
              backgroundColor: "rgba(251,191,36,0.1)",
            }}
          >
            pause impact {snapshot.pauseImpact}%
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Debate (medium — lives in the debate HUD) ───────────────────────

function DebatePace({ snapshot, className }: { snapshot: PaceSnapshot; className?: string }) {
  const color = STATE_COLORS[snapshot.paceState];
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1 text-[10px] text-soft-gray/70">
          <Gauge className="w-3 h-3" style={{ color }} />
          Pace
        </span>
        <div className="flex items-center gap-2">
          <TrendTag trend={snapshot.trend} />
          <span
            className="text-[10px] font-mono font-medium"
            style={{ color }}
          >
            {snapshot.rollingWpm > 0 ? snapshot.rollingWpm : "—"} WPM
          </span>
        </div>
      </div>
      <PaceAxis wpm={snapshot.rollingWpm} height="h-2" markerSize="w-3 h-3" />
    </div>
  );
}