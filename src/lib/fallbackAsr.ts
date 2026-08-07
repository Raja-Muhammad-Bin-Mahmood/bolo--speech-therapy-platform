/**
 * BOLO — Fallback ASR client (Web Worker bridge)
 *
 * The only way the app talks to the Backup Lexical Resolver. Inference runs
 * inside a dedicated module worker (see src/workers/fallbackAsrWorker.ts) so
 * the UI thread is never blocked — the main-thread rule from the spec.
 *
 * The engine passes a suspicious clip (16 kHz Float32), and this module
 * resolves with { text, confidence } when the worker answers. Clips are
 * transferred (zero-copy) where possible. On worker failure every pending
 * request resolves to an empty result so the engine degrades to a
 * conservative placeholder — never a guessed word.
 */

export interface FallbackAsrResult {
  text: string;
  /** 0..1 — mean greedy-path CTC confidence */
  confidence: number;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: FallbackAsrResult) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/fallbackAsrWorker.ts", import.meta.url), {
    type: "module",
    name: "bolo-fallback-asr",
  });

  worker.onmessage = (ev: MessageEvent) => {
    const { id, text, confidence } = ev.data ?? {};
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.resolve({ text: text ?? "", confidence: confidence ?? 0 });
  };

  worker.onerror = () => {
    // Model failed to load / worker crashed — degrade gracefully.
    for (const [, p] of pending) p.resolve({ text: "", confidence: 0 });
    pending.clear();
    worker?.terminate();
    worker = null;
  };

  return worker;
}

/** Transcribe one suspicious clip in the worker (on-demand only). */
export function recognizeInWorker(clip: Float32Array): Promise<FallbackAsrResult> {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    const w = getWorker();
    try {
      // Zero-copy transfer of the clip buffer
      w.postMessage({ id, clip }, [clip.buffer as ArrayBuffer]);
    } catch {
      w.postMessage({ id, clip });
    }
  });
}

/** Terminate the worker (e.g. session end). Idempotent. */
export function disposeFallbackWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const [, p] of pending) p.resolve({ text: "", confidence: 0 });
  pending.clear();
}
