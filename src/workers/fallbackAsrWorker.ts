/**
 * BOLO — Local Fallback ASR Worker (main-thread rule)
 *
 * The mission requires the Backup Lexical Resolver to run INSIDE a dedicated
 * Web Worker — never on the UI thread. This worker:
 *
 *   • lazily loads a lightweight Wav2Vec2 CTC model (transformers.js, q8)
 *   • listens for { id, clip } messages (16 kHz Float32 mono clips)
 *   • answers the fallback question: "given this short clip, what word was
 *     probably said?" — it never tries to spell the stutter prefix (the DSP
 *     layer already owns the stutter evidence)
 *   • posts { id, text, confidence } back — one inference at a time
 *
 * The model loads ONCE per worker lifetime and never competes with
 * Speechmatics on the full stream (on-demand only).
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

interface Recognizer {
  processor: any;
  model: any;
  tokenizer: any;
}

let recognizerPromise: Promise<Recognizer> | null = null;

function getRecognizer(): Promise<Recognizer> {
  if (!recognizerPromise) {
    recognizerPromise = (async () => {
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
    })();
  }
  return recognizerPromise;
}

async function transcribe(
  clip: Float32Array
): Promise<{ text: string; confidence: number }> {
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

// ─── Message loop ───────────────────────────────────────────────────────

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: (msg: unknown) => void;
};

ctx.onmessage = (ev: MessageEvent) => {
  const { id, clip } = ev.data ?? {};
  if (!id || !(clip instanceof Float32Array)) return;
  void transcribe(clip).then((result) => {
    ctx.postMessage({ id, ...result });
  });
};
