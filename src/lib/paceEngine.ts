/**
 * BOLO — Shared Pace Engine
 *
 * One engine for ALL modes (Script, Free Speech, Debate).
 * Measures pace from finalized Speechmatics words + pause events.
 * Never uses partials. Never counts punctuation as words.
 * Startup guard prevents fake-fast WPM in the first ~1.5s.
 */

import type { FinalWordLike } from "./pauseDetector";
import type { PauseEvent } from "./pauseDetector";

// ─── Public Types ────────────────────────────────────────────────────

export type PaceState = "slow" | "ideal" | "fast" | "unstable";
export type PaceTrend = "slowing_down" | "stable" | "speeding_up";

export interface PaceSnapshot {
  timestamp: number;
  currentWpm: number;
  rollingWpm: number;
  idealBand: [number, number];
  paceState: PaceState;
  trend: PaceTrend;
  pauseImpact: number;
  clarityScore: number;
  speechTimeMs: number;
  wordsInWindow: number;
}

export interface PaceTimelineEntry {
  timestamp: number;
  snapshot: PaceSnapshot;
}

export interface PaceReport {
  /** Final snapshot over the entire session */
  finalSnapshot: PaceSnapshot;
  /** Full timeline of snapshots */
  timeline: PaceTimelineEntry[];
  /** Total WPM over entire session */
  totalWpm: number;
  /** Overall trend */
  trend: PaceTrend;
  /** Average clarity across all snapshots */
  averageClarity: number;
  /** Pause summary across entire session */
  pauseSummary: {
    totalAwkward: number;
    totalSevere: number;
    totalHesitationSequences: number;
    totalPauseMs: number;
    longestHesitationMs: number;
    awkwardPauseCount: number;
  };
  /** Clarity score (0-100) from entire session */
  clarityScore: number;
  /** Pace consistency (0-100) */
  pacingConsistency: number;
  /** Human labels */
  labels: {
    pace: string;
    pause: string;
    trend: string;
  };
  /** Short human explanation */
  explanation: string;
}

// ─── Constants ───────────────────────────────────────────────────────

export const IDEAL_BAND: [number, number] = [120, 160];
const WINDOW_MS = 5000;
const SHORT_WINDOW_MS = 2000;
const UPDATE_MS = 500;
const MIN_WORDS = 3;
const MIN_SPEECH_MS = 1500;
const BASELINE_WPM = 140;
const TREND_THRESHOLD = 8;

// ─── Helpers ─────────────────────────────────────────────────────────

/** Strip punctuation per spec — only count tokens with clean length > 0 */
export function cleanWordToken(content: string): string {
  return content.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "").trim();
}

/** Extract finalised words from transcript chunks for the engine */
export function collectFinalWords(
  chunks: { isFinal: boolean; words: { word: string; startTime: number; endTime: number; confidence?: number; text?: string; utterance?: number }[]; utterance?: number }[]
): FinalWordLike[] {
  const result: FinalWordLike[] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    if (!c.isFinal) continue;
    for (const w of c.words) {
      const text = (w as any).text || w.word || "";
      if (!text) continue;
      const key = `${w.startTime}-${w.endTime}-${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        word: text,
        text,
        startTime: w.startTime,
        endTime: w.endTime,
        utterance: c.utterance,
        confidence: w.confidence ?? 0.9,
      });
    }
  }
  return result;
}

/** Safely multiply by 60 — treat 0 seconds as 1 to avoid Infinity */
function safeWpm(wordCount: number, seconds: number): number {
  const s = Math.max(0.001, seconds);
  return Math.round((wordCount / s) * 60);
}

// ─── Baseline snapshot (startup guard output) ────────────────────────

export function baselineSnapshot(now = performance.now()): PaceSnapshot {
  return {
    timestamp: now,
    currentWpm: 140,
    rollingWpm: BASELINE_WPM,
    idealBand: IDEAL_BAND,
    paceState: "ideal",
    trend: "stable",
    pauseImpact: 0,
    clarityScore: 85,
    speechTimeMs: 0,
    wordsInWindow: 0,
  };
}

// ─── Pace Engine ─────────────────────────────────────────────────────

export class PaceEngine {
  private words: FinalWordLike[] = [];
  private pauses: PauseEvent[] = [];
  private listeners = new Set<(snap: PaceSnapshot) => void>();
  private lastSnapshot: PaceSnapshot = baselineSnapshot();
  private timeline: PaceTimelineEntry[] = [];
  private lastEmit = 0;
  private prevRolling: number | null = null;

  // ── Feed ────────────────────────────────────────────────────────

  setFinalizedWords(words: FinalWordLike[]): void {
    this.words = words;
    this.maybeEmit();
  }

  /** Feed incremental pause events (from pauseDetector) */
  setPauseEvents(pauses: PauseEvent[]): void {
    this.pauses = pauses;
    this.maybeEmit();
  }

  /** Bulk feed (words + pauses) — cheaper than two calls */
  feed(words: FinalWordLike[], pauses: PauseEvent[]): void {
    this.words = words;
    this.pauses = pauses;
    this.maybeEmit();
  }

  // ── Read ─────────────────────────────────────────────────────────

  getSnapshot(): PaceSnapshot {
    return this.lastSnapshot;
  }

  getTimeline(): PaceTimelineEntry[] {
    return this.timeline;
  }

  subscribe(fn: (snap: PaceSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── Final analysis (after recording stops) ───────────────────────

  finalize(): PaceReport {
    // Force a final computation
    const finalSnap = this.computeSnapshot(performance.now(), true);

    const totalWords = this.words.filter((w) => cleanWordToken(w.word || w.text || "").length > 0);
    const totalSpan =
      totalWords.length > 1
        ? totalWords[totalWords.length - 1].endTime - totalWords[0].startTime
        : 0;

    // Pause stats
    const awkward = this.pauses.filter((p) => p.type === "awkward");
    const severe = this.pauses.filter((p) => p.type === "severe");
    const hesitationSeqs = this.pauses.filter((p) => p.type === "hesitation_sequence");
    const allScoreable = this.pauses.filter((p) => p.type !== "natural");
    const totalPauseMs = allScoreable.reduce((s, p) => s + p.durationMs, 0);
    const longestHesitationMs =
      allScoreable.length > 0 ? Math.max(...allScoreable.map((p) => p.durationMs)) : 0;

    // Total WPM over entire session
    const totalClean = totalWords.length;
    const totalPauseSec = totalPauseMs / 1000;
    const activeSec = Math.max(0.001, totalSpan - totalPauseSec);
    const totalWpm = safeWpm(totalClean, activeSec);

    // Average clarity from timeline
    const avgClarity =
      this.timeline.length > 0
        ? Math.round(this.timeline.reduce((s, e) => s + e.snapshot.clarityScore, 0) / this.timeline.length)
        : finalSnap.clarityScore;

    // Consistency = inverse of (rollingWpm std dev / mean)
    let consistency = 85;
    if (this.timeline.length > 2) {
      const wpmValues = this.timeline.map((e) => e.snapshot.rollingWpm);
      const mean = wpmValues.reduce((a, b) => a + b, 0) / wpmValues.length;
      const variance =
        wpmValues.reduce((s, v) => s + (v - mean) ** 2, 0) / wpmValues.length;
      const stdDev = Math.sqrt(variance);
      const cv = mean > 0 ? stdDev / mean : 0;
      consistency = Math.max(0, Math.min(100, Math.round(100 - cv * 100)));
    }

    // Clarity score
    const pausePenalty = Math.min(30, awkward.length * 4 + severe.length * 6 + hesitationSeqs.length * 8);
    const pacePenalty = Math.min(30, Math.abs(finalSnap.rollingWpm - 140) * 0.3);
    const clarityScore = Math.max(0, Math.min(100, 100 - pausePenalty - pacePenalty + (100 - finalSnap.clarityScore) * 0.1));

    // Labels
    const paceLabel =
      totalWpm < 120
        ? `Slightly slow — ${totalWpm} WPM`
        : totalWpm > 160
          ? `Fast — ${totalWpm} WPM`
          : `Ideal — ${totalWpm} WPM`;

    const pauseLabel =
      awkward.length + hesitationSeqs.length === 0
        ? "Clean — no awkward pauses"
        : `Needs work — ${awkward.length + hesitationSeqs.length} awkward pauses`;

    const trendLabel =
      finalSnap.trend === "speeding_up"
        ? "Increasing pace"
        : finalSnap.trend === "slowing_down"
          ? "Slowing trend"
          : "Steady pace";

    // Human explanation
    const explanation = buildExplanation(totalWpm, awkward.length, severe.length, hesitationSeqs.length, consistency);

    return {
      finalSnapshot: finalSnap,
      timeline: [...this.timeline],
      totalWpm,
      trend: finalSnap.trend,
      averageClarity: avgClarity,
      pauseSummary: {
        totalAwkward: awkward.length,
        totalSevere: severe.length,
        totalHesitationSequences: hesitationSeqs.length,
        totalPauseMs,
        longestHesitationMs,
        awkwardPauseCount: awkward.length + severe.length + hesitationSeqs.length,
      },
      clarityScore,
      pacingConsistency: consistency,
      labels: { pace: paceLabel, pause: pauseLabel, trend: trendLabel },
      explanation,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────

  private maybeEmit(): void {
    const now = performance.now();
    if (now - this.lastEmit < UPDATE_MS) return;
    this.lastEmit = now;
    const snap = this.computeSnapshot(now);
    this.lastSnapshot = snap;
    this.timeline.push({ timestamp: now, snapshot: snap });
    // Keep max 500 timeline entries (250s at 500ms cadence)
    if (this.timeline.length > 500) this.timeline = this.timeline.slice(-300);
    for (const fn of this.listeners) fn(snap);
  }

  private computeSnapshot(now = performance.now(), force = false): PaceSnapshot {
    const words = this.words;
    if (words.length === 0) return baselineSnapshot(now);

    // Find the rolling window bounds (5s back from latest word endTime)
    const latestEnd = words[words.length - 1].endTime;
    const windowStart = Math.max(0, latestEnd - WINDOW_MS / 1000);

    // Words in the 5s rolling window
    const windowWords = words.filter((w) => w.startTime >= windowStart && w.startTime <= latestEnd);
    const cleanInWindow = windowWords.filter((w) => cleanWordToken(w.word || w.text || "").length > 0);

    // Startup guard
    const windowActiveSec = latestEnd - (cleanInWindow.length > 0 ? cleanInWindow[0].startTime : latestEnd - 0.1);
    if (!force && (cleanInWindow.length < MIN_WORDS || windowActiveSec < MIN_SPEECH_MS / 1000)) {
      return baselineSnapshot(now);
    }

    // Short sub-window (~2s) for current pace
    const shortStart = Math.max(0, latestEnd - SHORT_WINDOW_MS / 1000);
    const shortWords = cleanInWindow.filter((w) => w.startTime >= shortStart);

    // Pause time within window
    const pauseTimeInWindow = this.pauseTimeBetween(
      windowStart,
      latestEnd
    );
    const shortPauseTime = this.pauseTimeBetween(shortStart, latestEnd);

    // Active speaking time (exclude pauses)
    const activeSeconds = Math.max(0.001, (latestEnd - (cleanInWindow.length > 0 ? cleanInWindow[0].startTime : 0)) - pauseTimeInWindow);
    const shortActive = Math.max(0.001, (latestEnd - (shortWords.length > 0 ? shortWords[0].startTime : 0)) - shortPauseTime);

    // Clean word counts
    const wordCount = cleanInWindow.length;
    const shortWordCount = shortWords.length;

    // WPM
    const rollingWpm = safeWpm(wordCount, activeSeconds);
    const currentWpm = safeWpm(shortWordCount, shortActive);

    // Trend
    let trend: PaceTrend = "stable";
    if (this.prevRolling !== null) {
      const diff = rollingWpm - this.prevRolling;
      if (diff > TREND_THRESHOLD) trend = "speeding_up";
      else if (diff < -TREND_THRESHOLD) trend = "slowing_down";
    }
    this.prevRolling = rollingWpm;

    // Pace state
    const paceState = classifyPace(rollingWpm, cleanInWindow, this.pauses);

    // Pause impact (0-1): fraction of awkward/severe pauses in window relative to total words
    const windowPauses = this.pauses.filter(
      (p) => p.startTime >= windowStart && p.endTime <= latestEnd
    );
    const awkwardInWindow = windowPauses.filter(
      (p) => p.type === "awkward" || p.type === "severe" || p.type === "hesitation_sequence"
    );
    const pauseImpact = wordCount > 0
      ? Math.min(1, (awkwardInWindow.length * 0.2) / Math.max(1, wordCount * 0.05))
      : 0;

    // Clarity score (0-100)
    const clarityScore = this.computeClarity(rollingWpm, currentWpm, pauseImpact, wordCount, cleanInWindow);

    return {
      timestamp: now,
      currentWpm,
      rollingWpm,
      idealBand: IDEAL_BAND,
      paceState,
      trend,
      pauseImpact: Math.round(pauseImpact * 100),
      clarityScore,
      speechTimeMs: Math.round(activeSeconds * 1000),
      wordsInWindow: wordCount,
    };
  }

  /** Sum of pause durations (in seconds) that fall within [startSec, endSec] */
  private pauseTimeBetween(startSec: number, endSec: number): number {
    let total = 0;
    for (const p of this.pauses) {
      // Pause overlaps with [startSec, endSec]
      if (p.startTime <= endSec && p.endTime >= startSec) {
        const overlapStart = Math.max(startSec, p.startTime);
        const overlapEnd = Math.min(endSec, p.endTime);
        total += overlapEnd - overlapStart;
      }
    }
    return total;
  }

  private computeClarity(
    rollingWpm: number,
    currentWpm: number,
    pauseImpact: number,
    wordCount: number,
    windowWords: FinalWordLike[]
  ): number {
    // Pace stability: distance from 140 WPM
    const paceStability = Math.max(0, 100 - Math.abs(rollingWpm - 140) * 0.4);

    // Rhythm consistency: variance of inter-word gaps
    let rhythmScore = 85;
    if (windowWords.length > 2) {
      const gaps: number[] = [];
      for (let i = 1; i < windowWords.length; i++) {
        const gap = windowWords[i].startTime - windowWords[i - 1].endTime;
        if (gap > 0 && gap < 2) gaps.push(gap);
      }
      if (gaps.length > 2) {
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const variance = gaps.reduce((s, v) => s + (v - mean) ** 2, 0) / gaps.length;
        const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
        rhythmScore = Math.max(0, 100 - cv * 80);
      }
    }

    // WPM swing: if current and rolling are very different, clarity drops
    const swingPenalty = Math.min(20, Math.abs(currentWpm - rollingWpm) * 0.5);

    // Compose
    const raw =
      paceStability * 0.4 +
      (100 - pauseImpact * 100) * 0.3 +
      rhythmScore * 0.2 -
      swingPenalty * 0.1;
    return Math.max(0, Math.min(100, Math.round(raw)));
  }
}

// ─── Pace state classifier ──────────────────────────────────────────

function classifyPace(
  rollingWpm: number,
  windowWords: FinalWordLike[],
  pauses: PauseEvent[]
): PaceState {
  // Unstable if high gap variance or many awkward pauses
  if (windowWords.length > 3) {
    const gaps: number[] = [];
    for (let i = 1; i < windowWords.length; i++) {
      gaps.push(windowWords[i].startTime - windowWords[i - 1].endTime);
    }
    const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const maxGap = Math.max(...gaps);
    const awkwardNearby = pauses.filter(
      (p) => p.type === "awkward" || p.type === "severe" || p.type === "hesitation_sequence"
    ).length;

    if (meanGap > 0 && maxGap / meanGap > 5 && awkwardNearby > 0) {
      return "unstable";
    }
    if (awkwardNearby >= 2 && windowWords.length < 10) {
      return "unstable";
    }
  }

  if (rollingWpm < 120) return "slow";
  if (rollingWpm > 160) return "fast";
  return "ideal";
}

// ─── Build human explanation ────────────────────────────────────────

function buildExplanation(
  totalWpm: number,
  awkwardCount: number,
  severeCount: number,
  hesitSeqCount: number,
  consistency: number
): string {
  const parts: string[] = [];

  if (totalWpm >= 120 && totalWpm <= 160) {
    parts.push(`Great overall pace at ${totalWpm} WPM — right in the ideal band.`);
  } else if (totalWpm < 120) {
    parts.push(`Your overall pace was ${totalWpm} WPM, a bit below the 120-160 target. Try speaking slightly faster.`);
  } else {
    parts.push(`Your overall pace was ${totalWpm} WPM, above the 120-160 target. Try slowing down slightly.`);
  }

  const totalIssues = awkwardCount + severeCount + hesitSeqCount;
  if (totalIssues === 0) {
    parts.push("No significant pauses or hesitations detected.");
  } else if (totalIssues <= 2) {
    parts.push(`A few minor pauses (${totalIssues}) — generally smooth delivery.`);
  } else {
    parts.push(`Notable pauses detected (${totalIssues}) — consider practicing smoother transitions.`);
  }

  if (consistency >= 80) {
    parts.push("Your pacing was very consistent throughout.");
  } else if (consistency >= 60) {
    parts.push("Your pacing varied somewhat — try to maintain a steady rhythm.");
  } else {
    parts.push("Your pacing fluctuated significantly — focus on a consistent speaking rate.");
  }

  return parts.join(" ");
}