/**
 * BOLO — StutterSpan (lexical word + badge)
 *
 * Rendering rule (mission):
 *   sssssslap    →  slap  + "prolongation" badge
 *   b-b-b-boy    →  boy   + "repetition" badge
 *   bbhhlock     →  lock  + "block"/"stammer" badge
 *
 * The transcript NEVER shows raw phonetic characters (no "ssss", no
 * "b-b-b-"). This component renders the LEXICAL word plus a small
 * structured label/marker. The stutter evidence itself lives in the
 * badge + tooltip, never in the text.
 *
 * Provenance-aware:
 *   - attached   → Speechmatics word + badge (Case A/C)
 *   - recovered  → local fallback word + badge (Case B)
 *   - unresolved → BLOCKS render a visible "[Block]" marker (the intended
 *                  word must NEVER disappear — the block stays on screen,
 *                  and when the following word finalizes it attaches to it).
 *                  Other unresolved types are suppressed (never a made-up
 *                  placeholder like "[unrecognized stutter]").
 *
 * Reuses the existing feed color system — no new color schemes.
 */
import type { RecoveredAnnotation } from "../lib/recoveryTypes";
import type { AcousticEventType } from "../hooks/useAcousticAnalysis";

// Existing feed vocabulary — SAME colors as the Detection Feed / transcript
const BADGE_COLORS: Record<AcousticEventType, string> = {
  block: "#FDBA74",
  repetition: "#FCA5A5",
  prolongation: "#F9A8D4",
  stutter: "#F87171",
  stammer: "#BD8CFF",
};

/** Label shown on the badge (structured marker, never phonetic text). */
const BADGE_LABELS: Record<AcousticEventType, string> = {
  block: "Block",
  repetition: "Repeat",
  prolongation: "Prolong",
  stutter: "Stutter",
  stammer: "Stammer",
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
  const color = BADGE_COLORS[annotation.type] ?? "#8B93A7";

  // Strong = solid styling; medium = slightly dimmed; uncertain = soft/dashed
  const bandStyle =
    annotation.band === "strong"
      ? { color, borderColor: `${color}55`, background: `${color}14` }
      : annotation.band === "medium"
        ? { color: `${color}CC`, borderColor: `${color}33`, background: `${color}0A` }
        : { color: `${color}99`, borderColor: `${color}22`, background: "transparent", borderStyle: "dashed" as const };

  const confidencePct = Math.round(annotation.confidence * 100);
  const label = annotation.label ?? BADGE_LABELS[annotation.type] ?? annotation.type;

  // ── Unresolved — nothing confident was recovered. ────────────────────
  // BLOCKS stay visible: the intended word must NEVER vanish from the
  // transcript. A `[Block]` marker renders with its duration, and the
  // following word (which the block released into) attaches right after it.
  if (annotation.status === "unresolved") {
    if (annotation.type !== "block") return null;
    const marker = annotation.placeholder ?? "Block";
    return (
      <span
        className={`stutter-annotation inline-flex items-center gap-1 align-middle mx-0.5 ${className}`}
        title={`${label} · ${confidencePct}% · ${annotation.reason}`}
      >
        <span
          className="rounded-md px-1.5 py-px text-[13px] font-medium select-none border"
          style={bandStyle}
        >
          {marker}
        </span>
        <span
          className="rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide select-none border"
          style={{
            color,
            borderColor: `${color}33`,
            background: `${color}0D`,
          }}
        >
          {label}
        </span>
        <span className="text-[9px] font-mono opacity-70">
          {(annotation.durationMs / 1000).toFixed(1)}s
        </span>
      </span>
    );
  }

  // ── Attached (Speechmatics word) or recovered (local word) ──────────
  // Render the LEXICAL word + the structured label badge. The raw stutter
  // prefix (ssss / b-b-b-) is metadata only — shown in the tooltip, never
  // in the transcript text.
  const lexicalWord =
    annotation.status === "recovered"
      ? annotation.recoveredText
      : annotation.baseWord;

  return (
    <span
      className={`stutter-annotation inline-flex items-center gap-1 align-middle mx-0.5 ${className}`}
      title={`${label} · ${confidencePct}% · ${annotation.reason}${
        annotation.prefix ? ` · spoken: “${annotation.prefix}”` : ""
      }`}
    >
      <span
        className="rounded-md px-1.5 py-px text-[13px] font-medium select-none border"
        style={bandStyle}
      >
        {lexicalWord}
      </span>
      <span
        className="rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide select-none border"
        style={{
          color,
          borderColor: `${color}33`,
          background: `${color}0D`,
        }}
      >
        {label}
      </span>
    </span>
  );
}
