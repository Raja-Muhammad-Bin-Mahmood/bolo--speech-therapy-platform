/**
 * BOLO — StutterSpan
 *
 * The DOM/rendering requirement from the spec:
 *   <span class="stutter-annotation">b-b-b-</span>boy
 *   <span class="stutter-annotation">ssssss</span>slap
 *
 * This is the ONE component used identically in Script, Free Speech and
 * Debate modes. It reuses the existing feed color system (no new color
 * schemes), never breaks transcript alignment, and renders a soft,
 * conservative placeholder when the recovered fragment is uncertain.
 *
 * Provenance-aware:
 *   - attached   → Speechmatics word + stuttered prefix span
 *   - recovered  → local Wav2Vec2 fragment + stuttered prefix span
 *   - unresolved → soft placeholder (never an invented word)
 */
import type { RecoveredAnnotation } from "../lib/recoveryTypes";
import type { AcousticEventType } from "../hooks/useAcousticAnalysis";

// Existing feed vocabulary — SAME colors as the Detection Feed / transcript
const PREFIX_COLORS: Record<AcousticEventType, string> = {
  block: "#FDBA74",
  repetition: "#FCA5A5",
  prolongation: "#F9A8D4",
  stutter: "#F87171",
  stammer: "#BD8CFF",
};

interface StutterSpanProps {
  annotation: RecoveredAnnotation;
  /** Optional extra class for mode-specific layout (compact in Debate). */
  className?: string;
}

export default function StutterSpan({
  annotation,
  className = "",
}: StutterSpanProps) {
  const color = PREFIX_COLORS[annotation.type] ?? "#8B93A7";

  // Strong = solid styling; medium = slightly dimmed; uncertain = soft/dashed
  const bandStyle =
    annotation.band === "strong"
      ? { color, borderColor: `${color}55`, background: `${color}14` }
      : annotation.band === "medium"
        ? { color: `${color}CC`, borderColor: `${color}33`, background: `${color}0A` }
        : { color: `${color}99`, borderColor: `${color}22`, background: "transparent", borderStyle: "dashed" as const };

  const confidencePct = Math.round(annotation.confidence * 100);

  // ── Recovered fragment (local recognizer) — insert inline before word ──
  if (annotation.status === "recovered" && annotation.recoveredText) {
    return (
      <span
        className={`stutter-annotation inline-flex items-center gap-0.5 align-middle mx-0.5 ${className}`}
        title={`Recovered locally: "${annotation.recoveredText}" · ${confidencePct}% confidence · ${annotation.reason}`}
      >
        <span
          className="rounded px-1 py-px text-[11px] font-medium select-none border"
          style={bandStyle}
        >
          {annotation.prefix}
          {annotation.recoveredText}
        </span>
        <span className="text-[9px] font-mono opacity-60" style={{ color }}>
          ↺
        </span>
      </span>
    );
  }

  // ── Unresolved — conservative placeholder, never an invented word ──
  if (annotation.status === "unresolved") {
    return (
      <span
        className="stutter-annotation inline-flex items-center gap-0.5 align-middle mx-0.5 opacity-80"
        title={`${annotation.reason} · ${confidencePct}% confidence`}
      >
        <span
          className="rounded px-1.5 py-px text-[10px] font-mono select-none border border-dashed"
          style={bandStyle}
        >
          {annotation.placeholder}
        </span>
      </span>
    );
  }

  // ── Attached — stuttered prefix + the Speechmatics base word ──
  return (
    <span
      className={`stutter-annotation inline-flex items-center gap-0.5 align-middle mx-0.5 ${className}`}
      title={`${annotation.type} · ${confidencePct}% · ${annotation.reason}`}
    >
      <span
        className="rounded px-1 py-px text-[11px] font-medium select-none border"
        style={bandStyle}
      >
        {annotation.prefix}
        {annotation.baseWord}
      </span>
    </span>
  );
}
