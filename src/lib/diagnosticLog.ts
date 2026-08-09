/**
 * BOLO — TEMPORARY diagnostic instrumentation (observation only, ZERO behavior change)
 *
 * Purpose: let ONE real mic recording show the exact stage and condition
 * where each acoustic phenomenon lives or dies:
 *
 *   1. voiced repetitions ("w-w-what", "woh-woh") that are never detected
 *   2. "ssss…" over-detected as stammer
 *   3. quiet gaps over-detected as blocks
 *
 * This module ONLY logs. It never touches thresholds, emission floors,
 * similarity weights, fusion rules, pause detection, the AudioWorklet or
 * TimelineEngine. Every call site is a `diag(...)` that reads values the
 * surrounding code already computed — nothing is changed.
 *
 * Toggle:
 *   • default ON (so a single recording shows the full trace)
 *   • `?diag=1` in the URL forces it ON
 *   • `window.__BOLO_DIAG = false` silences it
 *
 * DELETE this file and every `[BOLO·diag]` call site after the debugging
 * session. The `[BOLO·fusion]` and `[BOLO·event]` logs are permanent.
 */
declare global {
  interface Window {
    __BOLO_DIAG?: boolean;
  }
}

export const DIAG_ENABLED =
  typeof window !== "undefined" &&
  (window.location.search.includes("diag=1") || window.__BOLO_DIAG !== false);

/** Print a single `[BOLO·diag]` line with structured detail. */
export function diag(stage: string, detail: Record<string, unknown>): void {
  if (!DIAG_ENABLED) return;
  // eslint-disable-next-line no-console
  console.info(`[BOLO·diag] ${stage}`, detail);
}

/** Print a session banner (start / end / digest). */
export function diagBanner(
  title: string,
  detail?: Record<string, unknown>
): void {
  if (!DIAG_ENABLED) return;
  // eslint-disable-next-line no-console
  console.info(
    `%c[BOLO·diag] ▸ ${title}`,
    "color:#BD8CFF;font-weight:bold",
    detail ?? {}
  );
}

/** Format a 0..1 number as a percentage with `dp` decimals (compact logs). */
export function pct(x: number | undefined, dp = 1): string {
  if (x === undefined || Number.isNaN(x)) return "—";
  return `${(x * 100).toFixed(dp)}%`;
}
