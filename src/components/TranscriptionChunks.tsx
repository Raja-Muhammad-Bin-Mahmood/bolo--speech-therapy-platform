import { useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { TranscriptChunk } from "../hooks/useSpeechmaticsWS";
import type { DisfluencyTag } from "../hooks/useSessionAnalysis";
import type { PauseEvent } from "../lib/pauseDetector";
import type { FeedEvent } from "../lib/feedEvents";
import type { RecoveredAnnotation } from "../lib/recoveryTypes";
import type { PendingSpeechEvent } from "../hooks/useEventEngine";
import { assignEventsToSpans } from "../lib/feedEvents";
import { buildRecoveredItems } from "../lib/recoveryRender";
import FeedChip from "./FeedChip";
import StutterSpan from "./StutterSpan";
import PulseDots from "./PulseDots";

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
  /**
   * Recovery annotations (Stage 3). Recovered ones insert the lexical word
   * + badge inline; unresolved ones are suppressed (never a placeholder).
   */
  recovered?: RecoveredAnnotation[];
  /**
   * Speechmatics word keys to HIDE — words the engine recovered locally
   * first (timestamp-locked). Prevents duplicate tokens.
   */
  duplicateKeys?: Set<string>;
  /**
   * OPEN/WAITING events — render a pulsing "analyzing" indicator at the
   * transcript cursor while BOLO resolves the struggle.
   */
  pending?: PendingSpeechEvent[];
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
  recovered = [],
  duplicateKeys,
  pending = [],
  maxWordsPerLine = 16,
}: TranscriptionChunksProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(0);

  const lines = buildLines(
    transcripts,
    wordTags,
    pauseEvents,
    events,
    recovered,
    duplicateKeys,
    pending,
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
              ) : item.kind === "recovered" ? (
                <StutterSpan key={`r-${item.rec.id}`} annotation={item.rec} />
              ) : item.kind === "pending" ? (
                <PulseDots key={item.evt.id} title={`Analyzing ${item.evt.type}…`} />
              ) : item.kind === "event" ? (
                <InlineEventChip key={item.evt.id} evt={item.evt} />
              ) : (
                <WordSpan key={wi} word={item.word} />
              )
            )}
            {/* Pulsing "analyzing" indicator at the transcript cursor */}
            {line.id === lines[lines.length - 1].id &&
              pending.length > 0 && (
                <PulseDots
                  title={`BOLO is analyzing ${pending.length} ${
                    pending.length === 1 ? "struggle" : "struggles"
                  }…`}
                />
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
  /** Recovery annotation attached to this word (Stage 3) */
  recovered?: RecoveredAnnotation | null;
}

const TAG_STYLES: Record<DisfluencyTag, string> = {
  filler: "text-amber-300/90 bg-amber-300/10",
  block: "text-orange-300/90 bg-orange-400/10",
  repetition: "text-red-300/90 bg-red-400/10",
  prolongation: "text-pink-300/90 bg-pink-400/10",
  stutter: "text-red-300/90 bg-red-500/10",
  stammer: "text-[#BD8CFF]/90 bg-[#BD8CFF]/10",
  fragment: "text-[#A3A3B5]/90 bg-[#A3A3B5]/10",
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

/** Inline marker for a detector event that has no transcript word yet
 *  (e.g. a block before the following word finalizes). Renders the type +
 *  duration exactly like the Detection Feed chip, so the transcript NEVER
 *  loses a detected disfluency — it stays visible until its word lands. */
function InlineEventChip({ evt }: { evt: FeedEvent }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-mono select-none border transition-colors duration-200"
      style={{
        color: evt.color,
        backgroundColor: `${evt.color}14`,
        borderColor: `${evt.color}30`,
      }}
      title={`${evt.label} · ${(evt.durationMs / 1000).toFixed(1)}s`}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ backgroundColor: evt.color }}
      />
      {evt.label}
      <span className="opacity-80">
        {(evt.durationMs / 1000).toFixed(1)}s
      </span>
    </span>
  );
}

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

  // Recovery annotation (Stage 3): wrap the stuttered prefix + base word.
  // The base word keeps its Speechmatics text — alignment is preserved.
  if (word.recovered) {
    return (
      <span className="inline-flex items-center gap-1 align-middle">
        <StutterSpan annotation={word.recovered} />
        <span
          className={`inline-block rounded px-1 transition-colors duration-200 ${base} ${
            word.tag ? "underline decoration-dotted underline-offset-2" : ""
          }`}
          title={word.tag ? undefined : undefined}
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
  | { kind: "pause"; event: PauseEvent }
  | { kind: "recovered"; rec: RecoveredAnnotation }
  | { kind: "pending"; evt: PendingSpeechEvent }
  | { kind: "event"; evt: FeedEvent };

function buildLines(
  transcripts: TranscriptChunk[],
  wordTags: Map<string, DisfluencyTag> | undefined,
  pauseEvents: PauseEvent[],
  events: FeedEvent[],
  recovered: RecoveredAnnotation[],
  duplicateKeys: Set<string> | undefined,
  pending: PendingSpeechEvent[],
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
      // Timestamp-anchored dedup: a word the engine recovered locally first
      // is hidden here so it never renders twice.
      if (duplicateKeys?.has(key)) continue;
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
  // Events that matched NO word (orphans — e.g. a block before the next
  // word has finalized) are injected inline as `[Type] d.ds` markers so the
  // transcript NEVER loses a detected disfluency. When the word lands, the
  // event attaches to it and the inline marker disappears.
  const attachedIds = new Set(eventAssignments.flat().map((e) => e.id));
  // Events attached to ANY rendered word (final OR live partial) must never
  // be re-injected as an inline chip. The two orphan passes below share one
  // mutually-exclusive pool, so a single event can never render twice —
  // this kills the "duplicate key evt-*" React warning.
  const injectedInlineIds = new Set<string>();
  // Set inside the partial pass below; hoisted so the finals orphan pass
  // can exclude events already attached to interim words.
  let partialAttachedIds: Set<string> | null = null;

  // Map recovery annotations onto the same word spans (Stage 3).
  const recoveredAssignment = buildRecoveredItems(recovered, wordSpans);

  // Attach mapped events + recovery annotations to each word item (parallel to wordSpans)
  let spanIdx = 0;
  for (const [, items] of grouped) {
    for (const item of items) {
      if (item.kind === "word") {
        item.word.events = eventAssignments[spanIdx] ?? [];
        item.word.recovered = recoveredAssignment.attachedByIndex[spanIdx] ?? null;
        spanIdx++;
      }
    }
  }

  // ── Interim hypotheses → stable word (mission rule) ──────────────────
  // Partials ARE the live transcript: a disfluency detected on an interim
  // word is shown immediately (tag + feed chip), so the user sees the
  // struggle while speaking, not after the final lands. When the final
  // supersedes the partial, the same tag/event re-attaches to the final
  // token — annotations MIGRATE, never disappear.
  const partials = transcripts.filter((t) => !t.isFinal);
  if (partials.length > 0) {
    const latest = partials[partials.length - 1];
    const partialSpans: { text: string; startTime: number; endTime: number }[] = [];
    for (const w of latest.words) {
      const text = (w as any).text || w.word || "";
      if (!text) continue;
      partialSpans.push({
        text,
        startTime: w.startTime ?? 0,
        endTime: w.endTime ?? (w.startTime ?? 0) + 0.3,
      });
    }
    const partialAssignments = assignEventsToSpans(events, partialSpans);
    const partialRecovered = buildRecoveredItems(recovered, partialSpans);
    // Events attached to interim words (or already rendered anywhere) never
    // inject — an event attached to a FINAL word is already on screen as a
    // chip, so it must not be spliced into the live line a second time.
    partialAttachedIds = new Set(partialAssignments.flat().map((e) => e.id));
    const partialOrphans = events
      .filter(
        (e) =>
          !partialAttachedIds!.has(e.id) &&
          !attachedIds.has(e.id) &&
          !injectedInlineIds.has(e.id)
      )
      .sort((a, b) => a.startTime - b.startTime);

    const liveItems: LineItem[] = latest.words.map((w, wi) => {
      const text = (w as any).text || w.word || "";
      const key = `${Math.round((w.startTime ?? 0) * 1000)}-${Math.round((w.endTime ?? (w.startTime ?? 0) + 0.3) * 1000)}`;
      const tag = wordTags?.get(key) ?? null;
      return {
        kind: "word" as const,
        word: {
          text,
          isFinal: false,
          tag,
          startTime: w.startTime ?? 0,
          events: partialAssignments[wi] ?? [],
          recovered: partialRecovered.attachedByIndex[wi] ?? null,
        },
      };
    });
    // Orphan events (no partial word yet — block before the word finalizes)
    for (const evt of partialOrphans) {
      const evtTime = evt.startTime;
      let inserted = false;
      for (let idx = 0; idx < liveItems.length; idx++) {
        const it = liveItems[idx];
        if (it.kind !== "word") continue;
        if ((it.word as LineWord).startTime >= evtTime) {
          liveItems.splice(idx, 0, { kind: "event", evt });
          inserted = true;
          break;
        }
      }
      if (!inserted) liveItems.push({ kind: "event", evt });
      injectedInlineIds.add(evt.id);
    }
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

  // ── Inject standalone recovery tokens (recovered / unresolved) inline ──
  for (const rec of recoveredAssignment.standalone) {
    const recTime = rec.startTime;
    let inserted = false;
    for (const line of lines) {
      for (let idx = 0; idx < line.items.length; idx++) {
        const item = line.items[idx];
        if (item.kind !== "word") continue;
        const wStart = (item.word as LineWord).startTime;
        if (wStart >= recTime) {
          line.items.splice(idx, 0, { kind: "recovered", rec });
          inserted = true;
          break;
        }
      }
      if (inserted) break;
    }
    if (!inserted && lines.length > 0) {
      lines[lines.length - 1].items.push({ kind: "recovered", rec });
    }
  }

  // ── Inject orphan events inline (no word yet — block before onset, etc.) ──
  // Pool = events attached to NEITHER a final word NOR a live partial, and
  // not already injected by the partial pass — mutual exclusion guarantees a
  // given event id appears at most once in the whole transcript.
  const unionAttached = new Set<string>([
    ...attachedIds,
    ...(partialAttachedIds ?? []),
    ...injectedInlineIds,
  ]);
  const orphanEvents = events
    .filter((e) => !unionAttached.has(e.id))
    .sort((a, b) => a.startTime - b.startTime);
  for (const evt of orphanEvents) {
    const evtTime = evt.startTime;
    let inserted = false;
    for (const line of lines) {
      for (let idx = 0; idx < line.items.length; idx++) {
        const item = line.items[idx];
        if (item.kind !== "word") continue;
        const wStart = (item.word as LineWord).startTime;
        if (wStart >= evtTime) {
          line.items.splice(idx, 0, { kind: "event", evt });
          inserted = true;
          break;
        }
      }
      if (inserted) break;
    }
    if (!inserted) {
      // No word after it yet — append to the last line so the block stays
      // visible at the transcript cursor while the word finalizes.
      if (lines.length > 0) {
        lines[lines.length - 1].items.push({ kind: "event", evt });
      }
    }
    injectedInlineIds.add(evt.id);
  }

  // ── Inject pending markers inline (events still OPEN/WAITING) ──────
  for (const evt of pending) {
    const evtTime = evt.startTime;
    let inserted = false;
    for (const line of lines) {
      for (let idx = 0; idx < line.items.length; idx++) {
        const item = line.items[idx];
        if (item.kind !== "word") continue;
        const wStart = (item.word as LineWord).startTime;
        if (wStart >= evtTime) {
          line.items.splice(idx, 0, { kind: "pending", evt });
          inserted = true;
          break;
        }
      }
      if (inserted) break;
    }
    if (!inserted) {
      // No word yet — leave it to the trailing cursor indicator (rendered
      // by the component after the last line).
      continue;
    }
  }

  return lines;
}

