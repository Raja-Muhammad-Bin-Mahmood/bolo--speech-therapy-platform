/**
 * BOLO — Sensor Processor AudioWorklet
 *
 * The bare physics layer: extracts raw acoustic measurements from the
 * microphone waveform in real time, running OFF the main UI thread.
 *
 * ── Specs ──
 * Sample rate:        16 kHz (target)
 * Frame size:         20 ms  (320 samples)
 * Hop size:           10 ms  (160 samples)
 * Live history buffer: 30 s  (3000 frames maximum)
 *
 * ── Per-frame measurements ──
 *   RMS         — Root Mean Square energy (amplitude envelope)
 *   ZCR         — Zero Crossing Rate (frequency roughness)
 *   Delta Energy — Change in RMS vs the exact previous frame
 *
 * ── No ML, no classification, no VAD, no FFT ──
 * This is a pure physics probe. Interpretation happens later.
 *
 * ── Message protocol ──
 * Posts to main thread:
 *   { type: "frame", frame: { t, rms, zcr, deltaEnergy, sampleCount } }
 */

// ─── Constants ────────────────────────────────────────────────────────────
const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const HOP_MS = 10;
const FRAME_SIZE = Math.round((SAMPLE_RATE * FRAME_MS) / 1000); // 320
const HOP_SIZE = Math.round((SAMPLE_RATE * HOP_MS) / 1000);    // 160

// Live history: 30 seconds at 100 frames/second (10ms hop)
const MAX_HISTORY_FRAMES = 3000;

// ─── Worklet Processor ──────────────────────────────────────────────────
class BoloSensorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // ── Clock ──
    this._t0 = null; // set on first process() call
    this._frameCount = 0;

    // ── Sample ring buffer (inter-frame accumulation) ──
    this._pending = [];

    // ── Previous frame RMS for delta calculation ──
    this._prevRms = 0;

    // ── Frame history buffer (30s rolling) ──
    this._history = [];
  }

  // ── Main process loop ──────────────────────────────────────────────────
  process(inputs, _outputs, _params) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const channel = input[0];
    const now = currentTime;

    if (this._t0 === null) this._t0 = now;
    const t = now - this._t0;

    // Accumulate samples into pending buffer
    for (let i = 0; i < channel.length; i++) {
      this._pending.push(channel[i]);
    }

    // Process in 10ms hops
    while (this._pending.length >= HOP_SIZE) {
      const frameT = t - (this._pending.length / SAMPLE_RATE);

      // Build a 20ms frame from the pending buffer
      const frameLen = Math.min(FRAME_SIZE, this._pending.length);
      const frame = this._pending.slice(0, frameLen);

      this._analyzeFrame(frame, frameT);

      // Slide by hop
      this._pending.splice(0, HOP_SIZE);
    }

    return true;
  }

  // ── Analyze one frame ──────────────────────────────────────────────────
  _analyzeFrame(samples, t) {
    this._frameCount++;
    const n = samples.length;

    // ── 1. RMS energy ────────────────────────────────────────────────
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      sumSq += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSq / Math.max(1, n));

    // ── 2. Zero Crossing Rate ─────────────────────────────────────────
    let zcr = 0;
    for (let i = 1; i < n; i++) {
      if (samples[i] * samples[i - 1] < 0) zcr++;
    }
    const zcrRate = zcr / Math.max(1, n - 1);

    // ── 3. Delta Energy (vs previous frame) ───────────────────────────
    const deltaEnergy = this._prevRms > 0
      ? rms - this._prevRms
      : 0;

    // ── 4. Build frame data ──────────────────────────────────────────
    const frameData = {
      type: "frame",
      frame: {
        t: t,
        rms: rms,
        zcr: zcrRate,
        deltaEnergy: deltaEnergy,
        sampleCount: n,
      },
    };

    // ── 5. Post to main thread ───────────────────────────────────────
    this.port.postMessage(frameData);

    // ── 6. Store in rolling history buffer (30s) ──────────────────────
    this._history.push(frameData.frame);
    if (this._history.length > MAX_HISTORY_FRAMES) {
      this._history.shift();
    }

    // Save for next frame's delta
    this._prevRms = rms;
  }

  // ── Handle main-thread requests ────────────────────────────────────────
  // (empty for now — the main thread just reads posted messages)
}

registerProcessor("bolo-sensor-processor", BoloSensorProcessor);