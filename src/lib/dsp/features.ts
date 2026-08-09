/**
 * BOLO — Frame Feature Extraction (pure, deterministic)
 *
 * Raw PCM → 20ms frames at 10ms hops. Every frame carries RMS, ZCR,
 * spectral centroid (Hz), spectral bandwidth (Hz), spectral flux (0..1)
 * and a voicing estimate. The spectral features are computed internally
 * with a Hann-windowed radix-2 FFT — no Meyda, no AnalyserNode, no global
 * state — so the EXACT same extractor serves the live mic pipeline AND the
 * deterministic test harness.
 *
 * Spectral centroid is a measure of where the spectral mass sits — it is
 * NOT pitch, and must never be described as pitch.
 */

import type { AudioFrame } from "./types";

export const SAMPLE_RATE = 16000;
export const FRAME_MS = 20;
export const HOP_MS = 10;
export const FRAME_SIZE = Math.round((SAMPLE_RATE * FRAME_MS) / 1000); // 320
export const HOP_SIZE = Math.round((SAMPLE_RATE * HOP_MS) / 1000); // 160

const FFT_SIZE = 256;
const HALF = FFT_SIZE >> 1; // 128 bins used (skip DC)
const BIN_HZ = SAMPLE_RATE / FFT_SIZE; // 62.5 Hz per bin

const HANN = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  HANN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
}

/** Radix-2 in-place FFT (same algorithm the DSP worklet uses). */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const wRe = Math.cos(-Math.PI / halfLen);
    const wIm = Math.sin(-Math.PI / halfLen);
    for (let i = 0; i < n; i += len) {
      let tRe = 1;
      let tIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const k = i + j;
        const k2 = k + halfLen;
        const uRe = re[k];
        const uIm = im[k];
        const vRe = re[k2] * tRe - im[k2] * tIm;
        const vIm = re[k2] * tIm + im[k2] * tRe;
        re[k] = uRe + vRe;
        im[k] = uIm + vIm;
        re[k2] = uRe - vRe;
        im[k2] = uIm - vIm;
        const newTRe = tRe * wRe - tIm * wIm;
        tIm = tRe * wIm + tIm * wRe;
        tRe = newTRe;
      }
    }
  }
}

/** Raw extracted features (voicing is engine-level: it needs the noise gate). */
export interface RawFrame {
  timestampMs: number;
  rms: number;
  zcr: number;
  spectralCentroid: number;
  spectralBandwidth: number;
  spectralFlux: number;
}

/**
 * Stateful extractor: feed PCM chunks (with the ms timestamp of the FIRST
 * sample), receive one RawFrame per 10ms hop. Deterministic — identical
 * input PCM yields identical frames.
 */
export class FrameExtractor {
  private pending: number[] = [];
  private pendingBaseMs = 0;
  private prevMag: Float32Array | null = null;
  private fftRe = new Float32Array(FFT_SIZE);
  private fftIm = new Float32Array(FFT_SIZE);
  private winBuf = new Float32Array(FFT_SIZE);
  private magBuf = new Float32Array(HALF);
  private normBuf = new Float32Array(HALF);

  /** Push a PCM chunk. `startTimeMs` = time of `samples[0]` on the timeline. */
  push(samples: Float32Array, startTimeMs: number, out: RawFrame[]): void {
    if (samples.length === 0) return;
    if (this.pending.length === 0) this.pendingBaseMs = startTimeMs;
    for (let i = 0; i < samples.length; i++) this.pending.push(samples[i]);

    while (this.pending.length >= HOP_SIZE) {
      const frameTMs = this.pendingBaseMs;
      const frame = this.extractFrame(frameTMs);
      out.push(frame);
      // Slide one hop — the next frame window starts HOP_MS later.
      this.pending.splice(0, HOP_SIZE);
      this.pendingBaseMs += HOP_MS;
    }
  }

  /** Drain any remaining partial frame (used at session end). */
  flush(out: RawFrame[]): void {
    if (this.pending.length >= HOP_SIZE / 2) {
      out.push(this.extractFrame(this.pendingBaseMs));
    }
    this.pending = [];
    this.prevMag = null;
  }

  reset(): void {
    this.pending = [];
    this.pendingBaseMs = 0;
    this.prevMag = null;
  }

  private extractFrame(frameTMs: number): RawFrame {
    const n = Math.min(FRAME_SIZE, this.pending.length);
    const win = this.winBuf;

    // ── RMS + ZCR over the available window ─────────────────────────
    let sumSq = 0;
    let zc = 0;
    for (let i = 0; i < n; i++) {
      const x = this.pending[i];
      sumSq += x * x;
      if (i > 0 && x * this.pending[i - 1] < 0) zc++;
      win[i] = x * HANN[i];
    }
    for (let i = n; i < FFT_SIZE; i++) win[i] = 0;
    const rms = Math.sqrt(sumSq / Math.max(1, n));
    const zcr = n > 1 ? zc / (n - 1) : 0;

    // ── FFT magnitude spectrum (bins 1..HALF) ───────────────────────
    const re = this.fftRe;
    const im = this.fftIm;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = win[i];
      im[i] = 0;
    }
    fft(re, im);

    const mag = this.magBuf;
    let sumMag = 0;
    for (let i = 1; i <= HALF; i++) {
      const m = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      mag[i - 1] = m;
      sumMag += m;
    }

    // ── Spectral centroid + bandwidth ───────────────────────────────
    let centroid = 0;
    if (sumMag > 1e-9) {
      for (let i = 0; i < HALF; i++) {
        centroid += mag[i] * (i + 1) * BIN_HZ;
      }
      centroid /= sumMag;
    }
    let bandwidth = 0;
    if (sumMag > 1e-9) {
      for (let i = 0; i < HALF; i++) {
        const d = (i + 1) * BIN_HZ - centroid;
        bandwidth += mag[i] * d * d;
      }
      bandwidth = Math.sqrt(bandwidth / sumMag);
    }

    // ── Spectral flux (normalized half-wave spectrum change) ─────────
    let flux = 0;
    const prev = this.prevMag;
    if (prev && sumMag > 1e-9) {
      const norm = this.normBuf;
      for (let i = 0; i < HALF; i++) norm[i] = mag[i] / sumMag;
      for (let i = 0; i < HALF; i++) {
        const d = norm[i] - prev[i];
        if (d > 0) flux += d;
      }
    }
    // Keep the normalized spectrum for next frame
    if (sumMag > 1e-9) {
      const norm = this.normBuf;
      for (let i = 0; i < HALF; i++) norm[i] = mag[i] / sumMag;
      if (!this.prevMag) this.prevMag = new Float32Array(HALF);
      this.prevMag.set(norm);
    } else if (this.prevMag) {
      this.prevMag.fill(0);
    }

    return {
      timestampMs: frameTMs,
      rms,
      zcr,
      spectralCentroid: centroid,
      spectralBandwidth: bandwidth,
      spectralFlux: Math.min(1, flux),
    };
  }
}

/** Frame count in a PCM buffer (floor) — for chunk duration math. */
export function samplesToMs(samples: number): number {
  return (samples / SAMPLE_RATE) * 1000;
}
