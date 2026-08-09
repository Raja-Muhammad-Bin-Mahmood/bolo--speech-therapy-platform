/**
 * BOLO — The ONE shared session-relative audio clock
 *
 * Every value in the app that describes WHEN something happened in the
 * audio stream lives on this single timeline. There is no second clock:
 *
 *   • worklet frame timestamps            (the DSP lane / PCM tap)
 *   • acoustic candidate start/end times  (BOTH detectors)
 *   • Speechmatics word timestamps        (relative to the stream the
 *                                          server consumed — the same PCM
 *                                          stream the worklet drives)
 *   • local fallback clip extraction      (ring-buffer slicing)
 *   • merge / feed / transcript anchoring (all consumers)
 *
 * Wall clock, UI render time, microphone real time and speech-recognition
 * arrival time are NEVER used to position an event. The only wall-clock
 * usage here is INTERNAL scheduling (hold deadlines, age sweeps) which
 * never leaks into an event timestamp.
 *
 * ── Origin ────────────────────────────────────────────────────────────
 * Session t=0 is pinned when Speechmatics is ready — the first worklet
 * PCM message after the page signals readiness (the same "ASR-ready pin"
 * the codebase always used). Speechmatics word times share this origin
 * because the server numbers them from the start of the stream it
 * receives.
 *
 * ── Pre-pin phase ────────────────────────────────────────────────────
 * Before the pin the clock runs PROVISIONALLY on the wall clock from the
 * recording start, so the detectors can timestamp frames immediately.
 * The moment the pin lands, ONE deterministic shift is applied:
 *
 *     sessionTime = provisionalTime − shift
 *
 * where `shift` is the provisional time at the pin instant. Every event
 * already emitted (or emitted later from a provisional internal clock)
 * is mapped with the SAME shift — a single, origin-level rebase, never a
 * per-layer recompute. Pre-pin events correctly land at negative session
 * times (they happened before the ASR stream began) and attach to early
 * words as pre-onset evidence when genuinely flush with them.
 *
 * Worklet ↔ session mapping (used by the fallback ring slicer):
 *     sessionTime = workletTime − workletT0     (workletT0 = pinned origin)
 *     workletTime = sessionTime + workletT0
 */
import { diag } from "./diagnosticLog";

type ClockPhase = "idle" | "provisional" | "pinned";

let phase: ClockPhase = "idle";
/** Wall-clock origin of the provisional phase (recording start). */
let provisionalWall0: number | null = null;
/** Latest (workletT, performance.now()) anchor for smooth extrapolation. */
let anchorRef: { workletT: number; wallNow: number } | null = null;
/** Worklet time at session t=0 (set when the ASR pin lands). */
let workletT0: number | null = null;
/** Provisional time at the pin instant — the single session rebase. */
let shift = 0;
/** Set by requestPin(); the next worklet anchor pins the clock. */
let pinPending = false;

/** Pin listeners — detectors rebase their already-emitted events exactly
 *  once when the origin lands (see useAcousticAnalysis / useAnalyserSensor). */
const pinListeners = new Set<() => void>();

// ─── Session lifecycle ─────────────────────────────────────────────────

/**
 * Begin a new session: reset the clock and start the provisional phase.
 * Idempotent — only acts when the clock is idle (a previous session was
 * stopped via reset()).
 */
export function start(): void {
  if (phase !== "idle") return;
  phase = "provisional";
  provisionalWall0 = performance.now();
  anchorRef = null;
  workletT0 = null;
  shift = 0;
  pinPending = false;
}

/** End the session: return to idle (next start() begins fresh). */
export function reset(): void {
  phase = "idle";
  provisionalWall0 = null;
  anchorRef = null;
  workletT0 = null;
  shift = 0;
  pinPending = false;
}

// ─── Worklet feeding (called on EVERY worklet message) ─────────────────

/** Feed the latest (workletT, wallNow) anchor from the DSP lane. */
export function anchor(workletT: number): void {
  if (phase === "idle") return;
  anchorRef = { workletT, wallNow: performance.now() };
}

/** Signal readiness (Speechmatics connected): the NEXT worklet message
 *  pins session t=0 — the worklet moment of the first PCM after ready. */
export function requestPin(): void {
  if (phase !== "provisional") return;
  pinPending = true;
}

/** True when requestPin() has been called and the pin hasn't landed yet. */
export function isPinPending(): boolean {
  return pinPending;
}

/** Lock the origin from the most recent anchor (called on the first PCM
 *  message after requestPin()). Applies the single session shift. */
export function pin(): void {
  if (phase !== "provisional" || !anchorRef) return;
  workletT0 = anchorRef.workletT;
  shift = provisionalWall0 != null ? (performance.now() - provisionalWall0) / 1000 : 0;
  phase = "pinned";
  pinPending = false;
  diag("clock", {
    stage: "pinned",
    workletT0: +workletT0.toFixed(3),
    shift: +shift.toFixed(3),
    phase,
  });
  // Notify subscribers (detectors rebase their pre-pin events once).
  for (const cb of pinListeners) {
    try {
      cb();
    } catch {
      // a listener must never break the pin
    }
  }
  pinListeners.clear();
}

/** Subscribe to the pin event. Fires immediately when already pinned. */
export function onPin(cb: () => void): () => void {
  if (phase === "pinned") {
    cb();
    return () => {};
  }
  pinListeners.add(cb);
  return () => pinListeners.delete(cb);
}

// ─── Reading the clock ─────────────────────────────────────────────────

/** Current session time (seconds), or null before the session starts. */
export function now(): number | null {
  if (phase === "idle") return null;
  if (phase === "pinned" && anchorRef && workletT0 != null) {
    const estWorklet =
      anchorRef.workletT + (performance.now() - anchorRef.wallNow) / 1000;
    const s = estWorklet - workletT0;
    return s >= 0 ? s : null;
  }
  if (provisionalWall0 != null) {
    return (performance.now() - provisionalWall0) / 1000;
  }
  return null;
}

/**
 * Map a provisional (recording-start) timestamp onto the session clock.
 * Identity before the pin; −shift after. Detectors that run their state
 * machines on the provisional clock apply this at EMISSION time, so their
 * internal frame timing is never disturbed by the origin change.
 */
export function toSession(t: number): number {
  return t - shift;
}

/** Map a [start, end] pair onto the session clock (shift-invariant deltas
 *  like durationMs are left untouched by callers). */
export function toSessionPair(
  start: number,
  end: number
): [number, number] {
  return [start - shift, end - shift];
}

/** The session rebase delta applied to provisional timestamps: 0 before
 *  the pin, −shift after. Consumers that emitted during the provisional
 *  phase use this to rebase exactly once when the pin lands. */
export function shiftValue(): number {
  return -shift;
}

/** The wall-clock base detectors should use as their internal t=0, so
 *  their frame times ARE provisional times and toSession() is exact.
 *  Null when the clock is idle — callers fall back to their own base. */
export function provisionalWallBase(): number | null {
  return provisionalWall0;
}

/** Worklet time at session t=0 (the pinned origin), or null pre-pin. */
export function workletT0Value(): number | null {
  return workletT0;
}

/** Map a worklet timestamp onto the session clock (null pre-pin). */
export function toWorkletSession(workletT: number): number | null {
  if (workletT0 == null) return null;
  return workletT - workletT0;
}

export function isPinned(): boolean {
  return phase === "pinned";
}
