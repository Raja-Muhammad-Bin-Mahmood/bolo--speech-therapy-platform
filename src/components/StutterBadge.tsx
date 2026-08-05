import { memo } from "react";
import type { StutterEvent } from "../lib/stutterTypes";
import { STUTTER_COLORS, STUTTER_LABELS } from "../lib/stutterTypes";

interface StutterBadgeProps {
  event: StutterEvent;
  /** Show the duration in the badge */
  showDuration?: boolean;
  /** Size variant */
  size?: "sm" | "md";
  className?: string;
}

/**
 * An inline stutter badge rendered next to the transcript or in the summary.
 * Shows the event type label with its stable color and a tooltip.
 */
function StutterBadgeBase({
  event,
  showDuration = true,
  size = "sm",
  className = "",
}: StutterBadgeProps) {
  const color = STUTTER_COLORS[event.eventType];
  const label = STUTTER_LABELS[event.eventType];
  const isSmall = size === "sm";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded ${
        isSmall ? "px-1 py-0.5 text-[9px]" : "px-1.5 py-0.5 text-[10px]"
      } font-mono transition-colors duration-200 select-none ${className}`}
      style={{
        color,
        backgroundColor: `${color}18`,
        border: `1px solid ${color}30`,
      }}
      title={event.reason.join(" · ")}
    >
      {/* Dot indicator */}
      <span
        className={`inline-block rounded-full shrink-0 ${
          isSmall ? "w-1 h-1" : "w-1.5 h-1.5"
        }`}
        style={{ backgroundColor: color }}
      />
      <span>{label}</span>
      {showDuration && (
        <span className="opacity-70">
          {event.durationMs > 0
            ? `${(event.durationMs / 1000).toFixed(1)}s`
            : ""}
        </span>
      )}
    </span>
  );
}

export const StutterBadge = memo(StutterBadgeBase);

export { STUTTER_COLORS, STUTTER_LABELS } from "../lib/stutterTypes";