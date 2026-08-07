/**
 * BOLO — Event-Centric Speech Event Engine (core logic)
 *
 * The shared contract for the FOUR-layer pipeline (spec):
 *   1. Acoustic Event Detector   → raw DSP events (already exists, untouched)
 *   2. Lexical Resolver          → Speechmatics words (already exists, untouched)
 *   3. Backup Lexical Resolver   → on-demand local fallback (Web Worker)
 *   4. Fusion / Event Engine     → THIS module + useEventEngine
 *
 * Every suspicious acoustic pattern becomes a SpeechEvent IMMEDIATELY (OPEN)
 * and is updated over time — we never wait for the sentence to finish:
 *
 *   OPEN        DSP sees a candidate event
 *   WAITING     hold window active (may still finalize / running fallback)
 *   RESOLVED    lexical anchor found (Speechmatics or local fallback)
 *   SUPPRESSED  likely normal speech / breath / sniff / rhetorical pause
 *
 * Decisions use the mission's 3-way verification:
 *   Case A — Speechmatics + local + DSP agree → accept immediately
 *   Case B — Speechmatics missed, local recovers it with strong DSP → accept
 *   Case C — Speechmatics anchors the word + DSP shows a real event → keep it
 *   Case D — Speechmatics and local disagree → feed-only, never transcript
 *
 * Hard numbers (spec) are in EVENT_SPEC. All timestamps are on the shared
 * session clock (the same clock Speechmatics words use).
 */

import type { AcousticEvent } from "../hooks/useAcousticAnalysis";

// ─── Types ──────────────────────────────────────────────────────────────

export type SpeechEventState =
  | "OPEN"
  | "WAITING"
  | "READY"
  | "RESOLVED"
  | "SUPPRESSED";

export type RenderStatus =
  | "transcript-visible"
  | "feed-only"
  | "internal-only";

export type AcousticType =
  | "block"
  | "prolongation"
  | "repetition"
  | "hesitation"
  | "uncertain";

export type VerdictCase =
  | "case_a"
  | "case_b"
  | "case_c"
  | "case_d"
  | "suppressed";

export interface SpeechEvent {
  id: string;
  /** seconds — session clock */
  startTime: number;
  endTime: number | null;
  durationMs: number;
  /** Spec taxonomy (block / prolongation / repetition / …) */
  acousticType: AcousticType;
  /** Raw detector type (stutter / stammer / block / …) — display vocabulary */
  rawType: string;
  /** 0..1 — DSP evidence strength */
  acousticConfidence: number;
  speechmaticsWord?: string | null;
  speechmaticsConfidence?: number | null;
  localWord?: string | null;
  localConfidence?: number | null;
  state: SpeechEventState;
  renderStatus: RenderStatus;
  /** Bounded human-readable WHY (debugging requirement) */
  reasonLog: string[];
  decision?: VerdictCase;
  /** Dynamic snippet boundaries sent to the fallback (seconds) */
  snippet?: { start: number; end: number } | null;
  /** Timestamp anchor locked when a local word is accepted (dedup) */
  lockedWindow?: { start: number; end: number } | null;
  /** Internal wall-clock deadline for the hold window */
  holdDeadlineMs?: number | null;
  /** Internal wall-clock creation time */
  createdAtMs?: number;
}

// ─── Spec hard numbers ──────────────────────────────────────────────────

export const EVENT_SPEC = {
  /** Initial hold window after a DSP event before the fallback runs (spec). */
  HOLD_MS: 1000,
  /** Pre-roll padding for the fallback clip (spec). */
  PREROLL_S: 0.3,
  /** Post-roll after fluent continuation (spec). */
  POSTROLL_S: 0.4,
  /** Minimum fallback clip (spec) — short events still get context. */
  MIN_CLIP_S: 0.8,
  /** Preferred fallback clip (spec: 1.0–2.0s). */
  PREF_CLIP_S: 2.0,
  /** Maximum fallback clip (spec: 5–6s). */
  MAX_CLIP_S: 6.0,
  /** Timestamp matching tolerance (spec: ±200ms). */
  TOLERANCE_S: 0.2,
  /** Pre-onset attribution: word start minus 600ms (mission). */
  PRE_ONSET_S: 0.6,
  /** Post-onset attribution: word end plus 200ms (mission). */
  POST_ONSET_S: 0.2,
  /** Visible-confidence band (spec). */
  VISIBLE_CONF: 0.8,
  /** Medium-confidence band (spec: 0.55–0.79 = feed or strong-anchor only). */
  MEDIUM_CONF: 0.55,
  /** Max age before an unresolved event is force-suppressed. */
  MAX_AGE_S: 7.0,
} as const;

// ─── Helpers ────────────────────────────────────────────────────────────

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function normalizeWord(w?: string | null): string {
  return (w ?? "").toLowerCase().replace(/[^a-z0-9']/g, "");
}

/** Raw detector type → spec acoustic taxonomy. */
export function rawToAcousticType(raw: string): AcousticType {
  switch (raw) {
    case "block":
      return "block";
    case "repetition":
      return "repetition";
    case "prolongation":
      return "prolongation";
    case "stutter":
      return "repetition"; // repeated-onset shape (s-s-s-)
    case "stammer":
      return "prolongation"; // sustained sound (ssssss)
    default:
      return "uncertain";
  }
}

/** Stable word key — identical to the transcript renderer's tag keys. */
export function wordKeyOf(w: { startTime: number; endTime: number }): string {
  return `${Math.round(w.startTime * 1000)}-${Math.round(w.endTime * 1000)}`;
}

/**
 * Fraction (0..1) of the EVENT that overlaps the word. Pre-onset events
 * (silent blocks before a word) score by proximity to the word onset.
 */
export function timingOverlap(
  evt: { startTime: number; endTime: number | null },
  w: { startTime: number; endTime: number }
): number {
  const eEnd = evt.endTime ?? evt.startTime;
  const eDur = Math.max(0.001, eEnd - evt.startTime);
  const intersect = Math.min(eEnd, w.endTime) - Math.max(evt.startTime, w.startTime);
  if (intersect <= 0) {
    const gap = w.startTime - eEnd;
    if (gap >= 0 && gap <= EVENT_SPEC.PRE_ONSET_S) {
      return 1 - gap / EVENT_SPEC.PRE_ONSET_S;
    }
    return 0;
  }
  return clamp01(intersect / eDur);
}

/**
 * Mission attribution window — the FIRST word whose window
 * [w.start − 600ms, w.end + 200ms] fits the event owns it. Direct overlap
 * within ±200ms tolerance also counts (events never drift to later words).
 */
export function eventInWordWindow(
  evt: { startTime: number; endTime: number | null },
  w: { startTime: number; endTime: number }
): boolean {
  const eEnd = evt.endTime ?? evt.startTime;
  if (
    evt.startTime >= w.startTime - EVENT_SPEC.PRE_ONSET_S &&
    eEnd <= w.endTime + EVENT_SPEC.POST_ONSET_S
  ) {
    return true;
  }
  const intersect = Math.min(eEnd, w.endTime) - Math.max(evt.startTime, w.startTime);
  return intersect > -EVENT_SPEC.TOLERANCE_S;
}

// ─── Weighted confidence / evidence engine ─────────────────────────────

export interface WeightedEvidenceInput {
  acousticConfidence: number;
  durationMs: number;
  timingOverlap?: number;
  smConfidence?: number | null;
  /** SM word agrees with the recovered / script word */
  smAgree?: boolean;
  localConfidence?: number | null;
  /** Local word agrees with the SM / script word */
  localAgree?: boolean;
  scriptAgree?: boolean;
  /** 0..1 — speech resumed promptly after the event */
  recoveryQuality?: number;
}

/**
 * Multi-signal weighted confidence (spec: never rely on Speechmatics
 * confidence alone). Combines acoustic duration/strength, lexical agreement,
 * timing overlap and recovery quality.
 */
export function weightedConfidence(i: WeightedEvidenceInput): number {
  const durNorm = clamp01(i.durationMs / 700);
  const acoustic =
    0.6 * i.acousticConfidence + 0.25 * durNorm + 0.15 * (i.timingOverlap ?? 1);

  const smTerm =
    i.smConfidence != null
      ? i.smConfidence * (i.smAgree ? 1 : 0.5)
      : 0;
  const localTerm =
    i.localConfidence != null
      ? i.localConfidence * (i.localAgree ? 1 : 0.5)
      : 0;

  return clamp01(
    0.34 * acoustic +
      0.36 * smTerm +
      0.16 * localTerm +
      0.08 * (i.scriptAgree ? 1 : 0) +
      0.06 * (i.recoveryQuality ?? 0.5)
  );
}

/**
 * Spec scoring bands:
 *   ≥ 0.80                          → transcript-visible
 *   0.55–0.79 + strong lexical anchor → transcript-visible
 *   0.55–0.79                        → feed-only
 *   < 0.55                           → internal-only
 */
export function renderStatusFor(
  score: number,
  strongLexicalAnchor = false
): RenderStatus {
  if (score >= EVENT_SPEC.VISIBLE_CONF) return "transcript-visible";
  if (score >= EVENT_SPEC.MEDIUM_CONF && strongLexicalAnchor) {
    return "transcript-visible";
  }
  if (score >= EVENT_SPEC.MEDIUM_CONF) return "feed-only";
  return "internal-only";
}

// ─── 3-way verification (mission decision logic) ────────────────────────

export interface VerifyInput {
  acousticType: AcousticType;
  acousticConfidence: number;
  smWord?: string | null;
  smConfidence?: number | null;
  localWord?: string | null;
  localConfidence?: number | null;
  timingOverlap?: number;
  scriptWord?: string | null;
}

export interface VerifyResult {
  case: VerdictCase;
  word: string | null;
  confidence: number;
  reason: string;
}

export function verifyThreeWay(i: VerifyInput): VerifyResult {
  const sm = normalizeWord(i.smWord);
  const local = normalizeWord(i.localWord);
  const script = normalizeWord(i.scriptWord);
  const smStrong = sm.length > 0 && (i.smConfidence ?? 0) >= 0.55;
  const localStrong = local.length > 0 && (i.localConfidence ?? 0) >= 0.6;
  const dspStrong = i.acousticConfidence >= 0.65;

  // Case A — all three point to the same word/region: accept immediately.
  if (smStrong && localStrong && sm === local && dspStrong) {
    return {
      case: "case_a",
      word: i.smWord ?? null,
      confidence: 0.92,
      reason: "Case A — Speechmatics, local fallback and DSP agree",
    };
  }

  // Case C — Speechmatics anchors the word, DSP shows a real event.
  if (smStrong && dspStrong) {
    return {
      case: "case_c",
      word: i.smWord ?? null,
      confidence: 0.85,
      reason: "Case C — Speechmatics anchor + DSP event (fallback not required)",
    };
  }

  // Case C variant — Speechmatics + script agree.
  if (smStrong && script.length > 0 && sm === script && dspStrong) {
    return {
      case: "case_c",
      word: i.smWord ?? null,
      confidence: 0.86,
      reason: "Case C — Speechmatics + script agreement",
    };
  }

  // Case B — Speechmatics missed the word, local fallback found it.
  if (!smStrong && localStrong && dspStrong) {
    return {
      case: "case_b",
      word: i.localWord ?? null,
      confidence: 0.8,
      reason: "Case B — Speechmatics missed, local recovered with strong DSP",
    };
  }

  // Case B variant — no Speechmatics word, but the script word + strong DSP.
  if (!smStrong && script.length > 0 && dspStrong) {
    return {
      case: "case_b",
      word: i.scriptWord ?? null,
      confidence: 0.74,
      reason: "Case B — script-consistent anchor with strong DSP",
    };
  }

  // Case D — Speechmatics and local disagree: keep out of the transcript.
  if (smStrong && localStrong && sm !== local) {
    return {
      case: "case_d",
      word: null,
      confidence: 0.4,
      reason: "Case D — Speechmatics/local disagree — kept feed-only",
    };
  }

  return {
    case: "suppressed",
    word: null,
    confidence: 0.3,
    reason: "insufficient independent evidence",
  };
}

// ─── Event factory ─────────────────────────────────────────────────────

let uid = 0;

export function createOpenEvent(evt: AcousticEvent): SpeechEvent {
  const id = `evt-${Date.now().toString(36)}-${(uid++).toString(36)}`;
  return {
    id,
    startTime: evt.startTime,
    endTime: evt.endTime,
    durationMs: evt.durationMs,
    acousticType: rawToAcousticType(evt.type),
    rawType: evt.type,
    acousticConfidence: evt.confidence,
    speechmaticsWord: null,
    speechmaticsConfidence: null,
    localWord: null,
    localConfidence: null,
    state: "OPEN",
    renderStatus: "internal-only",
    reasonLog: [],
    snippet: null,
    lockedWindow: null,
    holdDeadlineMs: null,
  };
}
