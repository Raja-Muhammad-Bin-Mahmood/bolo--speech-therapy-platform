/**
 * BOLO — Telemetry Processor AudioWorklet
 *
 * Physics-based acoustic feature extraction running OFF the main UI thread.
 * Every 20ms frame (10ms hop) is classified into a broad phonetic
 * category using hard thresholds — no ML, no guessing.
 *
 * ── Frame pipeline ──
 * Raw PCM → RMS → ΔEnergy → Rolling Floor → FFT → Spectral Flatness →
 * ZCR → Low-freq energy → VAD → Frame label → Post to main thread
 *
 * ── Constants (16 kHz) ──
 * Frame size:  20 ms  (320 samples)
 * Hop size:    10 ms  (160 samples)
 * Rolling floor: ~1 s  EMA of quietest frames
 *
 * ── Message protocol ──
 * Posts to main thread:
 *   { type: "frame",  frame: { t, rms, deltaEnergy, zcr, spectralFlatness, vad, lowFreqEnergy, label, rollingNoiseFloor } }
 *   { type: "pcm",    t, buffer: Float32Array }
 */

// ─── Frame constants ──────────────────────────────────────────────────────
const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const HOP_MS = 10;
const FRAME_SIZE = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);  // 320
const HOP_SIZE = Math.round((SAMPLE_RATE * HOP_MS) / 1000);     // 160

// PCM chunk size for forwarding to Speechmatics
const PCM_CHUNK_SIZE = 4096;

// ─── Rolling floor ────────────────────────────────────────────────────────
const FLOOR_ALPHA = 0.02;          // slower decay for 1s effective window
const FLOOR_MIN = 0.0001;          // absolute floor (noise-gate)

// ─── VAD ──────────────────────────────────────────────────────────────────
const VAD_SPEECH_RATIO = 1.8;      // rms must be this × floor to be speech
const VAD_HYST_RATIO = 1.5;        // drop below this to exit speech

// ─── Frame classification thresholds ──────────────────────────────────────
const PLOSIVE_DELTA_FACTOR = 3.0;  // ΔE > 3 × floor
const PLOSIVE_VAD_MIN = 0.5;

const FRICATIVE_ZCR_MIN = 0.35;
const FRICATIVE_FLATNESS_MAX = 0.15;

const TENSE_RMS_FACTOR = 1.0;      // rms < 1 × floor
const TENSE_LOW_BIN_MIN = 0.003;   // min low-freq magnitude for tension

const BREATH_FLATNESS_MIN = 0.40;
const BREATH_RMS_FACTOR = 1.0;     // rms > 1 × floor

const SILENCE_RMS_FACTOR = 1.0;    // rms < 1 × floor
const SILENCE_VAD_MAX = 0.3;

const VOICED_VAD_MIN = 0.6;
const VOICED_ZCR_MAX = 0.15;

// ─── FFT ──────────────────────────────────────────────────────────────────
const FFT_SIZE = 256;              // 256-point FFT → 128 bins, 62.5 Hz/bin
const FFT_BUF_SIZE = FFT_SIZE;

// 20-80 Hz → bins 1..2 (bin 0 is DC, bin 1 = 62.5 Hz, bin 2 = 125 Hz)
const LOW_BIN_START = 1;
const LOW_BIN_END = 2;

// ─── Hann window table (precomputed) ──────────────────────────────────────
const HANN = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  HANN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
}

// ─── FFT (radix-2, in-place) ──────────────────────────────────────────────
// NOTE: worklet files are parsed by the browser as plain ES modules — no
// TypeScript annotations are allowed here (a previous `re: Float32Array`
// signature caused a SyntaxError and silently disabled the whole DSP lane).
function fft(re, im) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  // Cooley-Tukey radix-2
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const wRe = Math.cos(-Math.PI / halfLen);
    const wIm = Math.sin(-Math.PI / halfLen);
    for (let i = 0; i < n; i += len) {
      let tRe = 1, tIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const k = i + j;
        const k2 = k + halfLen;
        const uRe = re[k], uIm = im[k];
        const vRe = re[k2] * tRe - im[k2] * tIm;
        const vIm = re[k2] * tIm + im[k2] * tRe;
        re[k] = uRe + vRe; im[k] = uIm + vIm;
        re[k2] = uRe - vRe; im[k2] = uIm - vIm;
        const newTRe = tRe * wRe - tIm * wIm;
        tIm = tRe * wIm + tIm * wRe;
        tRe = newTRe;
      }
    }
  }
}

// ─── Frame label enum ────────────────────────────────────────────────────
const LABEL = Object.freeze({
  SILENCE:          0,
  BREATH:           1,
  FRICATIVE:        2,
  VOICED:           3,
  PLOSIVE_BURST:    4,
  TENSE_HOLD:       5,
  UNKNOWN:          6,
});

// ─── Worklet class ───────────────────────────────────────────────────────
class BoloTelemetryProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // ── Clock ──
    this._t0 = null;               // first process() call time
    this._frameCount = 0;

    // ── Sample ring buffer (inter-frame accumulation) ──
    this._pending = [];            // samples accumulated since last hop

    // ── PCM out buffer ──
    this._pcmBuffer = [];
    this._pcmStartT = null;

    // ── Rolling noise floor (EMA of quietest frames) ──
    this._floor = 0.004;           // initial floor estimate
    this._prevRms = 0;             // previous frame RMS for ΔE

    // ── VAD state machine ──
    this._vadOn = false;

    // ── FFT working buffers ──
    this._fftRe = new Float32Array(FFT_SIZE);
    this._fftIm = new Float32Array(FFT_SIZE);
    this._frameBuf = new Float32Array(FFT_SIZE); // windowed frame

    // ── Frame history buffer (for timeline engine on main thread) ──
    // We keep the last 1.5s of frame labels + features for delayed analysis
    this._history = [];
    this._historyMaxMs = 1500;
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

    // Forward PCM chunks to main thread
    this._forwardPcm(channel, t);

    return true;
  }

  // ── Analyze one 20ms frame ─────────────────────────────────────────────
  _analyzeFrame(samples, t) {
    this._frameCount++;

    const n = samples.length;

    // ── 1. RMS energy ────────────────────────────────────────────────
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      sumSq += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSq / Math.max(1, n));

    // ── 2. Delta energy (vs previous frame) ──────────────────────────
    const deltaEnergy = this._prevRms > 0
      ? rms - this._prevRms
      : 0;

    // ── 3. Zero crossing rate ────────────────────────────────────────
    let zcr = 0;
    for (let i = 1; i < n; i++) {
      if (samples[i] * samples[i - 1] < 0) zcr++;
    }
    const zcrRate = zcr / Math.max(1, n - 1);

    // ── 4. FFT + spectral features ───────────────────────────────────
    // Apply Hann window and copy to FFT buffer
    const fftRe = this._fftRe;
    const fftIm = this._fftIm;
    const frameBuf = this._frameBuf;

    for (let i = 0; i < FFT_SIZE; i++) {
      const val = i < n ? samples[i] * HANN[i] : 0;
      frameBuf[i] = val;
      fftRe[i] = val;
      fftIm[i] = 0;
    }

    // Compute FFT
    fft(fftRe, fftIm);

    // Magnitude spectrum (ignore DC, use bins 1..FFT_SIZE/2)
    const halfN = FFT_SIZE >> 1;
    let sumMag = 0;
    let logSumMag = 0;
    let lowFreqEnergy = 0;

    for (let i = 1; i <= halfN; i++) {
      const mag = Math.sqrt(fftRe[i] * fftRe[i] + fftIm[i] * fftIm[i]);
      sumMag += mag;
      logSumMag += Math.log(Math.max(1e-10, mag));

      // Low-frequency energy (20-80 Hz)
      if (i >= LOW_BIN_START && i <= LOW_BIN_END) {
        lowFreqEnergy += mag;
      }
    }

    // Spectral flatness: geometric mean / arithmetic mean
    const meanMag = sumMag / halfN;
    const geoMean = Math.exp(logSumMag / halfN);
    const spectralFlatness = meanMag > 1e-10
      ? Math.min(1, geoMean / meanMag)
      : 0;

    // Normalize low-freq energy by number of bins
    const lowFreqNorm = lowFreqEnergy / Math.max(1, LOW_BIN_END - LOW_BIN_START + 1);

    // ── 5. Rolling noise floor ───────────────────────────────────────
    // Only update floor when energy is near the floor (quiet frames)
    const vadRaw = this._computeVad(rms);
    if (vadRaw < 0.3) {
      // Quiet frame: update floor
      this._floor = this._floor * (1 - FLOOR_ALPHA) + rms * FLOOR_ALPHA;
      this._floor = Math.max(FLOOR_MIN, this._floor);
    }

    // ── 6. VAD (smoothed state machine) ──────────────────────────────
    const vad = this._computeVad(rms);
    const speechRatio = rms / Math.max(FLOOR_MIN, this._floor);

    if (!this._vadOn && speechRatio > VAD_SPEECH_RATIO) {
      this._vadOn = true;
    } else if (this._vadOn && speechRatio < VAD_HYST_RATIO) {
      this._vadOn = false;
    }

    // ── 7. Frame classification ──────────────────────────────────────
    let label;
    let labelName;

    // Priority order: PLOSIVE_BURST → FRICATIVE → TENSE_HOLD → BREATH → SILENCE → VOICED

    if (deltaEnergy > PLOSIVE_DELTA_FACTOR * this._floor && vad > PLOSIVE_VAD_MIN) {
      label = LABEL.PLOSIVE_BURST;
      labelName = "PLOSIVE_BURST";
    } else if (zcrRate > FRICATIVE_ZCR_MIN && spectralFlatness < FRICATIVE_FLATNESS_MAX) {
      label = LABEL.FRICATIVE;
      labelName = "FRICATIVE";
    } else if (rms < TENSE_RMS_FACTOR * this._floor && lowFreqNorm > TENSE_LOW_BIN_MIN) {
      label = LABEL.TENSE_HOLD;
      labelName = "TENSE_HOLD";
    } else if (spectralFlatness > BREATH_FLATNESS_MIN && rms > BREATH_RMS_FACTOR * this._floor) {
      label = LABEL.BREATH;
      labelName = "BREATH";
    } else if (rms < SILENCE_RMS_FACTOR * this._floor && vad < SILENCE_VAD_MAX) {
      label = LABEL.SILENCE;
      labelName = "SILENCE";
    } else if (vad > VOICED_VAD_MIN && zcrRate < VOICED_ZCR_MAX) {
      label = LABEL.VOICED;
      labelName = "VOICED";
    } else {
      // Fallback: if VAD is high, treat as VOICED; else BREATH
      if (vad > 0.4) {
        label = LABEL.VOICED;
        labelName = "VOICED";
      } else if (rms > this._floor) {
        label = LABEL.BREATH;
        labelName = "BREATH";
      } else {
        label = LABEL.SILENCE;
        labelName = "SILENCE";
      }
    }

    // ── 8. Post frame to main thread ─────────────────────────────────
    const frameData = {
      type: "frame",
      frame: {
        t: t,
        rms: rms,
        deltaEnergy: deltaEnergy,
        zcr: zcrRate,
        spectralFlatness: spectralFlatness,
        vad: vad,
        lowFreqEnergy: lowFreqNorm,
        label: label,
        labelName: labelName,
        rollingNoiseFloor: this._floor,
        speechRatio: speechRatio,
        voiced: this._vadOn,
      },
    };

    this.port.postMessage(frameData);

    // ── 9. Store in history buffer ───────────────────────────────────
    this._history.push(frameData.frame);
    // Prune older than max
    const historyCutoff = t - this._historyMaxMs / 1000;
    while (this._history.length > 0 && this._history[0].t < historyCutoff) {
      this._history.shift();
    }

    // Save for next frame's delta
    this._prevRms = rms;
  }

  // ── VAD computation ────────────────────────────────────────────────────
  _computeVad(rms) {
    const ratio = rms / Math.max(FLOOR_MIN, this._floor);
    if (ratio < 1.2) return 0;
    if (ratio > 3.0) return 1;
    return (ratio - 1.2) / (3.0 - 1.2);
  }

  // ── PCM forwarding ─────────────────────────────────────────────────────
  _forwardPcm(channel, t) {
    if (this._pcmBuffer.length === 0) {
      this._pcmStartT = t;
    }
    for (let i = 0; i < channel.length; i++) {
      this._pcmBuffer.push(channel[i]);
    }
    while (this._pcmBuffer.length >= PCM_CHUNK_SIZE) {
      const chunk = new Float32Array(this._pcmBuffer.slice(0, PCM_CHUNK_SIZE));
      this._pcmBuffer.splice(0, PCM_CHUNK_SIZE);
      this.port.postMessage({ type: "pcm", t: this._pcmStartT, buffer: chunk });
      this._pcmStartT = null;
    }
  }
}

registerProcessor("bolo-telemetry-processor", BoloTelemetryProcessor);