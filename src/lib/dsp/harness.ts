/**
 * BOLO — Deterministic DSP Test Harness
 *
 * Feeds recorded/synthetic PCM into the EXACT SAME detector the microphone
 * uses (DspEngine) and reports measured values — NOT a compile/build check.
 * A successful Vite build only proves the interface loads; this harness is
 * the proof the acoustic detector works.
 *
 * For every fixture it reports: candidate count, confirmed event count,
 * event type, confidence, start/end timestamps, and the key measured
 * features behind each decision (onset gaps, unit similarity, centroid
 * variance, spectral flux, drop/release ratios…). Thresholds are tuned from
 * these measurements, never blindly.
 */

import { DspEngine } from "./engine";
import { defaultTuning } from "./constants";
import { FIXTURES } from "./fixtures";
import { SAMPLE_RATE } from "./features";
import type { DspDiagnostic, DspEvent } from "./types";

export interface HarnessRow {
  name: string;
  expect: "confirmed" | "rejected";
  candidateCount: number;
  confirmedCount: number;
  events: DspEvent[];
  verdicts: DspDiagnostic[];
  /** The measured values that decided the outcome (for threshold tuning). */
  detail: string[];
}

/** Feed PCM in the same ~256ms chunks the AudioWorklet emits. */
function feedEngine(engine: DspEngine, pcm: Float32Array, t0Ms: number): void {
  const CHUNK = 4096;
  for (let i = 0; i < pcm.length; i += CHUNK) {
    const chunk = pcm.subarray(i, Math.min(i + CHUNK, pcm.length));
    engine.pushPcm(chunk, t0Ms + i * (1000 / SAMPLE_RATE));
  }
  engine.finish();
}

export function runFixture(name: string): HarnessRow {
  const fixture = FIXTURES.find((f) => f.name === name);
  if (!fixture) throw new Error(`Unknown fixture: ${name}`);
  return runFixtureDef(fixture);
}

export function runFixtureDef(fixture: (typeof FIXTURES)[number]): HarnessRow {
  const engine = new DspEngine(defaultTuning(), () => {});
  const pcm = fixture.make();
  feedEngine(engine, pcm, 1000); // start at t=1000ms to prove absolute times work

  const detail: string[] = engine.diagnostics.map((d) => d.logLine);

  return {
    name: fixture.name,
    expect: fixture.expect,
    candidateCount: engine.diagnostics.length,
    confirmedCount: engine.events.length,
    events: engine.events.map((e) => ({ ...e })),
    verdicts: engine.diagnostics.map((d) => ({ ...d })),
    detail,
  };
}

export function runAll(): HarnessRow[] {
  return FIXTURES.map((f) => runFixtureDef(f));
}

/** Format a harness run as a fixed-width text table (console / panel). */
export function formatTable(rows: HarnessRow[]): string {
  const lines: string[] = [];
  lines.push(
    "Test                    | Cand | Conf | Type          | Confid | Start→End (ms)          | Outcome"
  );
  lines.push("-".repeat(120));
  for (const r of rows) {
    if (r.confirmedCount === 0) {
      lines.push(
        `${r.name.padEnd(23)} | ${String(r.candidateCount).padStart(4)} | ${String(r.confirmedCount).padStart(4)} | ${"".padEnd(13)} | ${"".padStart(6)} | ${"".padStart(22)} | ${r.expect === "rejected" ? "OK (rejected)" : "FAIL — expected confirmed"}`
      );
      continue;
    }
    for (const e of r.events) {
      lines.push(
        `${r.name.padEnd(23)} | ${String(r.candidateCount).padStart(4)} | ${String(r.confirmedCount).padStart(4)} | ${e.type.padEnd(13)} | ${e.confidence.toFixed(2).padStart(6)} | ${String(e.startTimeMs).padStart(8)}→${String(e.endTimeMs).padEnd(10)} | ${r.expect === "confirmed" ? "OK (confirmed)" : "FAIL — expected rejected"}`
      );
    }
    if (r.events.length === 0) {
      lines.push(
        `${r.name.padEnd(23)} | ${String(r.candidateCount).padStart(4)} | ${String(r.confirmedCount).padStart(4)} | ${"".padEnd(13)} | ${"".padStart(6)} | ${"".padStart(22)} | ${r.expect === "rejected" ? "OK (rejected)" : "FAIL — expected confirmed"}`
      );
    }
  }
  return lines.join("\n");
}

/** Compact measured-feature digest per candidate (for the debug panel). */
export function digestDiagnostic(d: DspDiagnostic): string {
  const f = d.features;
  const parts: string[] = [];
  parts.push(`${d.candidateType.replace("possible_", "")} @${d.startTimeMs}–${d.endTimeMs}ms (${f.durationMs}ms)`);
  parts.push(`score=${d.score.toFixed(2)}`);
  if (f.onsetGapsMs.length > 0) parts.push(`gaps=${f.onsetGapsMs.join("/")}ms`);
  if (f.unitSimilarity > 0) parts.push(`sim=${f.unitSimilarity.toFixed(2)}`);
  if (f.onsetStrengthRatio > 0) parts.push(`strength=${f.onsetStrengthRatio.toFixed(1)}x`);
  if (f.centroidMean > 0) parts.push(`cent=${Math.round(f.centroidMean)}Hz var=${f.centroidVariance.toFixed(0)}`);
  if (f.spectralFluxMean > 0) parts.push(`flux=${f.spectralFluxMean.toFixed(3)}`);
  if (f.meanZcr > 0) parts.push(`zcr=${f.meanZcr.toFixed(2)}`);
  if (f.dropRatio > 0) parts.push(`drop=${(f.dropRatio * 100).toFixed(0)}%`);
  if (f.releaseRatio > 0) parts.push(`release=${f.releaseRatio.toFixed(1)}x`);
  if (f.rmsAboveNoise > 0) parts.push(`rmsAboveNoise=${f.rmsAboveNoise.toFixed(1)}x`);
  return parts.join(" · ");
}
