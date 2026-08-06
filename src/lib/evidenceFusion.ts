/**
 * BOLO — Confidence & Evidence Fusion Layer (strict attribution)
 *
 * Sits between the raw acoustic detector and the transcript annotation
 * layer. The base detector is NOT touched: every raw event still reaches
 * the Detection Feed and the Review Screen. This layer ONLY decides
 * whether an event may ALSO become a visible transcript annotation and
 * WHICH Speechmatics word owns it.
 *
 * Core rules (mission):
 *   - no single acoustic cue creates a visible annotation
 *   - multiple independent signals must agree
 *   - visible-confidence threshold is 0.80; medium starts at 0.50
 *   - attribution is PRE-ONSET, not overlap-only:
 *       word.start − 600ms … word.end + 200ms
 *     the FIRST appropriate word owns the event — events never drift to
 *     later words just because timestamps are closer
 *   - classification (repetition / prolongation / block / hesitation /
 *     uncertain) is only assigned when evidence is strong — weak or mixed
 *     evidence stays `uncertain` (feed/review only)
 *   - breaths, sniffs, natural pauses and emphasis never render visibly
 *
 * Evidence bands (spec):
 *   0.00–0.49  internal/feed — kept in logs + feed, never rendered
 *   0.50–0.79  medium        — visible only if 3+ independent signals agree
 *   0.80–1.00  strong        — visible when 2+ independent signals agree
 *
 * The developer sliders map 1:1 onto EvidenceWeights so the team can tune
 * false positives away live — no reload, no rebuild.
 */

import type { AcousticEvent, AcousticEventType } from "../hooks/useAcousticAnalysis";
import type { PauseEvent } from "./pauseDetector";
import type { FeedEvent } from "./feedEvents";

// ─── Spec hard numbers (mission) ─────────────────────────────────────────

export const FUSION_SPEC = {
  /** Visible-confidence threshold — only ≥ this may render. */
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
  minVisibleScore: 0.8, // spec: visible-confidence threshold
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
  minVisibleScore: { label: "Minimum Visible Score", min: 0.4, max: 0.9, step: 0.01, hint: "Floor for any visible annotation (spec default 0.80)" },
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
  const { PRE_ONSET_ATTACH_S, POST_ONSET_ATTACH_S } = FUSION_SPEC;

  for (const w of words) {
    const inWindow =
      evt.startTime >= w.startTime - PRE_ONSET_ATTACH_S &&
      evt.endTime <= w.endTime + POST_ONSET_ATTACH_S;
    if (!inWindow) continue;

    const overlap = Math.max(
      0,
      Math.min(w.endTime, evt.endTime) - Math.max(w.startTime, evt.startTime)
    );
    const preGap = w.startTime - evt.endTime; // >0 when the event ends before the word

    // 1) Direct overlap — event covers the word or sits inside it.
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
    if (preGap >= -0.05 && preGap <= PRE_ONSET_ATTACH_S) {
      const proximity = 1 - preGap / PRE_ONSET_ATTACH_S; // 1 when flush with onset
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
  evt: { startTime: number; endTime: number },
  words: WordLike[]
): number {
  const { PRE_ONSET_ATTACH_S, POST_ONSET_ATTACH_S } = FUSION_SPEC;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (
      evt.startTime >= w.startTime - PRE_ONSET_ATTACH_S &&
      evt.endTime <= w.endTime + POST_ONSET_ATTACH_S
    ) {
      return i;
    }
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
  // A single short delayed onset is not a block.
  if (evt.type === "block" && dur < 250) {
    hit = Math.max(hit, 0.7);
  }
  // A prolongation below the spec's 350ms floor is not a prolongation.
  if (evt.type === "prolongation" && dur < 350) {
    hit = Math.max(hit, 0.6);
  }
  // No word anchor at all — the event sits in a gap (breath between words).
  if (position === "none") {
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

  // Independent-signal agreement (multi-evidence requirement):
  //   strong band → needs ≥ 2 signals; medium band → needs ≥ 3.
  let agreement = 0;
  if (transcriptSupport >= 0.5) agreement++;
  if (onsetShape >= 0.5) agreement++;
  if (rec.quality >= 0.5) agreement++;
  if (acousticSignal >= 0.6) agreement++;
  if (cadence >= 0.5) agreement++;

  let visible = false;
  if (evidenceScore < weights.minVisibleScore) {
    visible = false;
  } else if (band === "strong") {
    visible = agreement >= 2;
  } else if (band === "medium") {
    visible = agreement >= 3;
  } else {
    visible = false;
  }

  // ── Human-readable suppression reasons ─────────────────────────
  const reasons: string[] = [];
  if (!visible) {
    if (band === "internal") reasons.push("Evidence below internal threshold — kept in logs only");
    else if (band === "feed") reasons.push("Weak evidence — detection feed only");
    if (evidenceScore < weights.minVisibleScore) {
      reasons.push(`Below minimum visible score (${(weights.minVisibleScore * 100).toFixed(0)}%)`);
    }
    if (band === "strong" && agreement < 2) {
      reasons.push("Strong magnitude but independent signals disagree — feed only");
    }
    if (band === "medium" && agreement < 3) {
      reasons.push("Medium evidence — needs 3+ independent signals to render");
    }
    if (pauseHit > 0) {
      reasons.push(pauseHit >= 1 ? "Inside a natural sentence-boundary pause" : "Inside a short thinking pause");
    }
    if (lexicalVetoApplied) {
      reasons.push(
        match.word && LEXICAL_SOFT_WORDS.has(match.word.text.toLowerCase().replace(/[^a-z']/g, ""))
          ? `Lexical veto: "${match.word.text}" is a connector/filler`
          : "Event landed inside a word that continued smoothly"
      );
    }
    if (noiseHit > 0) {
      reasons.push("Looks like a breath/sniff or a single short non-disfluent cue");
    }
    if (rec.label === "none" || rec.label === "weak") {
      reasons.push("Weak recovery — speech did not resume promptly");
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
