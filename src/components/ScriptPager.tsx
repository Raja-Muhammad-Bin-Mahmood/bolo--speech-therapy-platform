/**
 * BOLO — ScriptPager
 *
 * Page-based script display for Script Mode. The script behaves like a
 * book of continuous pages (~6 lines at a time) instead of one enormous
 * scrolling wall: as the user's LIVE reading position (the active script
 * token index from the matcher) approaches the end of the currently
 * visible section, the pager automatically advances to the next page with
 * a natural slide transition (Page 1 → Page 2 → Page 3 → …).
 *
 * Annotations are keyed by GLOBAL script-token index (not by page), so:
 *   • the speaking position + transcript/script-word mapping stay intact
 *     across page transitions
 *   • a word detected immediately before/after a flip maps to the correct
 *     script token
 *   • no annotation is lost when a page leaves the screen (flip back and
 *     it is still purple)
 *
 * The script text is preserved EXACTLY: a disfluent word is colored with
 * the existing purple disfluency styling, never replaced, and the raw
 * Deepgram stutter spelling is never printed over the script.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  WORDS_PER_LINE,
  paginateScript,
  type ScriptTokenAnnotation,
} from "../lib/scriptCorrelation";

interface ScriptPagerProps {
  text: string;
  isActive: boolean;
  /** Per-GLOBAL-token annotations (state + purple disfluency kind). */
  annotations: ScriptTokenAnnotation[];
  /** Global script-token index the speaker is currently on (or -1). */
  activeIndex: number;
  /** Phonetic target graphemes to highlight on unread words. */
  targets?: string[];
  /** Passage id — resets the pager to page 0 when it changes. */
  resetKey?: string;
}

// The existing purple disfluency styling (identical to the after-session
// transcript / live Free Speech transcript).
const PURPLE_DISFLUENT =
  "underline decoration-2 decoration-purple-400 underline-offset-4 bg-[#BD8CFF]/10 text-[#BD8CFF]/90";

export default function ScriptPager({
  text,
  isActive,
  annotations,
  activeIndex,
  targets = [],
  resetKey,
}: ScriptPagerProps) {
  const pages = useMemo(() => paginateScript(text), [text]);
  const totalPages = Math.max(1, pages.length);
  const totalTokens = useMemo(
    () => pages.reduce((n, pg) => n + (pg.end - pg.start), 0),
    [pages]
  );
  const [page, setPage] = useState(0);
  const prevResetRef = useRef(resetKey);

  // Reset to page 0 when the passage changes.
  useEffect(() => {
    if (resetKey !== prevResetRef.current) {
      prevResetRef.current = resetKey;
      setPage(0);
    }
  }, [resetKey]);

  const lowerTargets = useMemo(
    () => targets.map((t) => t.toLowerCase()),
    [targets]
  );

  // ── Automatic page advancement (speech-driven, not scroll) ─────────────
  // Advances the DISPLAYED page only — the live session (mic, Deepgram
  // socket, transcript, detectors, script position) is owned by
  // SessionScript and is never touched here.
  //
  // Two triggers, neither can starve:
  //   1. The reading position entered the last 2 lines of the current page
  //      → flip to the next page exactly once (the stale-position guard
  //      below absorbs the flip until the position crosses into the new
  //      page, so a burst of finals never flips multiple pages at once).
  //   2. The position jumped BEYOND the current page (fast reader / matcher
  //      catch-up) → jump directly to the page containing the position.
  useEffect(() => {
    if (!isActive || totalPages <= 1) return;
    const cur = pages[page];
    if (!cur) return;
    // Jump: reading position already past this page (stale — never let the
    // display lag the live position).
    if (activeIndex >= cur.end && page < totalPages - 1) {
      const targetPage = Math.min(totalPages - 1, page + 1);
      const t = setTimeout(() => setPage((p) => Math.max(p, targetPage)), 40);
      return () => clearTimeout(t);
    }
    // Flip: position in the last 2 lines of the current page.
    const threshold = Math.max(cur.start, cur.end - WORDS_PER_LINE * 2);
    if (activeIndex >= threshold && activeIndex < cur.end && page < totalPages - 1) {
      const t = setTimeout(() => setPage((p) => Math.min(totalPages - 1, p + 1)), 260);
      return () => clearTimeout(t);
    }
  }, [isActive, activeIndex, page, pages, totalPages]);

  const cur = pages[Math.min(page, totalPages - 1)];

  const tokenClass = (index: number) => {
    const ann = annotations[index];
    const disfluent = ann?.disfluency && ann.disfluency !== "filler";
    if (disfluent) return PURPLE_DISFLUENT;
    if (index === activeIndex) {
      return "text-white font-medium underline decoration-white/40 underline-offset-4 scale-[1.02]";
    }
    const word = cur?.lines.flatMap((l) => l.tokens).find((t) => t.index === index)?.word ?? "";
    const clean = word.replace(/[^a-zA-Z]/g, "").toLowerCase();
    const isTarget = lowerTargets.some((t) => clean.includes(t));
    switch (ann?.state) {
      case "matched":
        return "text-[#4ADE80]/85";
      case "skipped":
        return "text-red-400/45";
      default:
        return isTarget ? "text-neon-purple/85" : "text-soft-gray/45";
    }
  };

  const tokenTitle = (index: number) => {
    const ann = annotations[index];
    if (ann?.disfluency && ann.disfluency !== "filler") {
      return `Detected disfluency · ${ann.disfluency} (on this script word)`;
    }
    switch (ann?.state) {
      case "matched":
        return "Well said ✓";
      case "skipped":
        return "Skipped";
      case "current":
        return "Speaking now";
      default:
        return "Not yet read";
    }
  };

  return (
    <div className="glass rounded-2xl overflow-hidden relative flex flex-col" style={{ height: "336px" }}>
      {/* Top legend — minimal, unobtrusive */}
      <div className="flex items-center justify-between px-4 pt-3">
        <span className="text-[10px] uppercase tracking-wider text-soft-gray/50 font-medium">
          Script
        </span>
        <span className="inline-flex items-center gap-1.5 text-[9px] text-[#BD8CFF]/80">
          <span className="w-2 h-2 rounded-sm bg-[#BD8CFF]/70" />
          purple = detected on this word
        </span>
      </div>

      {/* Current page */}
      <div className="flex-1 px-5 py-4 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={page}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {cur ? (
              <div className="space-y-1.5">
                {cur.lines.map((line, li) => (
                  <p
                    key={li}
                    className="flex flex-wrap gap-x-1.5 gap-y-1 leading-[2.05] text-lg font-light tracking-wide"
                  >
                    {line.tokens.map((t) => (
                      <span
                        key={t.index}
                        className={`inline-block rounded px-0.5 transition-all duration-200 cursor-help ${tokenClass(t.index)}`}
                        title={tokenTitle(t.index)}
                      >
                        {t.word}
                      </span>
                    ))}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-sm text-soft-gray/50">No script text.</p>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Page footer — indicator + manual prev/next (annotations persist on
          every page; flipping back shows the same purple words). */}
      <div className="flex items-center justify-between px-4 pb-3">
        <span className="text-[10px] text-soft-gray/40 font-mono">
          Page {page + 1} / {totalPages}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            aria-label="Previous page"
            className="w-7 h-7 rounded-full glass flex items-center justify-center text-soft-gray hover:text-white transition-all duration-200 active:scale-[0.92] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            aria-label="Next page"
            className="w-7 h-7 rounded-full glass flex items-center justify-center text-soft-gray hover:text-white transition-all duration-200 active:scale-[0.92] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Reading position — thin progress strip across the whole script */}
      <div className="h-1 bg-white/5">
        <div
          className="h-full bg-gradient-to-r from-electric-violet to-neon-purple transition-all duration-300"
          style={{
            width: `${Math.min(100, ((activeIndex + 1) / Math.max(1, totalTokens)) * 100)}%`,
          }}
        />
      </div>
    </div>
  );
}
