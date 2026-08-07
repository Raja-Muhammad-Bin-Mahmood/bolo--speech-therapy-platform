/**
 * BOLO — Evidence Review Panel
 *
 * The review-screen inspector for the Confidence & Evidence Fusion Layer.
 * Shows ALL raw events with their confidence scores, suppression reasons,
 * lexical veto effects, visible annotations and hidden suppressed
 * candidates — so the team can see exactly why each event was (or wasn't)
 * rendered visibly. Purely additive: it only reads verdicts.
 */
import { memo } from "react";
import { motion } from "framer-motion";
import { ShieldCheck, Eye, EyeOff, SlidersHorizontal, Activity } from "lucide-react";
import type { ScoredEvent } from "../lib/evidenceFusion";

const BAND_COLORS = {
  strong: "#34D399",
  medium: "#FBBF24",
  feed: "#A3A3B5",
  internal: "#7A6B9B",
} as const;

interface EvidenceReviewPanelProps {
  scored: ScoredEvent[];
}

function EvidenceReviewPanelBase({ scored }: EvidenceReviewPanelProps) {
  if (scored.length === 0) return null;

  const visible = scored.filter((s) => s.visible);
  const suppressed = scored.filter((s) => !s.visible);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.33 }}
      className="glass rounded-2xl p-5 mb-8 border border-neon-purple/10"
    >
      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck className="w-4 h-4 text-neon-purple" />
        <h3 className="font-heading text-sm font-semibold text-white">
          Evidence Fusion Review
        </h3>
        <span className="ml-auto text-[10px] text-soft-gray/50 font-mono">
          {visible.length} visible · {suppressed.length} suppressed
        </span>
      </div>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {(Object.keys(BAND_COLORS) as (keyof typeof BAND_COLORS)[]).map(
          (band) => {
            const count = scored.filter((s) => s.band === band).length;
            return (
              <span
                key={band}
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-mono"
                style={{
                  color: BAND_COLORS[band],
                  backgroundColor: `${BAND_COLORS[band]}14`,
                  border: `1px solid ${BAND_COLORS[band]}28`,
                }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: BAND_COLORS[band] }}
                />
                {band}: {count}
              </span>
            );
          }
        )}
      </div>

      {/* Suppressed candidates — the valuable diagnostic */}
      {suppressed.length > 0 && (
        <div className="mb-4">
          <p className="text-[10px] uppercase tracking-wider text-soft-gray/50 font-medium mb-2 flex items-center gap-1.5">
            <EyeOff className="w-3 h-3" />
            Hidden suppressed candidates
          </p>
          <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
            {suppressed.map((s) => (
              <div
                key={s.key}
                className="glass-subtle rounded-lg px-3 py-2 text-[10px]"
              >
                <div className="flex items-center justify-between gap-2 font-mono">
                  <span style={{ color: BAND_COLORS[s.band] }}>
                    {s.event.type} · {(s.event.durationMs / 1000).toFixed(1)}s
                  </span>
                  <span className="text-soft-gray/60">
                    {(s.evidenceScore * 10).toFixed(1)} / 10
                  </span>
                </div>
                {s.suppressionReasons.length > 0 && (
                  <p className="text-soft-gray/50 mt-1 leading-snug">
                    {s.suppressionReasons.join(" · ")}
                  </p>
                )}
                {!s.interruptionPassed && (
                  <p className="text-[#FDBA74]/90 mt-0.5 flex items-center gap-1">
                    <Activity className="w-2.5 h-2.5 shrink-0" />
                    <span className="leading-snug">
                      Stage 1 gate — no interruption in speech flow
                    </span>
                  </p>
                )}
                {s.lexicalVetoApplied && (
                  <p className="text-[#F87171]/80 mt-0.5">
                    Lexical veto applied
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Visible annotations */}
      {visible.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-soft-gray/50 font-medium mb-2 flex items-center gap-1.5">
            <Eye className="w-3 h-3" />
            Visible annotations
          </p>
          <div className="flex flex-wrap gap-1.5">
            {visible.map((s) => (
              <span
                key={s.key}
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-mono"
                style={{
                  color: BAND_COLORS[s.band],
                  backgroundColor: `${BAND_COLORS[s.band]}14`,
                  border: `1px solid ${BAND_COLORS[s.band]}28`,
                }}
                title={s.matchedWord ? `on "${s.matchedWord}"` : s.event.type}
              >
                {s.event.type}
                {(s.evidenceScore * 10).toFixed(1)}
                {s.matchedWord ? ` · "${s.matchedWord}"` : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      <p className="text-[9px] text-soft-gray/40 mt-3 flex items-center gap-1.5">
        <SlidersHorizontal className="w-3 h-3" />
        Tune weights live during a session with Ctrl+Shift+D — these verdicts
        update instantly.
      </p>
    </motion.div>
  );
}

export const EvidenceReviewPanel = memo(EvidenceReviewPanelBase);
export default EvidenceReviewPanel;
