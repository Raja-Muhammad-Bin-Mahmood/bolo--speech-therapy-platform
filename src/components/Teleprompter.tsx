import { useMemo, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import type { TokenState, TokenDetail, DisfluencyKind } from "../hooks/useScriptMatcher";
import type { PauseEvent } from "../lib/pauseDetector";

// ─── Types ──────────────────────────────────────────────────────────────

interface TeleprompterProps {
  text: string;
  isActive: boolean;
  /** Current progress 0–1 */
  progress: number;
  /** Target phonetic graphemes to highlight */
  targets?: string[];
  speed: number;
  onProgressChange: (progress: number) => void;
  /** Live speech-driven token details (from useScriptMatcher) */
  tokenDetails?: TokenDetail[];
  /** Simple token states fallback if details not available */
  tokenStates?: TokenState[];
  /** Active token index to sync scroll position */
  activeIndex?: number;
  /** Pause markers to show between tokens */
  pauseMarkers?: { tokenIndex: number; event: PauseEvent }[];
}

// ─── Phoneme Highlighter ────────────────────────────────────────────────

function tokenizeWithTargets(
  text: string,
  targets: string[]
): { word: string; hasTarget: boolean }[] {
  const words = text.split(/\s+/);
  const lowerTargets = targets.map((t) => t.toLowerCase());

  return words.map((word) => {
    const clean = word.replace(/[^a-zA-Z]/g, "").toLowerCase();
    const hasTarget = lowerTargets.some((target) => clean.includes(target));
    return { word, hasTarget };
  });
}

// ─── Color map ──────────────────────────────────────────────────────────

/**
 * Base colors per TokenState + disfluency combination.
 * Disfluent words that matched still show the disfluency color so the
 * user sees "you said it but with a stammer/stutter".
 */
function getTokenColor(
  state: TokenState,
  disfluency?: DisfluencyKind
): { color: string; glow: string; decoration: string } {
  if (disfluency === "stammer") {
    return {
      color: "text-[#BD8CFF]",
      glow: "drop-shadow-[0_0_8px_rgba(189,140,255,0.5)]",
      decoration: "",
    };
  }
  if (disfluency === "stutter") {
    return {
      color: "text-[#F87171]",
      glow: "drop-shadow-[0_0_6px_rgba(248,113,113,0.4)]",
      decoration: "",
    };
  }
  if (disfluency === "repetition") {
    return {
      color: "text-orange-400",
      glow: "",
      decoration: "",
    };
  }
  if (disfluency === "block") {
    return {
      color: "text-amber-500",
      glow: "",
      decoration: "line-through decoration-amber-400/40",
    };
  }
  if (disfluency === "prolongation") {
    return {
      color: "text-pink-300",
      glow: "",
      decoration: "",
    };
  }

  switch (state) {
    case "unread":
      return { color: "text-soft-gray/40", glow: "", decoration: "" };
    case "current":
      return {
        color: "text-white font-medium",
        glow: "drop-shadow-[0_0_6px_rgba(255,255,255,0.25)]",
        decoration: "underline decoration-white/30 underline-offset-4 scale-[1.02]",
      };
    case "matched":
      return {
        color: "text-[#4ADE80]",
        glow: "drop-shadow-[0_0_6px_rgba(74,222,128,0.35)]",
        decoration: "",
      };
    case "disfluent":
      return { color: "text-amber-400/80", glow: "", decoration: "line-through decoration-amber-400/40" };
    case "skipped":
      return { color: "text-red-400/50", glow: "", decoration: "" };
    default:
      return { color: "", glow: "", decoration: "" };
  }
}

/** Human-readable label for tooltips */
function tokenLabel(state: TokenState, disfluency?: DisfluencyKind): string {
  if (disfluency === "stammer") return "Stammer";
  if (disfluency === "stutter") return "Stutter";
  if (disfluency === "repetition") return "Repetition";
  if (disfluency === "block") return "Block";
  if (disfluency === "prolongation") return "Prolongation";
  switch (state) {
    case "unread": return "Unread";
    case "current": return "Speaking now";
    case "matched": return "Well said ✓";
    case "disfluent": return "Disfluent";
    case "skipped": return "Skipped";
    default: return "";
  }
}

// ─── Component ──────────────────────────────────────────────────────────

export default function Teleprompter({
  text,
  isActive,
  progress,
  targets = [],
  speed,
  onProgressChange,
  tokenDetails,
  tokenStates,
  activeIndex,
  pauseMarkers = [],
}: TeleprompterProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const lastActiveIndexRef = useRef<number>(-1);
  const tokenRefs = useRef<(HTMLSpanElement | null)[]>([]);

  const tokens = useMemo(
    () => tokenizeWithTargets(text, targets),
    [text, targets]
  );

  // Map marker events by tokenIndex for quick lookup
  const pauseMap = useMemo(() => {
    const map = new Map<number, PauseEvent>();
    for (const m of pauseMarkers) {
      map.set(m.tokenIndex, m.event);
    }
    return map;
  }, [pauseMarkers]);

  // ── Speech-driven scroll: center the active token ─────────────────
  useEffect(() => {
    if (!isActive || activeIndex === undefined || activeIndex <= 0) return;
    if (activeIndex === lastActiveIndexRef.current) return;
    lastActiveIndexRef.current = activeIndex;

    const container = containerRef.current;
    const el = tokenRefs.current[activeIndex];
    if (!container || !el) return;

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    const targetScroll =
      container.scrollTop +
      elRect.top -
      containerRect.top -
      containerRect.height / 2 +
      elRect.height / 2;

    container.scrollTo({
      top: Math.max(0, targetScroll),
      behavior: "smooth",
    });

    const scrollEl = scrollRef.current;
    if (scrollEl) {
      const totalScroll = scrollEl.scrollHeight - container.clientHeight;
      if (totalScroll > 0) {
        const newProgress = Math.min(1, container.scrollTop / totalScroll);
        onProgressChange(newProgress);
      }
    }
  }, [isActive, activeIndex, onProgressChange]);

  // ── Fallback: time-based auto-scroll ──────────────────────────
  useEffect(() => {
    if (
      !isActive ||
      !scrollRef.current ||
      !containerRef.current ||
      (activeIndex !== undefined && activeIndex > 0)
    ) {
      if (activeIndex !== undefined && activeIndex >= 0) return;
      return;
    }

    const container = containerRef.current;
    const scrollEl = scrollRef.current;
    const totalScroll = scrollEl.scrollHeight - container.clientHeight;

    const animate = (timestamp: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = timestamp;
      const delta = timestamp - lastTimeRef.current;
      lastTimeRef.current = timestamp;

      const scrollSpeed = speed * 0.05;
      const currentTop = container.scrollTop;
      const next = currentTop + scrollSpeed * delta * 0.06;
      const capped = Math.min(next, totalScroll);
      container.scrollTop = capped;

      const newProgress = totalScroll > 0 ? capped / totalScroll : 0;
      onProgressChange(Math.min(newProgress, 1));

      if (capped < totalScroll) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        onProgressChange(1);
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isActive, speed, onProgressChange, activeIndex]);

  // Reset on text change
  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = 0;
    lastTimeRef.current = 0;
    lastActiveIndexRef.current = -1;
  }, [text]);

  // Sync scroll from external progress
  useEffect(() => {
    if (!containerRef.current || !scrollRef.current) return;
    if (isActive && activeIndex !== undefined && activeIndex >= 0) return;
    const totalScroll =
      scrollRef.current.scrollHeight - containerRef.current.clientHeight;
    containerRef.current.scrollTop = totalScroll * progress;
  }, [progress, isActive, activeIndex]);

  // ── Legend chips ──────────────────────────────────────────────────
  const hasDetails = tokenDetails && tokenDetails.length > 0;
  const showLegend = isActive && (hasDetails || (tokenStates && tokenStates.length > 0));

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden rounded-2xl"
      style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
    >
      {/* Legend chips */}
      {showLegend && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-sm border border-white/5">
          <span className="flex items-center gap-1 text-[9px]">
            <span className="w-2 h-2 rounded-full bg-[#4ADE80]" />
            Matched
          </span>
          <span className="w-px h-3 bg-white/10" />
          <span className="flex items-center gap-1 text-[9px]">
            <span className="w-2 h-2 rounded-full bg-amber-400/60" />
            Filler
          </span>
          <span className="w-px h-3 bg-white/10" />
          <span className="flex items-center gap-1 text-[9px]">
            <span className="w-2 h-2 rounded-full bg-[#F87171]" />
            Stutter
          </span>
          <span className="w-px h-3 bg-white/10" />
          <span className="flex items-center gap-1 text-[9px]">
            <span className="w-2 h-2 rounded-full bg-[#BD8CFF]" />
            Stammer
          </span>
          <span className="w-px h-3 bg-white/10" />
          <span className="flex items-center gap-1 text-[9px]">
            <span className="w-1.5 h-2 rounded-sm bg-white/20" />
            Pause
          </span>
        </div>
      )}

      {/* Text content */}
      <div ref={scrollRef} className="px-6 py-24">
        <p className="text-lg md:text-xl leading-[2.4] font-light tracking-wide">
          {tokens.map((token, i) => {
            const detail = hasDetails ? tokenDetails![i] : null;
            const state = detail?.state ?? tokenStates?.[i] ?? "unread";
            const disfluency = detail?.disfluency;
            const { color, glow, decoration } = getTokenColor(state, disfluency);
            const isTarget = token.hasTarget;
            const label = tokenLabel(state, disfluency);

            // Check if there's a pause marker before this token
            const pauseEvt = pauseMap.get(i);

            return (
              <span key={`token-${i}`} className="group inline">
                {/* Pause marker (rendered before the token) */}
                {pauseEvt && (
                  <span className="inline-flex items-center gap-0.5 align-middle mx-0.5">
                    <span
                      className="inline-block w-2 h-2 rounded-full"
                      style={{ backgroundColor: pauseEvt.colorToken }}
                      title={pauseEvt.reason.join(" ")}
                    />
                    <span
                      className="text-[9px] font-mono opacity-60"
                      style={{ color: pauseEvt.colorToken }}
                    >
                      {(pauseEvt.durationMs / 1000).toFixed(1)}s
                    </span>
                  </span>
                )}

                {/* Token word with tooltip */}
                <motion.span
                  ref={(el) => {
                    tokenRefs.current[i] = el;
                  }}
                  className={`inline relative transition-all duration-200 ${color} ${glow} ${
                    state === "current"
                      ? "underline decoration-white/30 underline-offset-4 scale-[1.02]"
                      : ""
                  } ${decoration} ${
                    isTarget && state === "unread" ? "text-neon-purple/80" : ""
                  } ${disfluency ? "cursor-help" : ""}`}
                  title={label}
                  whileHover={
                    isTarget && state === "unread"
                      ? { scale: 1.05, color: "#BD8CFF" }
                      : disfluency
                      ? { scale: 1.05 }
                      : undefined
                  }
                >
                  {token.word}
                  {/* Floating tooltip on hover for disfluent tokens */}
                  {disfluency && (
                    <span className="absolute -top-7 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none z-30 whitespace-nowrap px-2 py-0.5 rounded-md text-[10px] font-medium bg-black/80 border border-white/10 backdrop-blur-sm"
                    >
                      {label}
                    </span>
                  )}
                </motion.span>{" "}
              </span>
            );
          })}
        </p>
      </div>
    </div>
  );
}