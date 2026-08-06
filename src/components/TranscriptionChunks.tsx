import { useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { TranscriptChunk } from "../hooks/useSpeechmaticsWS";
import type { DisfluencyTag } from "../hooks/useSessionAnalysis";
import type { PauseEvent } from "../lib/pauseDetector";
import type { FeedEvent } from "../lib/feedEvents";
import { assignEventsToSpans } from "../lib/feedEvents";
import FeedChip from "./FeedChip";

interface TranscriptionChunksProps {
  transcripts: TranscriptChunk[];
  /** Fusion tag lookup, keyed by `${round(startMs)}-${round(endMs)}` */
  wordTags?: Map<string, DisfluencyTag>;
  /** Pause events to render as inline badges (sorted by startTime) */
  pauseEvents?: PauseEvent[];
  /**
   * Existing detector events (the SAME list the Detection Feed renders).
   * Mapped onto finalized words by timestamp overlap — the renderer only
   * visualizes these; it never creates new events.
   */
  events?: FeedEvent[];
  /** Safety-net max words per line */
  maxWordsPerLine?: number;
}

/**
 * Live transcription rendered as "utterance lines".
 *
 * Words are colored by the fusion layer: fillers come from Speechmatics
 * tags; blocks / repetitions / prolongations / stutters / stammers come
 * from the acoustic layer. Pauses render as inline badges with their
 * own color family (natural → thinking → awkward → severe).
 */
export default function TranscriptionChunks({
  transcripts,
  wordTags,
  pauseEvents = [],
  events = [],
  maxWordsPerLine = 16,
}: TranscriptionChunksProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(0);

  const lines = buildLines(
    transcripts,
    wordTags,
    pauseEvents,
    events,
    maxWordsPerLine
  );

  // Auto-scroll to latest
  useEffect(() => {
    if (transcripts.length > prevLengthRef.current) {
      containerRef.current?.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
    prevLengthRef.current = transcripts.length;
  }, [transcripts.length]);

  if (lines.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <p className="text-xs text-soft-gray/30 text-center">
          {transcripts.length > 0 ? "Processing..." : "Waiting for speech..."}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="w-full max-h-[200px] overflow-y-auto scrollbar-thin space-y-2.5 pr-2"
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence mode="popLayout">
        {lines.map((line) => (
          <motion.div
            key={line.id}
            initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-wrap gap-x-1.5 gap-y-1 text-sm leading-relaxed px-3 py-2 rounded-xl glass-subtle"
          >
            {line.items.map((item, wi) =>
              item.kind === "pause" ? (
                <PauseBadge key={wi} event={item.event} />
              ) : (
                <WordSpan key={wi} word={item.word} />
              )
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ─── Word rendering with fusion coloring ───────────────────────────────

interface LineWord {
  text: string;
  isFinal: boolean;
  tag: DisfluencyTag | null;
  startTime: number; // seconds — for pause badge placement
  /** Existing detector events mapped onto this word (feed-style chips) */
  events?: FeedEvent[];
}

const TAG_STYLES: Record<DisfluencyTag, string> = {
  filler: "text-amber-300/90 bg-amber-300/10",
  block: "text-orange-300/90 bg-orange-400/10",
  repetition: "text-red-300/90 bg-red-400/10",
  prolongation: "text-pink-300/90 bg-pink-400/10",
  stutter: "text-red-300/90 bg-red-500/10",
  stammer: "text-[#BD8CFF]/90 bg-[#BD8CFF]/10",
};

const PAUSE_LABELS: Record<PauseEvent["type"], string> = {
  natural: "·",
  thinking: "…",
  awkward: "|",
  severe: "||",
  hesitation_sequence: "||",
};

/** Pure sentence markers — rendered as faint separators, NEVER error boxes */
const SENTENCE_MARKERS = new Set([".", "!", "?", "…"]);

function PauseBadge({ event }: { event: PauseEvent }) {
  if (!event.shouldColor) return null;
  // Hesitation sequences: grouped, coherent badge with fragment info
  if (event.type === "hesitation_sequence") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors duration-200 select-none"
        style={{
          color: event.colorToken,
          backgroundColor: `${event.colorToken}18`,
          border: `1px solid ${event.colorToken}30`,
        }}
        title={event.reason.join(" ")}
      >
        <span>{PAUSE_LABELS[event.type]}</span>
        <span>{(event.durationMs / 1000).toFixed(1)}s</span>
        <span className="opacity-70">hesitation</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors duration-200 select-none"
      style={{
        color: event.colorToken,
        backgroundColor: `${event.colorToken}18`,
        border: `1px solid ${event.colorToken}30`,
      }}
      title={event.reason.join(" ")}
    >
      <span>{PAUSE_LABELS[event.type]}</span>
      <span>{(event.durationMs / 1000).toFixed(1)}s</span>
    </span>
  );
}

function WordSpan({ word }: { word: LineWord }) {
  const style = word.tag ? TAG_STYLES[word.tag] : null;
  const base = style ?? (word.isFinal ? "text-white/80" : "text-soft-gray/50");
  const feedEvents = word.events ?? [];

  // Sentence markers (period, comma, ?!…) — render subtly, never as boxes
  if (SENTENCE_MARKERS.has(word.text.trim())) {
    return (
      <span className="text-white/25 font-normal select-none" aria-hidden="true">
        {word.text}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <span
        className={`inline-block rounded px-1 transition-colors duration-200 ${base} ${
          word.tag ? "underline decoration-dotted underline-offset-2" : ""
        }`}
      >
        {word.text}
      </span>
      {feedEvents.length > 0 && (
        <span className="inline-flex items-center gap-0.5">
          {feedEvents.map((evt) => (
            <FeedChip key={evt.id} event={evt} />
          ))}
        </span>
      )}
    </span>
  );
}

// ─── Line builder ──────────────────────────────────────────────────────

type LineItem =
  | { kind: "word"; word: LineWord }
  | { kind: "pause"; event: PauseEvent };

function buildLines(
  transcripts: TranscriptChunk[],
  wordTags: Map<string, DisfluencyTag> | undefined,
  pauseEvents: PauseEvent[],
  events: FeedEvent[],
  maxWordsPerLine: number
): { id: string; items: LineItem[] }[] {
  const lines: { id: string; items: LineItem[] }[] = [];
  let lineId = 0;

  // Finals grouped by utterance index
  const finals = transcripts.filter((t) => t.isFinal);
  const grouped = new Map<number, LineItem[]>();

  // Collect finalized word spans (for event mapping) in stream order
  const wordSpans: { text: string; startTime: number; endTime: number }[] = [];

  for (const chunk of finals) {
    const utterance = chunk.utterance ?? 0;
    for (const w of chunk.words) {
      const text = (w as any).text || w.word || "";
      if (!text) continue;
      const key = `${Math.round(w.startTime * 1000)}-${Math.round(w.endTime * 1000)}`;
      const tag = wordTags?.get(key) ?? null;
      const arr = grouped.get(utterance) ?? [];
      wordSpans.push({ text, startTime: w.startTime, endTime: w.endTime });
      arr.push({
        kind: "word" as const,
        word: { text, isFinal: true, tag, startTime: w.startTime },
      });
      grouped.set(utterance, arr);
    }
  }

  // Map existing detector events onto finalized word spans by timestamp.
  // Renderer-only: no new events, no re-classification.
  const eventAssignments = assignEventsToSpans(events, wordSpans);

  // Attach mapped events to each word item (parallel to wordSpans)
  let spanIdx = 0;
  for (const [, items] of grouped) {
    for (const item of items) {
      if (item.kind === "word") {
        item.word.events = eventAssignments[spanIdx] ?? [];
        spanIdx++;
      }
    }
  }

  // Emit lines in utterance order, splitting oversized ones
  const sortedUtterances = [...grouped.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, items] of sortedUtterances) {
    for (let i = 0; i < items.length; i += maxWordsPerLine) {
      lines.push({
        id: `line-${lineId++}`,
        items: items.slice(i, i + maxWordsPerLine),
      });
    }
  }

  // ── Inject pause badges ──────────────────────────────────────
  if (pauseEvents.length > 0) {
    const colored = pauseEvents.filter((p) => p.shouldColor);
    for (const p of colored) {
      const pauseEndMs = p.endTime * 1000;
      let inserted = false;
      // Find the first word that starts after this pause ends
      for (const line of lines) {
        for (let idx = 0; idx < line.items.length; idx++) {
          const item = line.items[idx];
          if (item.kind !== "word") continue;
          const wStartMs = (item.word as LineWord).startTime * 1000;
          if (wStartMs >= pauseEndMs) {
            line.items.splice(idx, 0, { kind: "pause", event: p });
            inserted = true;
            break;
          }
        }
        if (inserted) break;
      }
      if (!inserted && lines.length > 0) {
        lines[lines.length - 1].items.push({ kind: "pause", event: p });
      }
    }
  }

  // Append current partials (live preview) to the last line, dimmed.
  const partials = transcripts.filter((t) => !t.isFinal);
  if (partials.length > 0) {
    const latest = partials[partials.length - 1];
    const liveItems: LineItem[] = latest.words.map((w) => ({
      kind: "word" as const,
      word: {
        text: (w as any).text || w.word || "",
        isFinal: false,
        tag: null,
        startTime: w.startTime ?? 0,
      },
    }));
    if (liveItems.some((i) => i.kind === "word" && (i.word as LineWord).text)) {
      if (lines.length === 0) {
        lines.push({ id: `line-${lineId++}`, items: liveItems });
      } else {
        lines[lines.length - 1] = {
          ...lines[lines.length - 1],
          items: [...lines[lines.length - 1].items, ...liveItems],
        };
      }
    }
  }

  return lines;
}

