/**
 * BOLO — SessionTranscript (after-session rendering of the SAVED live
 * transcript)
 *
 * This is a RENDERING of the exact token array that powered the LIVE
 * TRANSCRIPT — the single source of truth. It is NOT a newly generated
 * transcript: the session is over; this is the saved data being replayed,
 * sentence by sentence, with the same rendering decisions the live view
 * made:
 *
 *   • same words, same ordering (the reconciled token array)
 *   • purple underlines for stutter-like disfluencies — using the SAME
 *     predicate AND the SAME underline safety rule as the live renderer,
 *     evaluated on the SAME full token array
 *   • yellow (amber) fillers — filler words are the YELLOW ones
 *   • same hesitation / block markers (pause badges), detector feed chips
 *     and recovery annotations, injected at the same chronological positions
 *   • same sentence boundaries (utterance grouping, >1.5s gap rule)
 */
import { useMemo } from "react";
import { deriveUtterances } from "../lib/sessionDisfluencies";
import {
  suppressedUnderlineTokenIds,
  type TranscriptToken,
} from "../lib/transcriptTokens";
import type { PauseEvent } from "../lib/pauseDetector";
import type { FeedEvent } from "../lib/feedEvents";
import type { RecoveredAnnotation } from "../lib/recoveryTypes";
import { assignEventsToSpans } from "../lib/feedEvents";
import { buildRecoveredItems } from "../lib/recoveryRender";
import FeedChip from "./FeedChip";
import StutterSpan from "./StutterSpan";
import MarkerChip from "./MarkerChip";
import { sortMarkers, type SessionMarker } from "../lib/manualAnnotations";

interface SessionTranscriptProps {
  /** The SAVED live transcript token array (single source of truth). */
  tokens: TranscriptToken[];
  /** SM word tags (filler/block/…) — the same map the live transcript
   *  colored with (fillers → yellow). */
  wordTags?: Map<string, string>;
  /** Pause/hesitation events → inline badges (same as live). */
  pauseEvents?: PauseEvent[];
  /** Existing detector events → feed chips attached to words. */
  events?: FeedEvent[];
  /** Recovery annotations (Stage 3) → StutterSpans. */
  recovered?: RecoveredAnnotation[];
  /** ms-keys of SM words the recovery engine recovered locally first —
   *  they were hidden live and stay hidden (never duplicated). */
  hiddenKeys?: Set<string>;
  /** Manual markers (SPACE / MARKER button) — rendered as animated MARKER
   *  chips at their chronological positions. */
  markers?: SessionMarker[];
  /** Safety-net max words per line. */
  maxWordsPerLine?: number;
}

const TAG_STYLES: Record<string, string> = {
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

/** Pure sentence markers — rendered as faint separators, never boxes. */
const SENTENCE_MARKERS = new Set([".", "!", "?", "…"]);

type RItem =
  | {
      kind: "word";
      token: TranscriptToken;
      /** SM wordTags tag (filler/block/…) — rendered via TAG_STYLES. */
      tag: string | null;
      /** Stutter-like DG disfluency → purple underline (safety-gated). */
      underline: boolean;
      /** Filler word → yellow (amber). */
      amber: boolean;
      events: FeedEvent[];
      rec: RecoveredAnnotation | null;
    }
  | { kind: "pause"; event: PauseEvent }
  | { kind: "recovered"; rec: RecoveredAnnotation }
  | { kind: "event"; evt: FeedEvent }
  | { kind: "marker"; marker: SessionMarker };

function buildSessionLines(
  tokens: TranscriptToken[],
  wordTags: Map<string, string> | undefined,
  pauseEvents: PauseEvent[],
  events: FeedEvent[],
  recovered: RecoveredAnnotation[],
  hiddenKeys: Set<string> | undefined,
  markers: SessionMarker[],
  maxWordsPerLine: number
): { id: string; items: RItem[] }[] {
  if (tokens.length === 0) return [];

  // Same underline safety rule as the LIVE renderer, evaluated on the SAME
  // full token array — a run of 3+ different-first-letter disfluencies
  // loses its purple underline here exactly as it did live.
  const suppressed = suppressedUnderlineTokenIds(tokens);
  const utterances = deriveUtterances(tokens);

  // SM words the recovery engine recovered locally first were hidden live —
  // they stay hidden (never rendered twice next to their StutterSpan).
  const visible = tokens.filter(
    (t) =>
      !(
        t.source === "speechmatics" &&
        hiddenKeys?.has(`${t.startTimeMs}-${t.endTimeMs}`)
      )
  );

  const wordSpans = visible.map((t) => ({
    text: t.word,
    startTime: t.startTimeMs / 1000,
    endTime: t.endTimeMs / 1000,
  }));
  const eventAssignments = assignEventsToSpans(events, wordSpans);
  const recAssignment = buildRecoveredItems(recovered, wordSpans);

  // ── Group words into utterance lines (sentence boundaries) ────────────
  const byUtterance = new Map<number, RItem[]>();
  visible.forEach((t, i) => {
    const u = utterances.get(t.id) ?? 0;
    const arr = byUtterance.get(u) ?? [];
    let tag: string | null = null;
    let underline = false;
    let amber = false;

    const structured =
      t.disfluency != null || t.isDisfluency === true || t.locked === true;
    if (structured) {
      const type = t.disfluency?.type ?? t.disfluencyType ?? "disfluency";
      if (type === "filler") {
        // FILLER WORDS ARE THE YELLOW ONES — full word, amber chip.
        amber = true;
      } else {
        // Stutter-like disfluency — purple underline (safety-gated).
        underline = !suppressed.has(t.id);
      }
    } else if (t.source === "speechmatics") {
      // SM words were colored live via the wordTags map (filler → yellow).
      tag = wordTags?.get(`${t.startTimeMs}-${t.endTimeMs}`) ?? null;
      if (tag === "filler") amber = true;
    }

    arr.push({
      kind: "word",
      token: t,
      tag,
      underline,
      amber,
      events: eventAssignments[i] ?? [],
      rec: recAssignment.attachedByIndex[i] ?? null,
    });
    byUtterance.set(u, arr);
  });

  const lines: { id: string; items: RItem[] }[] = [];
  let lineId = 0;
  for (const u of [...byUtterance.keys()].sort((a, b) => a - b)) {
    const items = byUtterance.get(u)!;
    for (let i = 0; i < items.length; i += maxWordsPerLine) {
      lines.push({
        id: `sl-${lineId++}`,
        items: items.slice(i, i + maxWordsPerLine),
      });
    }
  }

  // ── Inject pause badges at their chronological position (same as live) ──
  for (const p of pauseEvents.filter((p) => p.shouldColor)) {
    const pauseEndMs = p.endTime * 1000;
    let inserted = false;
    for (const line of lines) {
      for (let idx = 0; idx < line.items.length; idx++) {
        const item = line.items[idx];
        if (item.kind !== "word") continue;
        if (item.token.startTimeMs >= pauseEndMs) {
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

  // ── Standalone recovery annotations inline (same as live) ─────────────
  for (const rec of recAssignment.standalone) {
    let inserted = false;
    for (const line of lines) {
      for (let idx = 0; idx < line.items.length; idx++) {
        const item = line.items[idx];
        if (item.kind !== "word") continue;
        if (item.token.startTimeMs / 1000 >= rec.startTime) {
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

  // ── Manual markers inline (chronological — same as live) ──────────────
  for (const m of sortMarkers(markers)) {
    const mTimeSec = m.timeMs / 1000;
    let inserted = false;
    for (const line of lines) {
      for (let idx = 0; idx < line.items.length; idx++) {
        const item = line.items[idx];
        if (item.kind !== "word") continue;
        if (item.token.startTimeMs / 1000 >= mTimeSec) {
          line.items.splice(idx, 0, { kind: "marker", marker: m });
          inserted = true;
          break;
        }
      }
      if (inserted) break;
    }
    if (!inserted && lines.length > 0) {
      lines[lines.length - 1].items.push({ kind: "marker", marker: m });
    }
  }

  // ── Orphan detector events inline (block before a word, etc.) ─────────
  const attachedIds = new Set(eventAssignments.flat().map((e) => e.id));
  const orphans = events
    .filter((e) => !attachedIds.has(e.id))
    .sort((a, b) => a.startTime - b.startTime);
  for (const evt of orphans) {
    const evtTime = evt.startTime;
    let inserted = false;
    for (const line of lines) {
      for (let idx = 0; idx < line.items.length; idx++) {
        const item = line.items[idx];
        if (item.kind !== "word") continue;
        if (item.token.startTimeMs / 1000 >= evtTime) {
          line.items.splice(idx, 0, { kind: "event", evt });
          inserted = true;
          break;
        }
      }
      if (inserted) break;
    }
    if (!inserted && lines.length > 0) {
      lines[lines.length - 1].items.push({ kind: "event", evt });
    }
  }

  return lines;
}

// ─── Component ──────────────────────────────────────────────────────────

export default function SessionTranscript({
  tokens,
  wordTags,
  pauseEvents = [],
  events = [],
  recovered = [],
  hiddenKeys,
  markers = [],
  maxWordsPerLine = 16,
}: SessionTranscriptProps) {
  const lines = useMemo(
    () =>
      buildSessionLines(
        tokens,
        wordTags,
        pauseEvents,
        events,
        recovered,
        hiddenKeys,
        markers,
        maxWordsPerLine
      ),
    [tokens, wordTags, pauseEvents, events, recovered, hiddenKeys, markers, maxWordsPerLine]
  );

  if (lines.length === 0) {
    return (
      <p className="text-xs text-soft-gray/50">
        No transcript tokens were saved for this session.
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      {lines.map((line) => (
        <p
          key={line.id}
          className="flex flex-wrap gap-x-1.5 gap-y-1 leading-relaxed"
        >
          {line.items.map((item, i) => {
            if (item.kind === "pause")
              return <PauseBadge key={`p-${i}`} event={item.event} />;
            if (item.kind === "recovered")
              return (
                <StutterSpan key={`r-${item.rec.id}`} annotation={item.rec} />
              );
            if (item.kind === "event")
              return (
                <InlineEventChip key={`e-${item.evt.id}`} evt={item.evt} />
              );
            if (item.kind === "marker")
              return (
                <MarkerChip key={`m-${item.marker.id}`} marker={item.marker} />
              );
            return <WordSpan key={`w-${item.token.id}`} item={item} />;
          })}
        </p>
      ))}
    </div>
  );
}

// ─── Word rendering (mirrors the LIVE transcript WordSpan) ──────────────

function WordSpan({ item }: { item: Extract<RItem, { kind: "word" }> }) {
  const { token, tag, underline, amber, events, rec } = item;

  // Pure sentence markers (period, comma, ?!…) — faint, never boxes.
  if (SENTENCE_MARKERS.has(token.word.trim())) {
    return (
      <span className="text-white/25 font-normal select-none" aria-hidden="true">
        {token.word}
      </span>
    );
  }

  const cls = amber
    ? "inline-block rounded px-1 text-amber-300/90 bg-amber-300/10 underline decoration-dotted underline-offset-2 transition-colors duration-200"
    : underline
      ? "inline-block rounded px-1 underline decoration-2 decoration-purple-400 underline-offset-4 bg-[#BD8CFF]/10 text-[#BD8CFF]/90 transition-colors duration-200"
      : tag
        ? `inline-block rounded px-1 ${TAG_STYLES[tag] ?? "text-white/80"} underline decoration-dotted underline-offset-2 transition-colors duration-200`
        : "inline-block rounded px-1 text-white/80 transition-colors duration-200";

  const title = amber
    ? `Filler · "${token.word}" (full word saved)`
    : underline
      ? `Disfluency · ${token.disfluency?.type ?? token.disfluencyType ?? "disfluency"} (${Math.round((token.disfluency?.confidence ?? 0.9) * 100)}%) · first letter "${token.firstLetter ?? "—"}"`
      : tag
        ? tag
        : undefined;

  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {rec && <StutterSpan annotation={rec} className="mr-0.5" />}
      <span className={cls} title={title}>
        {token.word}
      </span>
      {events.length > 0 && (
        <span className="inline-flex items-center gap-0.5">
          {events.map((evt) => (
            <FeedChip key={evt.id} event={evt} />
          ))}
        </span>
      )}
    </span>
  );
}

function PauseBadge({ event }: { event: PauseEvent }) {
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
      <span>{PAUSE_LABELS[event.type] ?? "·"}</span>
      <span>{(event.durationMs / 1000).toFixed(1)}s</span>
      {event.type === "hesitation_sequence" && (
        <span className="opacity-70">hesitation</span>
      )}
    </span>
  );
}

function InlineEventChip({ evt }: { evt: FeedEvent }) {
  const confirmed = evt.confirmed !== false;
  const resolving = evt.resolving === true;
  const borderStyle = confirmed ? undefined : ("dashed" as const);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-mono select-none border transition-colors duration-200"
      style={{
        color: evt.color,
        backgroundColor: `${evt.color}14`,
        borderColor: `${evt.color}30`,
        borderStyle,
      }}
      title={`${evt.label} · ${(evt.durationMs / 1000).toFixed(1)}s${
        evt.confidence != null
          ? ` · ${Math.round(evt.confidence * 100)}%${
              evt.source ? ` · ${evt.source}` : ""
            }`
          : ""
      }${resolving ? " · resolving word…" : ""}${
        evt.baseWord ? ` · ${evt.baseWord}` : ""
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          resolving ? "animate-pulse" : ""
        }`}
        style={{ backgroundColor: evt.color }}
      />
      {evt.label}
      <span className="opacity-80">
        {(evt.durationMs / 1000).toFixed(1)}s
      </span>
      {resolving && (
        <span className="opacity-60 text-[9px] uppercase tracking-wide">
          resolving
        </span>
      )}
    </span>
  );
}
