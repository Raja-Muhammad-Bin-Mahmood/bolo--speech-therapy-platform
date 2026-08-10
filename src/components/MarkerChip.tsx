/**
 * BOLO — MarkerChip
 *
 * Animated MARKER placeholder rendered inside the live transcript AND the
 * after-session transcript at the marker's chronological position. A marker
 * is a timestamped reminder ("come back and annotate this point") — it is
 * NOT a disfluency, so it never borrows the disfluency color language
 * (purple underline / amber filler). It uses its own cyan beacon identity.
 */
import { motion, useReducedMotion } from "framer-motion";
import type { SessionMarker } from "../lib/manualAnnotations";

interface MarkerChipProps {
  marker: SessionMarker;
  compact?: boolean;
  active?: boolean;
  onClick?: () => void;
}

export default function MarkerChip({
  marker,
  compact = false,
  active = false,
  onClick,
}: MarkerChipProps) {
  const reduce = useReducedMotion();
  const time = (marker.timeMs / 1000).toFixed(1);

  const base =
    "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-mono select-none border transition-all duration-200";
  const style = {
    color: active ? "#67E8F9" : "#22D3EE",
    backgroundColor: active ? "rgba(34,211,238,0.16)" : "rgba(34,211,238,0.08)",
    borderColor: active ? "rgba(103,232,249,0.6)" : "rgba(34,211,238,0.35)",
    boxShadow: active ? "0 0 14px rgba(34,211,238,0.4)" : undefined,
  };

  return (
    <motion.span
      initial={reduce ? false : { scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 18 }}
      className={
        base + (onClick ? " cursor-pointer hover:brightness-125 active:scale-[0.97]" : "")
      }
      style={style}
      title={`Marker @ ${time}s — press SPACE during a session to drop one`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {/* Pulsing beacon — invites the user to press SPACE for markers */}
      <span className="relative flex h-1.5 w-1.5">
        <span
          className="absolute inline-flex h-full w-full rounded-full opacity-70 animate-ping"
          style={{ backgroundColor: "#22D3EE" }}
        />
        <span
          className="relative inline-flex rounded-full h-1.5 w-1.5"
          style={{ backgroundColor: "#67E8F9" }}
        />
      </span>
      {!compact && (
        <>
          <span className="uppercase tracking-wider font-semibold">Marker</span>
          <span className="opacity-70 tabular-nums">{time}s</span>
        </>
      )}
    </motion.span>
  );
}
