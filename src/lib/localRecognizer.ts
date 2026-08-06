/**
 * BOLO — Local Fragment Recognizer (Wav2Vec2 CTC, on-demand only)
 *
 * A lightweight, conservative, acoustic-first fallback that runs ONLY when
 * the event-triggered recovery engine needs to fill a gap:
 *   - Speechmatics did not finalize a word for a detected stutter event
 *   - a 1–2s clip is cropped from the live ring buffer
 *   - this module transcribes JUST that clip and returns text + confidence
 *
 * Design (spec: "lightweight local fragment extractor"):
 *   - Wav2Vec2 CTC acoustic-first model (no LM smoothing, no normalization
 *     that strips repetitions) — transformers.js runs it fully in-browser.
 *   - The model is loaded LAZILY on first actual gap and never competes with
 *     Speechmatics on the full stream.
 *   - Confidence comes from the mean softmax probability of the greedy CTC
 *     path across non-blank frames — strong ≥0.80, medium ≥0.50, else
 *     "uncertain" (the caller shows a placeholder instead of guessing).
 */

import {
  AutoProcessor,
  AutoModel,
  AutoTokenizer,
  env,
} from "@huggingface/transformers";

// Force remote fetch (never try local model files in the browser)
try {
  env.allowLocalModels = false;
} catch {
  // non-critical
}

const MODEL_ID = "Xenova/wav2vec2-base-960h";
const SAMPLE_RATE = 16000;

export interface RecognizeResult {
  text: string;
  /** 0..1 mean greedy-path CTC confidence */
  confidence: number;
}

interface Recognizer {
  processor: any;
  model: any;
  tokenizer: any;
}

let initPromise: Promise<Recognizer> | null = null;

async function initRecognizer(): Promise<Recognizer> {
  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  // Prefer the quantized build (~90MB) — fall back to fp32 if unavailable.
  let model: any;
  try {
    model = await AutoModel.from_pretrained(MODEL_ID, { dtype: "q8" });
  } catch {
    model = await AutoModel.from_pretrained(MODEL_ID);
  }
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  return { processor, model, tokenizer };
}

export function getRecognizer(): Promise<Recognizer> {
  if (!initPromise) {
    initPromise = initRecognizer().catch((err) => {
      initPromise = null; // allow retry on next gap
      throw err;
    });
  }
  return initPromise;
}

// Serialized queue so clips are never transcribed concurrently (the engine
// coalesces anyway; this is a belt-and-braces guard).
let chain: Promise<unknown> = Promise.resolve();

export function recognizeClip(clip: Float32Array): Promise<RecognizeResult> {
  const run = chain.then(() => transcribe(clip));
  chain = run.catch(() => {});
  return run;
}

async function transcribe(clip: Float32Array): Promise<RecognizeResult> {
  try {
    const r = await getRecognizer();
    const inputs = await r.processor(clip);
    const out = await r.model(inputs);
    const logits = out?.logits as any;
    if (!logits || !logits.dims) return { text: "", confidence: 0 };

    // dims: [1, seq, vocab] or [seq, vocab] depending on the runtime build
    const dims: number[] = logits.dims;
    const seq = dims.length === 3 ? dims[1] : dims[0];
    const vocab = dims.length === 3 ? dims[2] : dims[1];
    const data: Float32Array = logits.data;
    if (!seq || !vocab || !data || data.length < seq * vocab) {
      return { text: "", confidence: 0 };
    }

    const ids: number[] = new Array(seq);
    let probSum = 0;
    let nonBlank = 0;
    for (let f = 0; f < seq; f++) {
      const row = f * vocab;
      let maxV = -Infinity;
      for (let v = 0; v < vocab; v++) {
        const x = data[row + v];
        if (x > maxV) maxV = x;
      }
      let denom = 0;
      for (let v = 0; v < vocab; v++) denom += Math.exp(data[row + v] - maxV);
      let best = 0;
      let bestP = 0;
      for (let v = 0; v < vocab; v++) {
        const p = Math.exp(data[row + v] - maxV) / denom;
        if (p > bestP) {
          bestP = p;
          best = v;
        }
      }
      ids[f] = best;
      // Token 0 is the CTC blank/pad in Wav2Vec2 — excluded from confidence
      if (best !== 0) {
        probSum += bestP;
        nonBlank++;
      }
    }

    const text =
      (r.tokenizer?.decode?.(ids, { skip_special_tokens: true }) as string)
        ?.trim?.() ?? "";
    const confidence = nonBlank > 0 ? probSum / nonBlank : 0;
    return { text, confidence };
  } catch {
    // Model unavailable / decode failed — report empty so the caller shows a
    // conservative placeholder instead of inventing a word.
    return { text: "", confidence: 0 };
  }
}

export { SAMPLE_RATE };
