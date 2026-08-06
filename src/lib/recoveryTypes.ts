/**
 * BOLO — Event-Triggered Stutter Recovery: shared annotation contract
 *
 * The recovery layer sits BETWEEN the local acoustic detector and the
 * transcript renderers. It decides, per detector event:
 *   - "attached"    → Speechmatics finalized a word covering the event
 *                     (±200ms tolerance) — the word keeps its lexical text,
 *                     and a stuttered PREFIX span is rendered before it.
 *   - "recovered"   → Speechmatics missed the region entirely; a short clip
 *                     was cropped from the ring buffer and the local
 *                     Wav2Vec2 recognizer confidently transcribed it.
 *   - "unresolved"  → nothing confident was recovered — a conservative
 *                     placeholder like [blocked onset] is shown instead of
 *                     inventing a word.
 *
 * The detection engine is NOT touched: this module only types and renders
 * what the recovery engine produces. All timestamps are on the shared
 * session clock (the same clock Speechmatics words use).
 */

import type { AcousticEventType } from "../hooks/useAcousticAnalysis";

// ─── Status / provenance ──────────────────────────────────────────────────

export type RecoveryStatus = "attached" | "recovered" | "unresolved";
export type RecoverySource = "speechmatics" | "fallback" | "none";
export type ConfidenceBand = "strong" | "medium" | "uncertain";

export interface RecoveredAnnotation {
  id: string;
  status: RecoveryStatus;
  type: AcousticEventType;
  /** seconds — shared session clock (same as Speechmatics words) */
  startTime: number;
  endTime: number;
  durationMs: number;
  /** 0..1 — detector confidence when attached, recognizer confidence when recovered */
  confidence: number;
  band: ConfidenceBand;
  source: RecoverySource;
  /** Speechmatics base word the annotation is attached to (if any) */
  baseWord?: string;
  /** Stuttered prefix to render BEFORE the base word, e.g. "b-b-b-" */
  prefix?: string;
  /** Text recovered by the local fallback recognizer (when status=recovered) */
  recoveredText?: string;
  /** Conservative placeholder when nothing confident was recovered */
  placeholder?: string;
  /** Human-readable WHY (shown in tooltips / review) */
  reason: string;
}

// ─── Spec hard numbers: confidence bands + timestamp tolerance ────────────

export const CONFIDENCE_BANDS = {
  /** strong annotation: 0.80+ */
  strong: 0.8,
  /** medium annotation: 0.50–0.79 */
  medium: 0.5,
} as const;

export function bandFromConfidence(c: number): ConfidenceBand {
  if (c >= CONFIDENCE_BANDS.strong) return "strong";
  if (c >= CONFIDENCE_BANDS.medium) return "medium";
  return "uncertain";
}

/** ±200ms timestamp overlap tolerance (spec) */
export const TIMESTAMP_TOLERANCE_S = 0.2;

/** Pre-onset attribution: word start minus 600ms (mission spec) */
export const PRE_ONSET_ATTACH_S = 0.6;
/** Pre-onset attribution: word end plus 200ms (mission spec) */
export const POST_ONSET_S = 0.2;

// ─── Spec hard numbers: extraction window ─────────────────────────────────

export const PREROLL_S = 0.25; // 200–300ms preroll before the event
export const POSTROLL_S = 0.25; // 200–300ms postroll after the event
export const MAX_FALLBACK_CLIP_S = 2.0; // 1–2s fallback extraction window
export const HOLD_MS = 1000; // Speechmatics hold window before fallback

// ─── Prefix builder (the <span class="stutter-annotation">…</span> payload) ─

function leadingSound(word: string): string {
  const clean = word.toLowerCase().replace(/[^a-z']/g, "");
  if (!clean) return "";
  // Leading consonant cluster (up to 3) — otherwise the first vowel.
  const cluster = clean.match(/^[^aeiou']{1,3}/);
  return cluster ? cluster[0] : clean[0];
}

const repeat = (s: string, n: number): string => s.repeat(Math.max(0, n));

/**
 * Build the stuttered prefix for a detector event.
 * Pure and derived — never invents words, only repeats the base word's own
 * leading sound according to how it was spoken:
 *   slap → sssssslap (prolongation/stammer)
 *   boy  → b-b-b-boy (repetition/stutter)
 *   my   → mmmmmmy   (prolongation)
 *   word → …word     (blocked onset)
 */
export function buildStutterPrefix(
  type: AcousticEventType,
  baseWord?: string
): string | undefined {
  const sound = baseWord ? leadingSound(baseWord) : "";
  switch (type) {
    case "stutter":
      return sound ? `${sound}-${sound}-${sound}-` : "s-s-s-";
    case "stammer":
      return sound ? repeat(sound, 5) : "ssssss";
    case "prolongation":
      return sound ? repeat(sound, 5) : "mmmmm";
    case "repetition":
      return sound ? `${sound}-${sound}-${sound}-` : "b-b-b-";
    case "block":
      return "…"; // silent onset — a marker, never a made-up sound
    default:
      return undefined;
  }
}

/** Conservative placeholder when the fallback cannot recover a word (spec). */
export function placeholderFor(type: AcousticEventType): string {
  switch (type) {
    case "prolongation":
      return "[prolonged sound]";
    case "stammer":
      return "[prolonged sound]";
    case "block":
      return "[blocked onset]";
    case "repetition":
      return "[repeated onset]";
    default:
      return "[unrecognized stutter]";
  }
}

// ─── Timestamp mapping (renderer-only; never creates annotations) ──────────

export interface TimedSpan {
  startTime: number;
  endTime: number;
}

export interface RecoveredAssignment {
  /** Annotation attached to this span (parallel to `spans`), or null */
  attachedBySpan: (RecoveredAnnotation | null)[];
  /** Annotations with no matching word — rendered as standalone tokens */
  standalone: RecoveredAnnotation[];
}

/**
 * Attach each "attached" annotation to its word span using the mission's
 * PRE-ONSET first-word window:
 *     [word.start − 600ms, word.end + 200ms]
 * The FIRST word whose window fits the annotation owns it (annotations never
 * drift to later words just because timestamps are closer). "Recovered" /
 * "unresolved" annotations have no lexical word and are returned as
 * standalone tokens for the renderer to insert inline.
 */
export function assignRecoveredToSpans<T extends TimedSpan>(
  recs: RecoveredAnnotation[],
  spans: T[]
): RecoveredAssignment {
  const attachedBySpan: (RecoveredAnnotation | null)[] = spans.map(() => null);
  const standalone: RecoveredAnnotation[] = [];
  if (recs.length === 0) return { attachedBySpan, standalone };

  for (const rec of recs) {
    if (rec.status !== "attached") {
      standalone.push(rec);
      continue;
    }
    let bestIdx = -1;
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      const inWindow =
        rec.startTime >= s.startTime - PRE_ONSET_ATTACH_S &&
        rec.endTime <= s.endTime + POST_ONSET_S;
      if (!inWindow) continue;
      bestIdx = i; // FIRST matching span — pre-onset first-word rule
      break;
    }
    if (bestIdx >= 0) {
      attachedBySpan[bestIdx] = rec;
    } else {
      standalone.push(rec);
    }
  }

  return { attachedBySpan, standalone };
}
