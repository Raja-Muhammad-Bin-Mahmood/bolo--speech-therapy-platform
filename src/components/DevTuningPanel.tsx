/**
 * BOLO — Developer Tuning Panel (hidden, live evidence-fusion tuning)
 *
 * Toggle: Ctrl + Shift + D   (also Escape to close)
 *
 * Fixed-position panel, hidden by default, safe to leave off in
 * production. Every slider writes straight into the Evidence Tuning
 * context, so scoring updates live while a session is recording —
 * no reload, no rebuild. Shows the live verdict of the most recent
 * scored event so false positives can be tuned away in real time.
 */
import { useEffect, useState } from "react";
import { X, RotateCcw, SlidersHorizontal, ShieldCheck } from "lucide-react";
import { useEvidenceTuning } from "../context/EvidenceTuningContext";
import {
  EVIDENCE_WEIGHT_META,
  type EvidenceWeights,
  type EvidenceBand,
} from "../lib/evidenceFusion";

const BAND_COLORS: Record<EvidenceBand, string> = {
  strong: "#34D399",
  medium: "#FBBF24",
  feed: "#A3A3B5",
  internal: "#7A6B9B",
};

const RECOVERY_COLORS = {
  strong: "#34D399",
  moderate: "#FBBF24",
  weak: "#F87171",
  none: "#A3A3B5",
};

export default function DevTuningPanel() {
  const { weights, setWeight, resetWeights, recent } = useEvidenceTuning();
  const [open, setOpen] = useState(false);

  // ── Global hotkey: Ctrl + Shift + D ───────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  const latest = recent[0] ?? null;

  return (
    <div
      role="region"
      aria-label="Evidence fusion developer tuning panel"
      className="fixed bottom-4 right-4 z-[70] w-[340px] max-h-[86vh] overflow-y-auto glass-strong rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
      style={{ scrollbarWidth: "thin" }}
    >
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-[#121026]/95 backdrop-blur-md">
        <SlidersHorizontal className="w-4 h-4 text-neon-purple shrink-0" />
        <div className="min-w-0">
          <p className="text-xs font-heading font-semibold text-white leading-none">
            Evidence Fusion — Dev Tuning
          </p>
          <p className="text-[9px] text-soft-gray/50 mt-1 leading-none">
            Ctrl+Shift+D · raw detector unchanged — gates visibility only
          </p>
        </div>
        <button
          onClick={resetWeights}
          title="Reset weights to defaults"
          aria-label="Reset weights to defaults"
          className="ml-auto p-1.5 rounded-lg text-soft-gray/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setOpen(false)}
          title="Close (Esc)"
          aria-label="Close tuning panel"
          className="p-1.5 rounded-lg text-soft-gray/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Live sliders */}
      <div className="px-4 py-3 space-y-3">
        {(Object.keys(EVIDENCE_WEIGHT_META) as (keyof EvidenceWeights)[]).map((key) => {
          const meta = EVIDENCE_WEIGHT_META[key];
          const value = weights[key];
          return (
            <div key={key}>
              <div className="flex items-baseline justify-between mb-1">
                <label
                  htmlFor={`ev-${key}`}
                  className="text-[10px] text-soft-gray/80 font-medium"
                  title={meta.hint}
                >
                  {meta.label}
                </label>
                <span className="text-[10px] font-mono text-neon-purple tabular-nums">
                  {meta.step >= 1 ? Math.round(value) : value.toFixed(2)}
                </span>
              </div>
              <input
                id={`ev-${key}`}
                type="range"
                min={meta.min}
                max={meta.max}
                step={meta.step}
                value={value}
                onChange={(e) => setWeight(key, Number(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none bg-white/10 accent-[#BD8CFF] cursor-pointer"
                aria-describedby={`ev-${key}-hint`}
              />
              <p id={`ev-${key}-hint`} className="text-[8px] text-soft-gray/35 mt-0.5">
                {meta.hint}
              </p>
            </div>
          );
        })}
      </div>

      {/* Live verdict readout */}
      <div className="px-4 pb-4">
        <div className="glass-subtle rounded-xl p-3">
          <p className="text-[9px] uppercase tracking-wider text-soft-gray/50 font-medium mb-2 flex items-center gap-1.5">
            <ShieldCheck className="w-3 h-3 text-neon-purple" />
            Live verdict — most recent event
          </p>
          {latest ? (
            <dl className="space-y-1.5 font-mono text-[10px] leading-relaxed">
              <Row label="Event type" value={latest.event.type} color="#BD8CFF" />
              <Row
                label="Evidence score"
                value={`${(latest.evidenceScore * 10).toFixed(1)} / 10`}
                color={BAND_COLORS[latest.band]}
              />
              <Row
                label="Band"
                value={latest.band}
                color={BAND_COLORS[latest.band]}
              />
              <Row
                label="Suppressed by lexical veto"
                value={latest.lexicalVetoApplied ? "yes" : "no"}
                color={latest.lexicalVetoApplied ? "#F87171" : "#34D399"}
              />
              <Row
                label="Recovery quality"
                value={latest.recoveryLabel}
                color={RECOVERY_COLORS[latest.recoveryLabel]}
              />
              <Row
                label="Visible annotation"
                value={latest.visible ? "yes" : "no"}
                color={latest.visible ? "#34D399" : "#F87171"}
              />
              {latest.matchedWord && (
                <Row label="Matched word" value={`"${latest.matchedWord}"`} color="#A3A3B5" />
              )}
              {!latest.visible && latest.suppressionReasons.length > 0 && (
                <p className="pt-1 text-[9px] text-soft-gray/60 font-sans leading-snug">
                  {latest.suppressionReasons.join(" · ")}
                </p>
              )}
            </dl>
          ) : (
            <p className="text-[10px] text-soft-gray/40">
              No events scored yet — start a session and speak. Every raw
              detector event shows up here with its live verdict.
            </p>
          )}
        </div>

        {/* Recent event list (band chips) */}
        {recent.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {recent.slice(0, 10).map((s) => (
              <span
                key={s.key}
                className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[8px] font-mono"
                style={{
                  color: BAND_COLORS[s.band],
                  backgroundColor: `${BAND_COLORS[s.band]}14`,
                  border: `1px solid ${BAND_COLORS[s.band]}28`,
                }}
                title={s.event.type}
              >
                {s.suppressed ? "suppressed" : s.band}
              </span>
            ))}
          </div>
        )}

        <p className="mt-3 text-[8px] text-soft-gray/35 leading-snug">
          Only the transcript rendering is filtered. Every raw event still
          reaches the Detection Feed and Review Screen. Medium-band events go
          visible only when independent signals agree.
        </p>
      </div>
    </div>
  );
}

function Row({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-soft-gray/60">{label}</dt>
      <dd className="font-medium tabular-nums truncate" style={{ color }}>
        {value}
      </dd>
    </div>
  );
}
