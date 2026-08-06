import { memo } from "react";
import type { FeedEvent } from "../lib/feedEvents";

interface FeedChipProps {
  event: FeedEvent;
  /** Show the duration inside the chip (same as the Detection Feed) */
  showDuration?: boolean;
}

/**
 * The exact chip style used by the Detection Feed — shared by the live
 * transcript (free speech), the script teleprompter (script mode) and the
 * post-session review. Feed and transcript therefore always agree.
 */
function FeedChipBase({ event, showDuration = true }: FeedChipProps) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-mono select-none transition-colors duration-200"
      style={{
        color: event.color,
        backgroundColor: `${event.color}18`,
        border: `1px solid ${event.color}30`,
      }}
      title={`${event.label} — ${(event.durationMs / 1000).toFixed(1)}s`}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ backgroundColor: event.color }}
      />
      {event.label}
      {showDuration && (
        <span className="opacity-80">
          {(event.durationMs / 1000).toFixed(1)}s
        </span>
      )}
    </span>
  );
}

export const FeedChip = memo(FeedChipBase);
export default FeedChip;
