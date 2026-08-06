/**
 * BOLO — Fusion Decision Logger
 *
 * Structured, bounded log of the 3-layer pipeline so the team can always
 * answer the mission's core debugging questions:
 *
 *   • every candidate event      → type, start, end, confidence,
 *                                  attached word, attachment window,
 *                                  reason for attachment or suppression
 *   • every finalized word       → text, start, end
 *   • every fusion decision      → overlap/pre-onset attachment decision,
 *                                  suppression decision, visible/hidden result
 *
 * "If a real stutter is detected but not shown, the logs must say why."
 *
 * Bounded ring buffer (no unbounded growth), console-mirrored with a
 * `[BOLO·fusion]` prefix. No secrets, no audio, no PII beyond transcript text.
 */
import type { EvidenceBand } from "./evidenceFusion";

export type FusionLogKind = "word" | "candidate" | "fusion";

export interface LoggedWord {
  kind: "word";
  /** seconds since session start (shared clock) */
  startTime: number;
  endTime: number;
  text: string;
  t: number;
}

export interface LoggedCandidate {
  kind: "candidate";
  type: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  /** detector confidence (0..1) */
  confidence: number;
  /** fused evidence score (0..1) */
  evidenceScore: number;
  band: EvidenceBand;
  /** mission classification — "uncertain" unless evidence is strong */
  refinedType: string;
  /** Speechmatics word that owns this event (if any) */
  attachedWord?: string;
  /** "pre_onset" | "onset" | "inside" | "trailing" | "none" */
  attachmentPosition: string;
  /** "pre-onset attachment" | "overlap" | "no word within window" | … */
  attachmentReason: string;
  /** e.g. "600ms before word / 200ms after" */
  attachmentWindow: string;
  visible: boolean;
  suppressionReasons: string[];
  agreement: number;
  t: number;
}

export interface LoggedFusionDecision {
  kind: "fusion";
  eventKey: string;
  decision: string;
  visible: boolean;
  t: number;
}

export type FusionLogEntry = LoggedWord | LoggedCandidate | LoggedFusionDecision;

// ─── Bounded ring buffer ────────────────────────────────────────────────

const MAX_ENTRIES = 400;
const entries: FusionLogEntry[] = [];

const seenWordKeys = new Set<string>();

export function pushLog(entry: FusionLogEntry): void {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  // Console mirror — throttled formatting per kind.
  if (entry.kind === "word") {
    console.debug(
      `[BOLO·fusion] word "${entry.text}" ${entry.startTime.toFixed(2)}s–${entry.endTime.toFixed(2)}s`
    );
  } else if (entry.kind === "candidate") {
    const where = entry.attachedWord ? `→ "${entry.attachedWord}" (${entry.attachmentReason})` : "→ unattached";
    console.debug(
      `[BOLO·fusion] ${entry.type} ${entry.startTime.toFixed(2)}s–${entry.endTime.toFixed(2)}s ` +
        `conf=${entry.confidence.toFixed(2)} score=${entry.evidenceScore.toFixed(2)} band=${entry.band} ` +
        `agreement=${entry.agreement} ${where} ` +
        `${entry.visible ? "VISIBLE" : `SUPPRESSED — ${entry.suppressionReasons.join("; ") || "no reason"}`}`
    );
  } else {
    console.debug(
      `[BOLO·fusion] ${entry.eventKey} → ${entry.decision} (${entry.visible ? "visible" : "hidden"})`
    );
  }
}

export function getFusionLog(): FusionLogEntry[] {
  return [...entries];
}

export function clearFusionLog(): void {
  entries.length = 0;
  seenWordKeys.clear();
}

// ─── Batch helpers ──────────────────────────────────────────────────────

export interface LoggableWord {
  text: string;
  startTime: number;
  endTime: number;
}

export interface LoggableScored {
  key: string;
  event: { type: string; startTime: number; endTime: number; durationMs: number; confidence: number };
  evidenceScore: number;
  band: EvidenceBand;
  refinedType: string;
  matchedWord?: string;
  attachmentPosition: string;
  attachmentReason: string;
  visible: boolean;
  suppressionReasons: string[];
  agreement: number;
}

/** Log every newly-seen finalized word (deduped by key). */
export function logWords(words: LoggableWord[]): void {
  const now = performance.now();
  for (const w of words) {
    const key = `${Math.round(w.startTime * 1000)}-${Math.round(w.endTime * 1000)}-${w.text}`;
    if (seenWordKeys.has(key)) continue;
    seenWordKeys.add(key);
    pushLog({ kind: "word", text: w.text, startTime: w.startTime, endTime: w.endTime, t: now });
  }
}

/** Log every scored candidate with its full verdict + attachment decision. */
export function logCandidates(scored: LoggableScored[]): void {
  const now = performance.now();
  for (const s of scored) {
    pushLog({
      kind: "candidate",
      type: s.event.type,
      startTime: s.event.startTime,
      endTime: s.event.endTime,
      durationMs: s.event.durationMs,
      confidence: s.event.confidence,
      evidenceScore: s.evidenceScore,
      band: s.band,
      refinedType: s.refinedType,
      attachedWord: s.matchedWord,
      attachmentPosition: s.attachmentPosition,
      attachmentReason: s.attachmentReason,
      attachmentWindow: "600ms/200ms",
      visible: s.visible,
      suppressionReasons: s.suppressionReasons,
      agreement: s.agreement,
      t: now,
    });
  }
}

/** One-shot: words + candidates in a single batch (used by the fusion hook). */
export function logFusionBatch(words: LoggableWord[], scored: LoggableScored[]): void {
  logWords(words);
  logCandidates(scored);
}
