/**
 * BOLO — Confidence & Evidence Fusion Layer (detection-truth display)
 *
 * Sits between the raw acoustic detector and the transcript annotation
 * layer. The base detector is NOT touched: every raw event still reaches
 * the Detection Feed and the Review Screen. This layer decides WHICH
 * Speechmatics word owns each event and whether the event may ALSO render
 * as a visible transcript annotation.
 *
 * DISPLAY POLICY — "show probable disfluencies immediately, refine later":
 *   The Detection Feed is the source of truth for WHAT was detected, and
 *   the Live Transcript mirrors it. Any detector event whose raw temporal
 *   confidence clears the display floor (`minVisibleScore`, default 0.70)
 *   is annotated on the transcript at once, attached to its word by
 *   timestamp, and only REMOVED when the evidence is a clear false
 *   positive (breath/sniff fingerprint, a too-short cue, or a plain pause
 *   misread as a block). The fused `evidenceScore` is NOT a hard gate any
 *   more — it styles intensity (band) and feeds the developer tuning panel.
 *
 * Attribution is PRE-ONSET, not overlap-only:
 *     word.start − 600ms … word.end + 200ms
 *   the FIRST appropriate word owns the event — events never drift to
 *   later words just because timestamps are closer. Silent blocks that end
 *   right before a word onset attach to that following word, so
 *   "------cat" renders as "[Block] cat", never as a bare pause.
 *
 * Hard false-positive suppressions (the only things kept feed-only):
 *   - breaths/sniffs: short stutter/stammer with no word anchor
 *   - blocks shorter than 250ms and prolongations shorter than 350ms
 *   - plain pauses misread as blocks (inside a natural pause, weak
 *     acoustic signature, not anchored at a word onset)
 *
 * Evidence bands (styling only):
 *   0.00–0.49  internal   — weak evidence
 *   0.50–0.79  medium     — probable, shown with softer styling
 *   0.80–1.00  strong     — high-confidence, shown with full styling
 *
 * The developer sliders map 1:1 onto EvidenceWeights so the team can tune
 * the display floor and false positives away live — no reload, no rebuild.
 */

import type { AcousticEvent, AcousticEventType } from "../hooks/useAcousticAnalysis";
import type { PauseEvent } from "./pauseDetector";
import type { FeedEvent } from "./feedEvents";
import {
  evaluateInterruptionGate,
  findPrevWordEnd,
  countSpannedWords,
} from "./interruptionGate";

// ─── Spec hard numbers (mission) ─────────────────────────────────────────

export const FUSION_SPEC = {
  /**
   * Strong-band reference for the fused evidence score (styling/severity).
   * The DISPLAY floor is `EvidenceWeights.minVisibleScore` (default 0.70) —
   * any detector event at/above it renders on the transcript immediately.
   */
  VISIBLE_CONFIDENCE: 0.8,
  /** Medium-confidence threshold — below this the event is feed/internal only. */
  MEDIUM_CONFIDENCE: 0.5,
  /** Pre-onset attachment: word start minus 600ms … */
  PRE_ONSET_ATTACH_S: 0.6,
  /** … through word end plus 200ms. */
  POST_ONSET_ATTACH_S: 0.2,
  /** Timestamp overlap tolerance (±200ms). */
  TIMESTAMP_TOLERANCE_S: 0.2,
} as const;

// ─── Tunable weights (live developer panel) ─────────────────────────────

export interface EvidenceWeights {
  /** Multiplier on acoustic evidence for BLOCK events (0–2). */
  blockWeight: number;
  /** Multiplier on acoustic evidence for STUTTER / STAMMER events (0–2). */
  stammerWeight: number;
  /** Multiplier on acoustic evidence for PROLONGATION events (0–2). */
  prolongationWeight: number;
  /** How strongly a natural/thinking pause window suppresses an event (0–1). */
  pausePenalty: number;
  /** How strongly lexical context (filler word / mid-word dip) suppresses (0–1). */
  lexicalVetoPenalty: number;
  /** Below this evidence score an event can never be visible (0.4–0.9). */
  minVisibleScore: number;
  /** Look-ahead window (ms) for "speech resumed smoothly" evidence (100–1200). */
  lookaheadMs: number;
  /** Weight of the recovery-after-event evidence signal (0–2). */
  recoveryQualityWeight: number;
  /** Weight of the local speaker-cadence baseline signal (0–2). */
  cadenceBaselineWeight: number;
  /** Weight of the breath/sniff/short-noise suppressor (0–1). */
  noisePenalty: number;
}

export const DEFAULT_EVIDENCE_WEIGHTS: EvidenceWeights = {
  blockWeight: 1.0,
  stammerWeight: 1.0,
  prolongationWeight: 1.0,
  pausePenalty: 0.35,
  lexicalVetoPenalty: 0.3,
  minVisibleScore: 0.7, // display floor: detector confidence at/above this renders immediately
  lookaheadMs: 600,
  recoveryQualityWeight: 1.0,
  cadenceBaselineWeight: 1.0,
  noisePenalty: 0.8,
};

export const EVIDENCE_WEIGHT_META: Record<
  keyof EvidenceWeights,
  { label: string; min: number; max: number; step: number; hint: string }
> = {
  blockWeight: { label: "Block Evidence Weight", min: 0, max: 2, step: 0.05, hint: "Scales acoustic evidence for blocks" },
  stammerWeight: { label: "Stammer Evidence Weight", min: 0, max: 2, step: 0.05, hint: "Scales acoustic evidence for stutter/stammer" },
  prolongationWeight: { label: "Prolongation Weight", min: 0, max: 2, step: 0.05, hint: "Scales acoustic evidence for prolongations" },
  pausePenalty: { label: "Pause Penalty", min: 0, max: 1, step: 0.01, hint: "Suppresses events inside natural/thinking pauses" },
  lexicalVetoPenalty: { label: "Lexical Veto Penalty", min: 0, max: 1, step: 0.01, hint: "Suppresses filler words & mid-word dips" },
  minVisibleScore: { label: "Minimum Visible Score", min: 0.4, max: 0.9, step: 0.01, hint: "Display floor — detector confidence at/above this renders on the transcript immediately (default 0.70)" },
  lookaheadMs: { label: "Lookahead Window", min: 100, max: 1200, step: 25, hint: "How far to look for smooth speech resumption (ms)" },
  recoveryQualityWeight: { label: "Recovery Quality Weight", min: 0, max: 2, step: 0.05, hint: "Weight of the recovery-after-event signal" },
  cadenceBaselineWeight: { label: "Cadence Baseline Weight", min: 0, max: 2, step: 0.05, hint: "Weight of the local speaker-cadence signal" },
  noisePenalty: { label: "Noise Penalty", min: 0, max: 1, step: 0.01, hint: "Suppresses breath/sniff-like and short non-disfluent events" },
};

// ─── Verdict / output types ─────────────────────────────────────────────

export type EvidenceBand = "internal" | "feed" | "medium" | "strong";
export type RecoveryLabel = "strong" | "moderate" | "weak" | "none";

/**
 * Mission classification taxonomy. A SPECIFIC classification is only ever
 * assigned when the evidence is strong — otherwise the event is `uncertain`
 * (feed + review only, never a specific visible label).
 */
export type RefinedEventType =
  | "repetition"
  | "prolongation"
  | "block"
  | "hesitation_sequence"
  | "uncertain";

export type AttachmentPosition = "pre_onset" | "onset" | "inside" | "trailing" | "none";

export interface EvidenceBreakdown {
  /** 0..1 — acoustic magnitude × duration × per-type weight */
  acousticSignal: number;
  /** 0..1 — repeated-onset shape strength (pattern regularity) */
  onsetShape: number;
  /** 0..1 — transcript word overlap + lexical position support */
  transcriptSupport: number;
  /** 0..1 — speech resumed promptly after the event (recovery) */
  recoveryQuality: number;
  /** 0..1 — how unusual the event is vs the speaker's cadence baseline */
  cadenceBaseline: number;
  /** 0..1 — how hard the natural-pause penalty hit (0 = no hit) */
  pausePenaltyHit: number;
  /** 0..1 — how hard the lexical veto hit (0 = no hit) */
  lexicalVetoHit: number;
  /** 0..1 — how hard the breath/sniff/short-noise penalty hit (0 = no hit) */
  noisePenaltyHit: number;
}

export interface ScoredEvent {
  /** Stable identity key: `${startTime.toFixed(3)}-${type}` */
  key: string;
  event: AcousticEvent;
  /** 0..1 — fused evidence score */
  evidenceScore: number;
  band: EvidenceBand;
  /** Whether this event may be rendered as a visible transcript annotation */
  visible: boolean;
  /** Alias of !visible — explicit for review screens */
  suppressed: boolean;
  /** Human-readable reasons (empty when visible) */
  suppressionReasons: string[];
  lexicalVetoApplied: boolean;
  recoveryLabel: RecoveryLabel;
  breakdown: EvidenceBreakdown;
  /** Speechmatics word the event is ATTACHED to (pre-onset first-word rule) */
  matchedWord?: string;
  /** 0..1 — attachment strength with the matched word */
  matchConfidence: number;
  /** Number of independent signals that agreed (multi-evidence requirement) */
  agreement: number;
  /** Mission classification — specific ONLY when evidence is strong */
  refinedType: RefinedEventType;
  /** Where the event sits relative to its word */
  attachmentPosition: AttachmentPosition;
  /** Why this word owns the event (logged for the debugging requirement) */
  attachmentReason: string;
  /** Stage 1 gate — was the speech FLOW interrupted (micro-pause, repeated
   *  onset, sustained segment, onset block)? A fluent word with no
   *  interruption is never classified as a stutter. */
  interruptionPassed: boolean;
  /** The interruption evidence that justified classification (empty when rejected). */
  interruptionSignals: string[];
  /** Why the Stage 1 gate rejected the candidate (null when passed). */
  interruptionRejected: string | null;
}

// ─── Lexical context (weak signals only — never a hard decision) ─────────

/** Connectors / fillers / function words where a "block" is usually a pause. */
const LEXICAL_SOFT_WORDS = new Set([
  "okay", "ok", "well", "so", "um", "uh", "ah", "er", "hmm", "mm", "hm",
  "like", "right", "yeah", "yep", "and", "but", "or", "then", "anyway",
  "also", "now", "i", "you", "we", "the", "a", "an", "it", "to", "of",
  "in", "on", "for", "that", "is", "was", "just", "very", "really",
]);

// ─── Word context ───────────────────────────────────────────────────────

export interface WordLike {
  text: string;
  startTime: number;
  endTime: number;
}

export interface FusionContext {
  /** Finalized Speechmatics words (session clock). */
  words: WordLike[];
  /** Detected pause events (from the pause detector). */
  pauses?: PauseEvent[];
}

/** Stable key for an event (matches the Detection Feed identity). */
export function eventKey(evt: { startTime: number; type: string }): string {
  return `${evt.startTime.toFixed(3)}-${evt.type}`;
}

/** Collect deduped finalized words from Speechmatics chunks (session clock). */
export function wordsFromTranscripts(transcripts: unknown[]): WordLike[] {
  const words: WordLike[] = [];
  const seen = new Set<string>();
  for (const chunk of transcripts) {
    const c = chunk as { isFinal?: boolean; words?: unknown[] };
    if (!c.isFinal) continue;
    for (const w of c.words ?? []) {
      const ww = w as { text?: string; word?: string; startTime: number; endTime: number };
      const text = ww.text || ww.word || "";
      if (!text) continue;
      const key = `${Math.round(ww.startTime * 1000)}-${Math.round(ww.endTime * 1000)}-${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      words.push({ text, startTime: ww.startTime, endTime: ww.endTime });
    }
  }
  return words.sort((a, b) => a.startTime - b.startTime);
}

// ─── Evidence scoring ───────────────────────────────────────────────────

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function typeFactor(type: AcousticEventType, w: EvidenceWeights): number {
  switch (type) {
    case "block": return w.blockWeight;
    case "stutter":
    case "stammer": return w.stammerWeight;
    case "prolongation": return w.prolongationWeight;
    default: return 1; // repetition — neutral (no dedicated slider in the spec)
  }
}

/**
 * WORD ATTRIBUTION — pre-onset, first-word, no drift (mission-critical).
 *
 * A stutter usually happens BEFORE the lexical word is finalized
 * ("s-s-s-" then "slap"). Instead of requiring overlap, each finalized
 * word owns events inside
 *     [word.start − 600ms, word.end + 200ms]
 * The FIRST word (chronological) whose window fits the event owns it —
 * events never drift to later words just because timestamps are closer.
 */
function findAttributedWord(
  evt: AcousticEvent,
  words: WordLike[]
): { word?: WordLike; position: AttachmentPosition; confidence: number; reason: string } {
  if (words.length === 0) {
    return { position: "none", confidence: 0, reason: "no finalized words yet" };
  }
  const evtDur = Math.max(0.001, evt.endTime - evt.startTime);
  const { PRE_ONSET_ATTACH_S } = FUSION_SPEC;
  // A block is the silence/struggle leading INTO the following word — the
  // END of the block meets the word onset, so the pre-onset net is wider
  // for blocks ("------cat" → [Block] cat, never a bare pause).
  const MAX_PRE_ONSET_S = evt.type === "block" ? 0.9 : PRE_ONSET_ATTACH_S;

  for (const w of words) {
    // 1) Direct overlap — event covers the word or sits inside it.
    const overlap = Math.max(
      0,
      Math.min(w.endTime, evt.endTime) - Math.max(w.startTime, evt.startTime)
    );
    if (overlap > 0) {
      const wd = Math.max(0.001, w.endTime - w.startTime);
      const relStart = (evt.startTime - w.startTime) / wd;
      const position: AttachmentPosition =
        relStart <= 0.3 ? "onset" : relStart >= 0.75 ? "trailing" : "inside";
      const ratio = Math.min(1, overlap / evtDur);
      return {
        word: w,
        position,
        confidence: 0.5 + 0.5 * ratio,
        reason: "timestamp overlap",
      };
    }

    // 2) Pre-onset — the event ends shortly before (or exactly at) the onset.
    //    Stutters/repetitions happen BEFORE the lexical word; blocks release
    //    INTO it. The FIRST following word owns the event — never drift.
    const preGap = w.startTime - evt.endTime; // >0 when the event ends before the word
    if (preGap >= -0.05 && preGap <= MAX_PRE_ONSET_S) {
      const proximity = 1 - preGap / MAX_PRE_ONSET_S; // 1 when flush with onset
      return {
        word: w,
        position: "pre_onset",
        confidence: 0.35 + 0.65 * proximity,
        reason: "pre-onset attachment",
      };
    }
  }

  return { position: "none", confidence: 0, reason: "no word within attachment window" };
}

/**
 * Export the pre-onset first-word attribution index for shared consumers
 * (visible word tags, review transcript, recovery assignment). Returns the
 * index of the FIRST word whose attachment window
 *     [word.start − 600ms, word.end + 200ms]
 * fits the event, or -1 when no word owns it. Events never drift to later
 * words just because timestamps are closer.
 */
export function attributedWordIndex(
  evt: { startTime: number; endTime: number; type?: string },
  words: WordLike[]
): number {
  const { PRE_ONSET_ATTACH_S } = FUSION_SPEC;
  const MAX_PRE_ONSET_S = evt.type === "block" ? 0.9 : PRE_ONSET_ATTACH_S;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const overlap = Math.min(w.endTime, evt.endTime) - Math.max(w.startTime, evt.startTime);
    if (overlap > 0) return i;
    const preGap = w.startTime - evt.endTime;
    if (preGap >= -0.05 && preGap <= MAX_PRE_ONSET_S) return i;
  }
  return -1;
}

function lexicalSignal(word: WordLike, position: AttachmentPosition): number {
  // Filler / connector word → weak lexical support
  const clean = word.text.toLowerCase().replace(/[^a-z']/g, "");
  if (LEXICAL_SOFT_WORDS.has(clean)) return 0.25;
  // Struggle BEFORE the word onset (incl. silent blocks) — the strong case
  if (position === "pre_onset" || position === "onset") return 1;
  // Event lands INSIDE a word that continues → weak support (internal dip =
  // emphasis / natural vowel shape — "really" spoken normally)
  if (position === "inside") return 0.45;
  if (position === "trailing") return 0.6;
  return 0.2;
}

function pausePenaltySignal(evt: AcousticEvent, pauses: PauseEvent[]): number {
  if (pauses.length === 0) return 0;
  let hit = 0;
  for (const p of pauses) {
    if (p.type !== "natural" && p.type !== "thinking") continue;
    const pad = 0.15;
    const overlaps =
      evt.startTime <= p.endTime + pad && evt.endTime >= p.startTime - pad;
    if (!overlaps) continue;
    const strength = p.type === "natural" ? 1 : 0.75;
    hit = Math.max(hit, strength);
  }
  return hit;
}

/**
 * Breath / sniff / short-noise discriminator. A real disfluency is a
 * PATTERN of multiple cues; a single fricative-like sound, a single short
 * delayed onset or a single energy dip is not enough to be visible.
 */
function noisePenaltySignal(evt: AcousticEvent, position: AttachmentPosition): number {
  let hit = 0;
  const dur = evt.durationMs;
  // Fricative-like micro-events too short to be a real stutter pattern —
  // the shape of a sniff / breath noise.
  if ((evt.type === "stutter" || evt.type === "stammer") && dur < 300 && evt.acoustic < 0.6) {
    hit = Math.max(hit, 0.8);
  }
  // A short unanchored silence is a plain pause, not a block. A brief
  // block that RELEASES into a word (position ≠ none) stays real.
  if (evt.type === "block" && dur < 250 && position === "none") {
    hit = Math.max(hit, 0.7);
  }
  // A prolongation below the spec's 350ms floor is not a prolongation.
  if (evt.type === "prolongation" && dur < 350) {
    hit = Math.max(hit, 0.6);
  }
  // No word anchor at all — for stutter/stammer this smells like a breath
  // between words. Blocks keep their own handling (they must not be missed
  // just because no transcript token exists yet).
  if ((evt.type === "stutter" || evt.type === "stammer") && position === "none") {
    hit = Math.max(hit, 0.5);
  }
  return hit;
}

function recoverySignal(
  evt: AcousticEvent,
  words: WordLike[],
  lookaheadMs: number
): { quality: number; label: RecoveryLabel } {
  const next = words.find((w) => w.startTime >= evt.endTime - 0.05);
  if (!next) return { quality: 0, label: "none" };
  const gapMs = (next.startTime - evt.endTime) * 1000;
  const quick = Math.max(250, lookaheadMs * 0.5);
  const moderate = Math.max(500, lookaheadMs * 0.8);
  const weak = Math.max(900, lookaheadMs * 1.5);
  if (gapMs <= quick) return { quality: 1, label: "strong" };
  if (gapMs <= moderate) return { quality: 0.6, label: "moderate" };
  if (gapMs <= weak) return { quality: 0.3, label: "weak" };
  return { quality: 0.1, label: "none" };
}

function cadenceSignal(evt: AcousticEvent, words: WordLike[]): number {
  if (words.length < 3) return 0.5; // neutral — no baseline yet
  const gaps: number[] = [];
  for (let i = 1; i < words.length; i++) gaps.push((words[i].startTime - words[i - 1].endTime) * 1000);
  const medGap = median(gaps);
  if (medGap <= 50) return 0.5;
  const ratio = evt.durationMs / Math.max(150, medGap);
  // Footprints near the speaker's normal cadence look natural; unusual
  // (much longer/tighter than baseline) reads as a real struggle.
  return clamp01((ratio - 0.5) / 1.2);
}

function bandFromScore(score: number): EvidenceBand {
  if (score < 0.4) return "internal";
  if (score < FUSION_SPEC.MEDIUM_CONFIDENCE) return "feed";
  if (score < FUSION_SPEC.VISIBLE_CONFIDENCE) return "medium";
  return "strong";
}

/** Mission taxonomy — a specific classification requires STRONG evidence. */
const MISSION_MAP: Record<AcousticEventType, RefinedEventType> = {
  repetition: "repetition",
  prolongation: "prolongation",
  block: "block",
  stutter: "repetition", // repeated onset shape (s-s-s-)
  stammer: "prolongation", // sustained sound (ssssss)
};

function refineType(evt: AcousticEvent, band: EvidenceBand): RefinedEventType {
  if (band !== "strong") return "uncertain";
  return MISSION_MAP[evt.type] ?? "uncertain";
}

/**
 * Score ONE raw detector event. Pure — no side effects, no mutation.
 * The detector's own confidence/acoustic values are treated as ONE
 * evidence source, never as a decision by themselves.
 */
export function scoreEvent(
  evt: AcousticEvent,
  ctx: FusionContext,
  weights: EvidenceWeights
): ScoredEvent {
  const words = ctx.words;
  const pauses = ctx.pauses ?? [];
  const key = eventKey(evt);

  // ── 1) Acoustic signal (primary, per-type weight) ──────────────
  const durNorm = Math.min(1, evt.durationMs / 700);
  const rawAcoustic = 0.5 * evt.acoustic + 0.3 * evt.confidence + 0.2 * durNorm;
  const acousticSignal = clamp01(typeFactor(evt.type, weights) * rawAcoustic);

  // ── 2) Repeated-onset shape (pattern regularity from the detector) ──
  let onsetShape = 0;
  if (evt.type === "repetition" || evt.type === "stutter" || evt.type === "stammer") {
    onsetShape = clamp01((evt.confidence - 0.5) * 2) * 0.6 + evt.acoustic * 0.4;
  } else if (evt.type === "prolongation") {
    onsetShape = clamp01((evt.confidence - 0.5) * 2);
  }

  // ── 3) Transcript support + lexical context (PRE-ONSET attribution) ──
  const match = findAttributedWord(evt, words);
  const lexical = match.word ? lexicalSignal(match.word, match.position) : 0.15;
  const transcriptSupport = clamp01(match.confidence * lexical);

  // ── STAGE 1 — Interruption Gate ────────────────────────────────────
  // Before ANY candidate may be classified as a stutter, the speech FLOW
  // must have been interrupted. A fluent word with no micro-pause before
  // it, no repeated onset, no sustained segment and no onset block is
  // normal fluent speech — the gate rejects it immediately, regardless of
  // how confident the acoustic detector was. This removes the false
  // positives on fluent function words ("could", "travel", "think", …).
  const prevWordEnd = findPrevWordEnd(words, evt.startTime);
  const gate = evaluateInterruptionGate({
    type: evt.type,
    startTime: evt.startTime,
    endTime: evt.endTime,
    durationMs: evt.durationMs,
    prevWordEnd,
    wordStart: match.word?.startTime ?? null,
    overlappingWords: countSpannedWords(words, evt.startTime, evt.endTime),
  });
  const interruptionPassed = gate.passed;
  const interruptionSignals = gate.signals;
  const interruptionRejected = gate.rejectionReason;

  // ── 4) Recovery quality (look-ahead for smooth resumption) ──────
  const rec = recoverySignal(evt, words, weights.lookaheadMs);

  // ── 5) Cadence baseline ─────────────────────────────────────────
  const cadence = cadenceSignal(evt, words);

  // ── 6) Penalties ────────────────────────────────────────────────
  const pauseHit = pausePenaltySignal(evt, pauses);
  let lexicalVetoHit = 0;
  let lexicalVetoApplied = false;
  if (match.word) {
    const clean = match.word.text.toLowerCase().replace(/[^a-z']/g, "");
    if (LEXICAL_SOFT_WORDS.has(clean)) {
      lexicalVetoHit = 1;
      lexicalVetoApplied = true;
    } else if (match.position === "inside") {
      lexicalVetoHit = 0.8;
      lexicalVetoApplied = true;
    } else if (match.position === "trailing") {
      lexicalVetoHit = 0.4;
      lexicalVetoApplied = true;
    }
  }
  const noiseHit = noisePenaltySignal(evt, match.position);

  // ── Weighted fusion (rebalanced: no single cue can reach the floor) ──
  const pos =
    0.35 * acousticSignal +
    0.15 * onsetShape +
    0.15 * transcriptSupport +
    0.2 * weights.recoveryQualityWeight * rec.quality +
    0.15 * weights.cadenceBaselineWeight * cadence;

  const penalty =
    weights.pausePenalty * pauseHit +
    weights.lexicalVetoPenalty * lexicalVetoHit +
    weights.noisePenalty * noiseHit;
  const evidenceScore = clamp01(pos - penalty);

  // ── Band + visibility ───────────────────────────────────────────
  const band = bandFromScore(evidenceScore);

  // Independent-signal agreement — informational only. The detector's own
  // confidence is the display source of truth; agreement styles the
  // dev-panel readout but no longer gates the transcript.
  let agreement = 0;
  if (transcriptSupport >= 0.5) agreement++;
  if (onsetShape >= 0.5) agreement++;
  if (rec.quality >= 0.5) agreement++;
  if (acousticSignal >= 0.6) agreement++;
  if (cadence >= 0.5) agreement++;

  // DISPLAY POLICY — "show probable disfluencies immediately, refine later":
  // any detector event whose raw temporal confidence clears the display
  // floor renders on the transcript at once, so the Detection Feed and the
  // transcript mirror each other. Only a clear false-positive fingerprint
  // removes it — never multi-signal doubt, never the fused score alone.
  let visible = evt.confidence >= weights.minVisibleScore;

  // STAGE 1 HARD VETO — a fluent event with no interruption in the speech
  // flow is never classified as a stutter, no matter how strong the raw
  // detector confidence was. The candidate still reaches the Detection
  // Feed (raw detector truth) and the Review Screen, but it can never
  // render as a visible transcript annotation.
  let fpReason: string | null = null;
  if (visible && !interruptionPassed) {
    fpReason =
      interruptionRejected ??
      "No interruption in speech flow — treated as normal fluent speech";
  }

  // Hard false-positive fingerprints (kept feed/review-only).
  // BLOCKS get the widest benefit of the doubt: a block must NEVER be
  // missed just because no transcript token exists yet, so only a TINY
  // block (under 250ms) that is fully inside a natural pause AND has a
  // weak acoustic signature reads as a plain pause. Everything else —
  // including a tense struggle with no word yet — renders immediately.
  if (visible && !fpReason) {
    if (evt.type === "block") {
      if (
        evt.durationMs < 250 &&
        evt.acoustic < 0.55 &&
        pauseHit >= 1 &&
        match.position === "none"
      ) {
        fpReason = "Short silence inside a natural pause with no release — a pause, not a block";
      }
    } else if (noiseHit > 0 && match.position === "none") {
      // Breath / sniff / single short cue with no word to attach to.
      fpReason = "Looks like a breath/sniff or a single short non-disfluent cue";
    }
  }
  if (fpReason) visible = false;

  // ── Human-readable suppression reasons ─────────────────────────
  const reasons: string[] = [];
  if (!visible) {
    if (evt.confidence < weights.minVisibleScore) {
      reasons.push(
        `Below the display floor (${(weights.minVisibleScore * 100).toFixed(0)}% detector confidence)`
      );
    }
    if (fpReason) reasons.push(fpReason);
    if (pauseHit > 0 && match.position !== "none") {
      reasons.push(pauseHit >= 1 ? "Inside a natural sentence-boundary pause" : "Inside a short thinking pause");
    }
    if (lexicalVetoApplied) {
      reasons.push(
        match.word && LEXICAL_SOFT_WORDS.has(match.word.text.toLowerCase().replace(/[^a-z']/g, ""))
          ? `Lexical veto: "${match.word.text}" is a connector/filler`
          : "Event landed inside a word that continued smoothly"
      );
    }
    if (reasons.length === 0) reasons.push("Insufficient combined evidence");
  }

  return {
    key,
    event: evt,
    evidenceScore,
    band,
    visible,
    suppressed: !visible,
    suppressionReasons: reasons,
    lexicalVetoApplied,
    recoveryLabel: rec.label,
    breakdown: {
      acousticSignal,
      onsetShape,
      transcriptSupport,
      recoveryQuality: rec.quality,
      cadenceBaseline: cadence,
      pausePenaltyHit: pauseHit,
      lexicalVetoHit,
      noisePenaltyHit: noiseHit,
    },
    matchedWord: match.word?.text,
    matchConfidence: match.confidence,
    agreement,
    refinedType: refineType(evt, band),
    attachmentPosition: match.position,
    attachmentReason: match.reason,
    interruptionPassed,
    interruptionSignals,
    interruptionRejected,
  };
}

/** Score a batch of raw detector events (used by all three modes). */
export function scoreAcousticEvents(
  events: AcousticEvent[],
  ctx: FusionContext,
  weights: EvidenceWeights
): ScoredEvent[] {
  return events.map((e) => scoreEvent(e, ctx, weights));
}

// ─── Feed enrichment (Detection Feed keeps every raw event) ──────────────

/**
 * Attach fusion verdicts onto the Detection Feed vocabulary. Purely
 * additive: the feed still shows EVERY raw event (strong / medium /
 * weak / suppressed), each now carrying its evidence score + band.
 */
export function attachEvidence(feed: FeedEvent[], scored: ScoredEvent[]): FeedEvent[] {
  const byKey = new Map<string, ScoredEvent>();
  for (const s of scored) byKey.set(s.key, s);
  return feed.map((f) => {
    const s = byKey.get(`${f.startTime.toFixed(3)}-${f.type}`);
    if (!s) return f;
    return {
      ...f,
      band: s.band,
      suppressed: s.suppressed,
      visible: s.visible,
      evidenceScore: s.evidenceScore,
    };
  });
}
