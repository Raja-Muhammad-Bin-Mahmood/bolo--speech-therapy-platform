/**
 * BOLO — Shared Stutter Event Contract
 *
 * ONE event model used by every surface: live transcript, script mode,
 * free speech mode, review screen, charts and summary cards.
 * The local audio lane (AudioWorklet) posts feature FRAMES; the timeline
 * engine produces CANDIDATES; the fusion layer turns them into StutterEvents
 * bound to finalized Speechmatics words.
 */

// ─── Frame labels (from the AudioWorklet DSP lane) ───────────────────────

export type FrameLabel =
  | "SILENCE"
  | "BREATH"
  | "FRICATIVE"
  | "VOICED"
  | "PLOSIVE_BURST"
  | "TENSE_HOLD"
  | "UNKNOWN";

/** A single classified frame from the AudioWorklet (every 10ms). */
export interface TimelineFrame {
  /** Seconds since session start (worklet-relative). */
  t: number;
  /** Root mean square energy of the frame. */
  rms: number;
  /** Change in RMS energy vs the previous frame. */
  deltaEnergy: number;
  /** Zero crossing rate (0–1). */
  zcr: number;
  /** Spectral flatness (0–1): 0=tonal, 1=noise-like. */
  spectralFlatness: number;
  /** Voice activity detection probability (0–1). */
  vad: number;
  /** Normalized energy in the 20–80 Hz range. */
  lowFreqEnergy: number;
  /** Classified frame label. */
  label: number;  // enum index matching LABEL const in both worklet and engine
  /** Human-readable label name. */
  labelName: FrameLabel;
  /** Current adaptive noise floor estimate. */
  rollingNoiseFloor: number;
  /** RMS / rollingNoiseFloor ratio. */
  speechRatio: number;
  /** Whether the VAD state machine considers this "in speech". */
  voiced: boolean;
}

// ─── Event types ─────────────────────────────────────────────────────────

export type StutterEventType =
  | "repetition"
  | "prolongation"
  | "block"
  | "tense_block"
  | "hesitation_sequence"
  | "possible_false_start"
  | "uncertain";

export type StutterSeverity = "low" | "medium" | "high";

/** Raw candidate posted by the AudioWorklet (worklet clock, pre-fusion). */
export interface StutterCandidate {
  eventType: StutterEventType;
  /** seconds — worklet clock (converted to session time by the capture layer) */
  startTime: number;
  endTime: number;
  durationMs: number;
  /** 0..1 — acoustic evidence strength from the DSP lane */
  confidence: number;
  /** Human-readable WHY this was flagged (shown in tooltips/review) */
  reason: string[];
}

/** The fused, app-wide event contract. */
export interface StutterEvent {
  id: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  eventType: StutterEventType;
  /** 0..1 — fused evidence score (acoustic × word overlap agreement) */
  confidence: number;
  severity: StutterSeverity;
  /** Finalized Speechmatics word the event is attached to (if any) */
  matchedWord?: string;
  reason: string[];
  /** Stable color token — identical across every UI surface */
  colorToken: string;
  shouldHighlight: boolean;
}

// ─── Color system (spec: same colors in every mode) ──────────────────────

export const STUTTER_COLORS: Record<StutterEventType, string> = {
  repetition: "#C084FC", // purple
  prolongation: "#818CF8", // blue-violet
  block: "#E879F9", // red-violet
  tense_block: "#FB7185", // red / magenta
  hesitation_sequence: "#FBBF24", // amber
  possible_false_start: "#F472B6", // pink
  uncertain: "#8B93A7", // neutral gray
};

export const STUTTER_LABELS: Record<StutterEventType, string> = {
  repetition: "Repetition",
  prolongation: "Prolongation",
  block: "Block",
  tense_block: "Tense start",
  hesitation_sequence: "Hesitation",
  possible_false_start: "False start",
  uncertain: "Uncertain",
};

// ─── Conservative thresholds (false positives are worse than misses) ─────

export const FUSION_THRESHOLDS = {
  /** Below this, the event is dropped entirely (kept internal). */
  keep: 0.55,
  /** Below this, the event is marked uncertain and never highlighted. */
  highlight: 0.72,
  /** Above this the event is severity "high". */
  high: 0.85,
} as const;

export function severityFromConfidence(c: number): StutterSeverity {
  if (c >= FUSION_THRESHOLDS.high) return "high";
  if (c >= FUSION_THRESHOLDS.highlight) return "medium";
  return "low";
}

// ─── Fusion summary (review screen) ──────────────────────────────────────

export interface StutterSummary {
  total: number;
  repetitions: number;
  prolongations: number;
  blocks: number;
  tenseBlocks: number;
  hesitationSequences: number;
  possibleFalseStarts: number;
  /** Events kept below the highlight threshold (uncertain) — counted separately */
  uncertain: number;
  /** Longest event duration in ms */
  longestMs: number;
  /** Average fused confidence 0..1 */
  avgConfidence: number;
  /** Where the user got stuck / resumed smoothly — sorted event timeline */
  timeline: StutterEvent[];
  /** Recovery quality after events: "quick" | "moderate" | "slow" | null */
  recoveryQuality: "quick" | "moderate" | "slow" | null;
  /** Phonation ratio 0..1 (speech time / total time) */
  phonationRatio: number;
  /** Count of events that broke flow (severe + tense + blocks) */
  flowBreaks: number;
}

// ─── Word-key helpers (consistent across surfaces) ───────────────────────

export function wordKey(startTime: number, endTime: number): string {
  return `${Math.round(startTime * 1000)}-${Math.round(endTime * 1000)}`;
}

/** Fraction of `a` that overlaps `b` (0..1). */
export function overlapRatio(aS: number, aE: number, bS: number, bE: number): number {
  const aDur = aE - aS;
  if (aDur <= 0) return 0;
  const intersect = Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
  return intersect / aDur;
}
