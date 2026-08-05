/**
 * BOLO — Timeline Engine (Pattern Detector)
 *
 * Runs on the main thread. Receives classified frames from the AudioWorklet,
 * maintains a rolling buffer, and applies the spec's pattern rules with
 * a 150ms lookback delay.
 *
 * The timeline buffer is the source of truth for pattern inference. It stores
 * frames in timestamp order and does NOT throw away evidence early.
 *
 * ── Pipeline ──
 * Frame stream → Rolling 750ms buffer → Pattern rules → Scored StutterCandidates
 *
 * ── Future ML compatibility ──
 * The same frame data, event objects, and fusion records work with an ML
 * classifier replacing only the pattern engine layer.
 */

import type { StutterCandidate, TimelineFrame } from "./stutterTypes";

// ─── Config (per spec) ──────────────────────────────────────────────────

/** Rolling analysis window for pattern detection */
const ANALYSIS_WINDOW_MS = 750;

/** Lookback delay — don't flag events younger than this (wait for more context) */
const LOOKBACK_DELAY_MS = 150;

/** --- Repetition --- */
const REP_WINDOW_MS = 600;
const REP_MIN_PLOSIVE_BURSTS = 3;   // b-b-b- pattern
const REP_MIN_FRICATIVE_BURSTS = 3; // s-s-s- pattern
const REP_PLOSIVE_GAP_MAX_MS = 200; // max gap between plosive bursts
const REP_FRICATIVE_GAP_MAX_MS = 250; // max gap between fricative bursts

/** --- Prolongation --- */
const PROLONG_MIN_MS = 350;         // per spec

/** --- Block --- */
const BLOCK_MIN_SILENCE_MS = 300;   // per spec
const BLOCK_POST_BURST_WINDOW_MS = 200; // must see burst within this after silence

/** --- Hesitation sequence --- */
const HESIT_CLUSTER_WINDOW_MS = 2500;
const HESIT_MIN_FRAGMENTS = 3;
const HESIT_FRAGMENT_MAX_GAP_MS = 1000;

/** --- False start --- */
const FALSE_START_MAX_MS = 500;
const FALSE_START_RESTART_WINDOW_MS = 1000;

/** --- De-dupe --- */
const DEDUPE_WINDOW_MS = 300;

// ─── Frame label enum (must match worklet) ──────────────────────────
export const LABEL = {
  SILENCE: 0,
  BREATH: 1,
  FRICATIVE: 2,
  VOICED: 3,
  PLOSIVE_BURST: 4,
  TENSE_HOLD: 5,
  UNKNOWN: 6,
} as const;

export type FrameLabelNum = (typeof LABEL)[keyof typeof LABEL];

// ─── Event types we produce ─────────────────────────────────────────

export type PatternEventType =
  | "repetition"
  | "prolongation"
  | "block"
  | "tense_block"
  | "hesitation_sequence"
  | "possible_false_start";

// ─── In-progress event candidates ───────────────────────────────────

interface PatternRun {
  /** Pattern type being tracked */
  type: PatternEventType;
  /** Timestamp of the first evidence */
  startT: number;
  /** Timestamp of the latest evidence */
  lastT: number;
  /** Accumulated evidence items */
  evidence: EvidenceItem[];
  /** Whether this run was already emitted (de-dupe) */
  emitted: boolean;
}

interface EvidenceItem {
  type: string;
  timestamp: number;
  weight: number;
  description: string;
}

// ─── Timeline Engine ────────────────────────────────────────────────

export class TimelineEngine {
  /** Rolling frame buffer (up to ANALYSIS_WINDOW_MS + some margin) */
  private _frames: TimelineFrame[] = [];

  /** Emitted events (ready for the fusion layer) */
  private _events: StutterCandidate[] = [];

  /** Listeners for live updates */
  private _listeners = new Set<(events: StutterCandidate[]) => void>();

  /** Active pattern runs being tracked */
  private _runs: PatternRun[] = [];

  /** De-dupe: last event emit times per type */
  private _lastEmit: Record<string, number> = {};

  /** Activity state */
  private _inSpeechBurst = false;
  private _lastSpeechEndT = 0;
  private _speechStartT = 0;

  // ── Feed frames from the worklet ──────────────────────────────────

  /** Push a new classified frame into the timeline buffer. */
  pushFrame(frame: TimelineFrame): void {
    this._frames.push(frame);
    this._pruneFrames(frame.t);

    // Run pattern detection with lookback delay
    const analysisCutoff = frame.t - LOOKBACK_DELAY_MS / 1000;
    if (analysisCutoff > 0) {
      this._runPatternDetection(analysisCutoff);
    }
  }

  /** Push multiple frames at once (e.g., when catching up). */
  pushFrames(frames: TimelineFrame[]): void {
    for (const f of frames) {
      this._frames.push(f);
    }
    this._pruneFrames(frames.length > 0 ? frames[frames.length - 1].t : 0);

    const cutoff = frames.length > 0
      ? frames[frames.length - 1].t - LOOKBACK_DELAY_MS / 1000
      : 0;
    if (cutoff > 0) {
      this._runPatternDetection(cutoff);
    }
  }

  /** Get all emitted events. */
  getEvents(): StutterCandidate[] {
    return [...this._events];
  }

  /** Get the current frame buffer for inspection/debugging. */
  getFrameBuffer(): TimelineFrame[] {
    return [...this._frames];
  }

  /** Subscribe to new events. Returns unsubscribe function. */
  subscribe(fn: (events: StutterCandidate[]) => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Reset the engine for a new session. */
  reset(): void {
    this._frames = [];
    this._events = [];
    this._runs = [];
    this._lastEmit = {};
    this._inSpeechBurst = false;
    this._lastSpeechEndT = 0;
    this._speechStartT = 0;
  }

  // ── Frame buffer management ──────────────────────────────────────

  /** Remove frames older than the analysis window + margin. */
  private _pruneFrames(currentT: number): void {
    const cutoff = currentT - (ANALYSIS_WINDOW_MS + 500) / 1000;
    while (this._frames.length > 0 && this._frames[0].t < cutoff) {
      this._frames.shift();
    }
  }

  /** Get frames within a time window ending at `endT`. */
  private _framesInWindow(endT: number, windowMs: number): TimelineFrame[] {
    const startT = endT - windowMs / 1000;
    // Binary search for start
    let lo = 0, hi = this._frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._frames[mid].t < startT) lo = mid + 1;
      else hi = mid;
    }
    const result: TimelineFrame[] = [];
    for (let i = lo; i < this._frames.length && this._frames[i].t <= endT; i++) {
      result.push(this._frames[i]);
    }
    return result;
  }

  // ── Pattern detection ────────────────────────────────────────────

  private _runPatternDetection(cutoffT: number): void {
    const windowEnd = cutoffT;
    const windowStart = windowEnd - ANALYSIS_WINDOW_MS / 1000;

    if (windowStart <= 0) return;

    const window = this._framesInWindow(windowEnd, ANALYSIS_WINDOW_MS);
    if (window.length < 3) return; // need at least a few frames to detect patterns

    this._detectRepetitions(window, windowEnd);
    this._detectProlongations(window, windowEnd);
    this._detectBlocks(window, windowEnd);
    this._detectHesitationSequences(window, windowEnd);
    this._detectFalseStarts(window, windowEnd);
  }

  // ── 1. Repetition detection ──────────────────────────────────────

  /**
   * Detects both b-b-b (PLOSIVE_BURST) and s-s-s (FRICATIVE burst) patterns.
   *
   * Rule: ≥3 onsets (PLOSIVE_BURST or FRICATIVE) within REP_WINDOW_MS,
   * separated by non-matching frames (micro-dips in volume).
   */
  private _detectRepetitions(window: TimelineFrame[], nowT: number): void {
    // Pattern A: PLOSIVE_BURST repetitions (b-b-b-boy)
    const plosiveFrames = window.filter(f => f.label === LABEL.PLOSIVE_BURST);
    if (plosiveFrames.length >= REP_MIN_PLOSIVE_BURSTS) {
      const spanMs = (plosiveFrames[plosiveFrames.length - 1].t - plosiveFrames[0].t) * 1000;
      if (spanMs <= REP_WINDOW_MS) {
        // Check bursts are separated (have non-PLOSIVE frames between them)
        // by verifying gaps aren't too large
        const wellSeparated = this._checkBurstSeparation(
          plosiveFrames, LABEL.PLOSIVE_BURST, REP_PLOSIVE_GAP_MAX_MS
        );
        if (wellSeparated) {
          this._emitRepetition(plosiveFrames, nowT, "PLOSIVE_BURST");
        }
      }
    }

    // Pattern B: FRICATIVE burst repetitions (s-s-s-something)
    const fricativeFrames = window.filter(f => f.label === LABEL.FRICATIVE);
    if (fricativeFrames.length >= REP_MIN_FRICATIVE_BURSTS) {
      const spanMs = (fricativeFrames[fricativeFrames.length - 1].t - fricativeFrames[0].t) * 1000;
      if (spanMs <= REP_WINDOW_MS) {
        const wellSeparated = this._checkBurstSeparation(
          fricativeFrames, LABEL.FRICATIVE, REP_FRICATIVE_GAP_MAX_MS
        );
        if (wellSeparated) {
          this._emitRepetition(fricativeFrames, nowT, "FRICATIVE");
        }
      }
    }
  }

  /** Check that bursts are separated by some non-matching frames (micro-dips). */
  private _checkBurstSeparation(
    burstFrames: TimelineFrame[],
    labelType: number,
    maxGapMs: number
  ): boolean {
    // Get the frame indices in the full window
    if (burstFrames.length < 2) return false;

    // Verify that between successive burst frames, there's at least one
    // non-burst frame (the micro-dip), AND the gap isn't too large
    for (let i = 1; i < burstFrames.length; i++) {
      const gapMs = (burstFrames[i].t - burstFrames[i - 1].t) * 1000;
      if (gapMs > maxGapMs) return false;

      // Check there's at least one frame between them that's NOT the burst type
      const between = this._frames.filter(
        f => f.t > burstFrames[i - 1].t && f.t < burstFrames[i].t
      );
      const hasDip = between.some(f => f.label !== labelType);
      if (!hasDip && between.length > 0) return false;
    }

    return true;
  }

  private _emitRepetition(
    frames: TimelineFrame[], nowT: number, pattern: string
  ): void {
    const startT = frames[0].t;
    const endT = frames[frames.length - 1].t;
    const count = frames.length;
    const gapMs = (endT - startT) * 1000;

    // Scoring
    let score = 0;
    const reasons: string[] = [];

    // Repeated onset
    score += 2;
    reasons.push(`Multiple speech onsets (${count}) within a short window.`);

    // Micro-pause between onsets
    if (count >= 3) score += 2;
    reasons.push(`Burst pattern detected: ${count} ${pattern} segments over ${gapMs.toFixed(0)}ms.`);

    // No stable continuation (check if frames after last burst are still non-speech)
    const afterBurst = this._frames.filter(f => f.t > endT && f.t < endT + 0.3);
    const hasContinuation = afterBurst.some(f =>
      f.label === LABEL.VOICED && f.vad > 0.6
    );
    if (!hasContinuation) {
      score += 2;
      reasons.push(`No stable continuation immediately after the burst pattern.`);
    }

    // Transcript alignment bonus (will be filled by fusion layer)
    if (frames.some(f => f.label === LABEL.PLOSIVE_BURST)) {
      score += 1;
      reasons.push(`Transcript timing may support a possible repetition.`);
    }

    const confidence = this._scoreToConfidence(score);
    if (confidence < 0.5) return; // discard low-confidence

    const diffSeconds = nowT - endT;
    reasons.push(`Confidence is ${confidence >= 0.8 ? "strong" : confidence >= 0.5 ? "moderate" : "low"} based on ${count} burst events.`);

    this._emitEvent({
      eventType: "repetition",
      startTime: startT,
      endTime: endT,
      durationMs: Math.round(gapMs),
      confidence,
      reason: reasons,
    }, nowT);
  }

  // ── 2. Prolongation detection ────────────────────────────────────

  /**
   * Detects sustained fricatives ("ssssssss") or sustained voicing ("aaaaaa").
   *
   * Rule: continuous FRICATIVE or VOICED frames lasting > 350ms.
   */
  private _detectProlongations(window: TimelineFrame[], nowT: number): void {
    if (window.length < 2) return;

    // Find continuous runs of FRICATIVE or VOICED
    let runStart = -1;
    let runLabel = -1;

    for (let i = 0; i < window.length; i++) {
      const f = window[i];
      const isProlongCandidate = f.label === LABEL.FRICATIVE || f.label === LABEL.VOICED;

      if (isProlongCandidate) {
        if (runStart < 0) {
          runStart = f.t;
          runLabel = f.label;
        } else if (f.label !== runLabel) {
          // Label changed within the run — end the run
          this._finalizeProlongation(window, runStart, window[i - 1].t, nowT);
          runStart = f.t;
          runLabel = f.label;
        }
      } else {
        if (runStart >= 0) {
          this._finalizeProlongation(window, runStart, window[i - 1].t, nowT);
          runStart = -1;
          runLabel = -1;
        }
      }
    }

    // Check run at end of window
    if (runStart >= 0 && window.length > 0) {
      this._finalizeProlongation(window, runStart, window[window.length - 1].t, nowT);
    }
  }

  private _finalizeProlongation(
    window: TimelineFrame[], startT: number, endT: number, nowT: number
  ): void {
    const durMs = (endT - startT) * 1000;
    if (durMs < PROLONG_MIN_MS) return;

    // Determine the type of prolongation
    const runFrames = window.filter(f => f.t >= startT && f.t <= endT);

    // Check if it's fricative-like (ssssss) or vowel-like (aaaa)
    const isFricative = runFrames.some(f => f.label === LABEL.FRICATIVE);
    const runLabelName = isFricative ? "fricative-like" : "vowel-like";

    // Scoring
    let score = 0;
    const reasons: string[] = [];

    // Long continuity
    if (isFricative) {
      score += 3;
      reasons.push(`A ${runLabelName} segment persisted for ${durMs.toFixed(0)}ms without lexical progress.`);
    } else {
      score += 3;
      reasons.push(`A ${runLabelName} segment persisted for ${durMs.toFixed(0)}ms without lexical progress.`);
    }

    // Check spectral stability (low variance in spectral features = stable sound)
    if (runFrames.length >= 3) {
      const zcrValues = runFrames.map(f => f.zcr);
      const mean = zcrValues.reduce((a, b) => a + b, 0) / zcrValues.length;
      const variance = zcrValues.reduce((s, v) => s + (v - mean) ** 2, 0) / zcrValues.length;
      const stability = Math.max(0, 1 - Math.sqrt(variance) / Math.max(0.01, mean));
      if (stability > 0.7) {
        score += 2;
        reasons.push(`Stable spectral profile maintained throughout the segment.`);
      }
    }

    // Check lexical progress (will be filled by fusion)
    score += 1;

    const confidence = this._scoreToConfidence(score);
    if (confidence < 0.5) return;

    reasons.push(`Confidence is ${confidence >= 0.8 ? "strong" : confidence >= 0.5 ? "moderate" : "low"} based on a ${durMs.toFixed(0)}ms sustained ${runLabelName} segment.`);

    this._emitEvent({
      eventType: "prolongation",
      startTime: startT,
      endTime: endT,
      durationMs: Math.round(durMs),
      confidence,
      reason: reasons,
    }, nowT);
  }

  // ── 3. Block detection ───────────────────────────────────────────

  /**
   * Detects silent blocks: TENSE_HOLD or SILENCE >300ms followed by PLOSIVE_BURST.
   *
   * "you can almost hear the start before the word" — TENSE_HOLD shows suppressed
   * low-frequency energy (20-80 Hz) that indicates the vocal tract is positioning
   * but no sound is coming out.
   */
  private _detectBlocks(window: TimelineFrame[], nowT: number): void {
    if (window.length < 2) return;

    // Find runs of SILENCE or TENSE_HOLD
    let runStart = -1;
    let isTense = false;

    for (let i = 0; i < window.length; i++) {
      const f = window[i];
      const isBlockCandidate = f.label === LABEL.SILENCE || f.label === LABEL.TENSE_HOLD;

      if (isBlockCandidate) {
        if (runStart < 0) {
          runStart = f.t;
          isTense = f.label === LABEL.TENSE_HOLD;
        }
        if (f.label === LABEL.TENSE_HOLD) isTense = true;
      } else {
        if (runStart >= 0) {
          // Silence ended — check length and burst
          const durMs = (f.t - runStart) * 1000;
          if (durMs >= BLOCK_MIN_SILENCE_MS) {
            // Check if immediately followed by a PLOSIVE_BURST (within 200ms)
            const after = this._frames.filter(
              fr => fr.t > f.t && fr.t < f.t + BLOCK_POST_BURST_WINDOW_MS / 1000
            );
            const hasBurst = after.some(fr => fr.label === LABEL.PLOSIVE_BURST);

            if (hasBurst || isTense) {
              // Scoring
              let score = 0;
              const reasons: string[] = [];

              if (isTense) {
                score += 4;
                reasons.push(`Blocked onset with suppressed voicing — ${durMs.toFixed(0)}ms of tension before release.`);
              } else {
                score += 3;
                reasons.push(`Silent block of ${durMs.toFixed(0)}ms followed by speech onset.`);
              }

              if (hasBurst) {
                score += 2;
                reasons.push(`A release burst was detected immediately after the silence.`);
              }

              if (isTense) {
                score += 2;
                reasons.push(`Low-frequency energy suggests the vocal tract was engaged during the block.`);
              }

              const confidence = this._scoreToConfidence(score);
              if (confidence >= 0.5) {
                reasons.push(`Confidence is ${confidence >= 0.8 ? "strong" : confidence >= 0.5 ? "moderate" : "low"} based on ${durMs.toFixed(0)}ms of ${isTense ? "tension" : "silence"} followed by release.`);

                this._emitEvent({
                  eventType: isTense ? "tense_block" : "block",
                  startTime: runStart,
                  endTime: f.t,
                  durationMs: Math.round(durMs),
                  confidence,
                  reason: reasons,
                }, nowT);
              }
            }
          }
          runStart = -1;
          isTense = false;
        }
      }
    }

    // Don't flag open-ended runs at the end of the window
  }

  // ── 4. Hesitation sequence detection ─────────────────────────────

  /**
   * Detects clusters of multiple speech fragments separated by short pauses.
   *
   * Rule: ≥3 fragments in a 2.5s window, each separated by gaps <= 1s,
   * total span >= 500ms.
   */
  private _detectHesitationSequences(window: TimelineFrame[], nowT: number): void {
    if (window.length < 5) return;

    // Find speech fragments (runs of non-SILENCE, non-TENSE_HOLD frames)
    const fragments: { startT: number; endT: number }[] = [];
    let fragStart = -1;

    for (let i = 0; i < window.length; i++) {
      const f = window[i];
      const isSpeech = f.label !== LABEL.SILENCE && f.label !== LABEL.TENSE_HOLD;

      if (isSpeech) {
        if (fragStart < 0) fragStart = f.t;
      } else {
        if (fragStart >= 0) {
          fragments.push({ startT: fragStart, endT: window[i - 1].t });
          fragStart = -1;
        }
      }
    }
    if (fragStart >= 0) {
      fragments.push({ startT: fragStart, endT: window[window.length - 1].t });
    }

    if (fragments.length < HESIT_MIN_FRAGMENTS) return;

    // Check if fragments form a hesitation cluster
    const spanMs = (fragments[fragments.length - 1].endT - fragments[0].startT) * 1000;
    if (spanMs < 500) return;

    // Check that gaps between fragments aren't too large
    let maxGapMs = 0;
    for (let i = 1; i < fragments.length; i++) {
      const gapMs = (fragments[i].startT - fragments[i - 1].endT) * 1000;
      maxGapMs = Math.max(maxGapMs, gapMs);
    }

    const clusterWindowMs = (fragments[fragments.length - 1].endT - fragments[0].startT) * 1000;
    if (clusterWindowMs > HESIT_CLUSTER_WINDOW_MS) return;
    if (maxGapMs > HESIT_FRAGMENT_MAX_GAP_MS) return;

    // Scoring
    let score = 0;
    const reasons: string[] = [];

    score += Math.min(6, fragments.length * 2);
    reasons.push(`${fragments.length} speech fragments detected within a ${clusterWindowMs.toFixed(0)}ms window.`);

    if (maxGapMs > 400) {
      score += 2;
      reasons.push(`Irregular gap pattern — fragments separated by gaps up to ${maxGapMs.toFixed(0)}ms.`);
    }

    // Check for no stable continuation
    const lastFragEnd = fragments[fragments.length - 1].endT;
    const afterLast = this._frames.filter(f => f.t > lastFragEnd && f.t < lastFragEnd + 0.3);
    const hasContinuation = afterLast.some(f => f.label === LABEL.VOICED && f.vad > 0.6);
    if (!hasContinuation) {
      score += 2;
      reasons.push(`No stable continuation after the hesitation sequence.`);
    }

    const confidence = this._scoreToConfidence(score);
    if (confidence < 0.5) return;

    reasons.push(`Confidence is ${confidence >= 0.8 ? "strong" : confidence >= 0.5 ? "moderate" : "low"} based on ${fragments.length} fragments in a hesitation cluster.`);

    this._emitEvent({
      eventType: "hesitation_sequence",
      startTime: fragments[0].startT,
      endTime: fragments[fragments.length - 1].endT,
      durationMs: Math.round(clusterWindowMs),
      confidence,
      reason: reasons,
    }, nowT);
  }

  // ── 5. False start detection ─────────────────────────────────────

  /**
   * A speech attempt that starts and stops within <500ms, followed by a
   * restart attempt within 1s.
   */
  private _detectFalseStarts(window: TimelineFrame[], nowT: number): void {
    if (window.length < 3) return;

    // Find short speech bursts (non-silence runs <500ms)
    let burstStart = -1;
    let burstEnd = -1;

    for (let i = 0; i < window.length; i++) {
      const f = window[i];
      const isSpeech = f.label !== LABEL.SILENCE && f.label !== LABEL.TENSE_HOLD;

      if (isSpeech && burstStart < 0) {
        burstStart = f.t;
      } else if (!isSpeech && burstStart >= 0) {
        burstEnd = window[i - 1].t;
        const durMs = (burstEnd - burstStart) * 1000;

        if (durMs < FALSE_START_MAX_MS) {
          // Check if followed by a restart within 1s
          const afterBurst = this._frames.filter(
            fr => fr.t > burstEnd && fr.t < burstEnd + FALSE_START_RESTART_WINDOW_MS / 1000
          );
          const hasRestart = afterBurst.some(fr =>
            fr.label !== LABEL.SILENCE && fr.label !== LABEL.TENSE_HOLD
          );

          if (hasRestart) {
            let score = 2;
            const reasons: string[] = [
              `Possible false start — speech attempt lasted ${durMs.toFixed(0)}ms before stopping.`,
              `A restart attempt was detected within 1 second.`,
            ];

            const confidence = this._scoreToConfidence(score);
            if (confidence >= 0.5) {
              reasons.push(`Confidence is low because acoustic evidence is a single short burst.`);

              this._emitEvent({
                eventType: "possible_false_start",
                startTime: burstStart,
                endTime: burstEnd,
                durationMs: Math.round(durMs),
                confidence: Math.min(0.6, confidence),
                reason: reasons,
              }, nowT);
            }
          }
        }

        burstStart = -1;
      }
    }
  }

  // ── Scoring utilities ────────────────────────────────────────────

  /**
   * Convert an evidence score (0–15+) to a confidence value (0–1).
   *
   * Score → confidence mapping:
   *   0–3  → 0.0–0.3   (discard)
   *   4–6  → 0.3–0.49  (possible, low)
   *   7–9  → 0.5–0.79  (probable, medium)
   *  10–12 → 0.8–0.89  (strong)
   *  13+   → 0.9–1.0   (high)
   */
  private _scoreToConfidence(score: number): number {
    if (score <= 3) return Math.min(0.3, score * 0.1);
    if (score <= 6) return 0.3 + (score - 3) * (0.19 / 3);
    if (score <= 9) return 0.5 + (score - 6) * (0.29 / 3);
    if (score <= 12) return 0.8 + (score - 9) * (0.09 / 3);
    return Math.min(1, 0.9 + (score - 12) * 0.025);
  }

  // ── Event emission ───────────────────────────────────────────────

  private _emitEvent(event: StutterCandidate, nowT: number): void {
    // De-dupe: no same-type event within DEDUPE_WINDOW_MS
    const lastEmit = this._lastEmit[event.eventType] || 0;
    if (event.startTime - lastEmit < DEDUPE_WINDOW_MS / 1000) return;

    this._lastEmit[event.eventType] = event.startTime;

    this._events.push(event);
    this._notifyListeners();
  }

  private _notifyListeners(): void {
    const events = this.getEvents();
    for (const fn of this._listeners) {
      fn(events);
    }
  }
}

// ─── Convenience: create a fresh engine ─────────────────────────────

export function createTimelineEngine(): TimelineEngine {
  return new TimelineEngine();
}