/**
 * BOLO — Stutter Detection AudioWorkletProcessor
 *
 * Runs DSP OFF the main UI thread (AudioWorklet). Forwards PCM chunks
 * to the main thread for Speechmatics ASR and posts CANDIDATE events
 * (repetition, prolongation, block, tense_block, hesitation_sequence)
 * based on frame-level acoustic features.
 *
 * ── Design ──
 * - 24ms window, 10ms hop → ~100 frames/sec
 * - Rolling 500ms context buffer
 * - Adaptive noise baseline
 * - Lightweight features: RMS, ZCR, envelope delta, voiced flag,
 *   low-frication ZCR detector, onset detection
 * - Conservative classifiers: false positives > misses
 *
 * ── No import statements ──
 * Plain JS file hosted in public/; loaded via addModule.
 *
 * ── Message protocol ──
 * Post to main thread:
 *   { type: "pcm", t: <workletSec>, buffer: <Float32Array 4096> }
 *   { type: "candidate", evt: { eventType, startTime, endTime, durationMs, confidence, reason[] } }
 */

// ─── Constants (16 kHz sample rate) ──────────────────────────────────────
const WINDOW_MS = 24;
const HOP_MS = 10;
const ROLLING_MS = 500;
const SAMPLE_RATE = 16000;
const WINDOW_FRAMES = Math.round((SAMPLE_RATE * WINDOW_MS) / 1000); // 384
const HOP_FRAMES = Math.round((SAMPLE_RATE * HOP_MS) / 1000); // 160

const PCM_CHUNK_SIZE = 4096;

// Adaptive baseline
const RMS_BASELINE_ALPHA = 0.05;
const RMS_VOICE_FACTOR = 3;
const RMS_VOICE_FLOOR = 0.006;
const RMS_BLOCK_THRESH = 0.4;
const BLOCK_RELEASE_RATIO = 2.2;

// Repetition
const REP_GAP_MIN_S = 0.08;
const REP_GAP_MAX_S = 0.25;
const REP_MIN_ONSETS = 3;
const REP_VOICED_RUN_MAX_S = 0.2;
const REP_WINDOW_S = 0.7;

// Prolongation
const PROLONG_MIN_S = 0.4;

// Block
const BLOCK_MIN_S = 0.2;

// Tense block
const TENSE_ZCR_THRESH = 0.45;
const TENSE_MIN_S = 0.12;
const TENSE_RMS_MIN_FACTOR = 1.2;
const TENSE_RMS_MAX_FACTOR = 1.5;
const FAILED_ONSET_GAP_MAX = 0.4;
const FAILED_ONSET_RUN_MAX_S = 0.08;

// Hesitation sequence (DSP-level clusters)
const HESIT_CLUSTER_WINDOW_S = 2.0;
const HESIT_MIN_FRAGMENTS = 3;
const HESIT_FRAG_DUR_MAX_S = 0.15;

// De-dupe
const DEDUPE_WINDOW_S = 0.25;
const DEDUPE_EVENTS_LAST = 5;

class BoloStutterDetector extends AudioWorkletProcessor {
  constructor() {
    super();

    // Clock
    this._t0 = null; // set on first process()
    this._frameCount = 0;

    // Accumulator for sliding analysis window
    this._pending = [];

    // PCM out buffer
    this._pcmBuffer = [];
    this._pcmStartT = null;

    // Rolling feature frames (circular, ~500ms)
    this._ring = [];

    // State: adaptive baseline
    this._baseline = 0.004;
    this._voiceThresh = 0.006;
    this._prevRms = 0;
    this._prevVoiced = false;

    // Onset tracker
    this._onsets = [];

    // Voiced run tracker
    this._run = null;
    this._segments = []; // finalized short segments (repetition candidates)

    // Silence (block) tracker
    this._silenceStart = null;
    this._silenceRmsAcc = 0;
    this._silenceCount = 0;

    // Prolongation tracker
    this._prolongRun = null;
    this._prolongEmitted = false; // emit only once per run

    // Tense pre-voicing
    this._tenseFricFrames = [];
    this._failedOnsets = [];

    // Hesitation cluster
    this._fragments = [];

    // De-dupe
    this._lastEmitTimes = [];
  }

  // ── Main process loop ──────────────────────────────────────────────
  process(inputs, outputs, params) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const channel = input[0];
    const now = currentTime;

    if (this._t0 === null) this._t0 = now;
    const t = now - this._t0;

    // Accumulate samples
    for (let i = 0; i < channel.length; i++) {
      this._pending.push(channel[i]);
    }

    // While we have at least HOP frames, slide the window
    while (this._pending.length >= HOP_FRAMES) {
      const frameT = t - (this._pending.length / SAMPLE_RATE);

      // Grab a WINDOW-sized frame (or less at start)
      const frameLen = Math.min(WINDOW_FRAMES, this._pending.length);
      const frame = this._pending.slice(0, frameLen);

      this._analyzeFrame(frame, frameT);

      // Slide by HOP: remove first HOP samples
      this._pending.splice(0, HOP_FRAMES);
    }

    // PCM forwarding: accumulate 4096 samples → post
    this._forwardPcm(channel, t);

    return true;
  }

  // ── Frame analysis ────────────────────────────────────────────────
  _analyzeFrame(samples, t) {
    this._frameCount++;

    // ── Features ──────────────────────────────────────────────
    let sumSq = 0;
    let zcr = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSq += samples[i] * samples[i];
      if (i > 0 && samples[i] * samples[i - 1] < 0) zcr++;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, samples.length));
    const zcrRate = zcr / Math.max(1, samples.length - 1);

    // Adaptive noise baseline
    if (rms < this._baseline * 2) {
      this._baseline =
        this._baseline * (1 - RMS_BASELINE_ALPHA) + rms * RMS_BASELINE_ALPHA;
    }
    this._voiceThresh = Math.max(
      RMS_VOICE_FLOOR,
      this._baseline * RMS_VOICE_FACTOR + RMS_VOICE_FLOOR
    );

    const voiced = rms > this._voiceThresh && zcrRate < 0.3;
    const envDelta = this._prevRms > 0 ? (rms - this._prevRms) / this._prevRms : 0;
    const onset = voiced && !this._prevVoiced && envDelta > 0.8;

    // Frication (unvoiced, high ZCR, low-mid RMS)
    const fricative =
      !voiced &&
      zcrRate > 0.4 &&
      rms > this._baseline * 2 &&
      rms < this._voiceThresh * 1.8;

    const frame = { t, rms, zcr: zcrRate, voiced, onset, fricative, envDelta };

    // Push rolling ring
    this._ring.push(frame);
    while (this._ring.length > 0 && t - this._ring[0].t > ROLLING_MS / 1000) {
      this._ring.shift();
    }

    // ── Voiced run tracker ───────────────────────────────────
    if (voiced) {
      if (this._run === null) {
        this._run = { start: t, lastT: t, maxRms: rms, energyVarAcc: 0, frameCount: 1 };
      } else {
        this._run.lastT = t;
        this._run.maxRms = Math.max(this._run.maxRms, rms);
        this._run.energyVarAcc += Math.abs(rms - this._prevRms);
        this._run.frameCount++;
      }

      // ── Prolongation detection (sustained voicing) ─────────
      if (this._prolongRun === null) {
        this._prolongRun = { start: t, maxRms: rms, maxZcr: zcrRate, fCount: 1 };
        this._prolongEmitted = false;
      } else {
        this._prolongRun.maxRms = Math.max(this._prolongRun.maxRms, rms);
        this._prolongRun.maxZcr = Math.max(this._prolongRun.maxZcr, zcrRate);
        this._prolongRun.fCount++;
      }

      const prolDur = t - this._prolongRun.start;
      const stability = this._prolongRun.fCount > 3 ? 1 - this._prolongRun.maxZcr / 0.5 : 0.5;
      if (prolDur >= PROLONG_MIN_S && !this._prolongEmitted && stability >= 0.45) {
        const confidence = 0.5 + 0.3 * Math.min(1, stability) + 0.2 * Math.min(1, prolDur / 0.8);
        this._emitCandidate("prolongation", this._prolongRun.start, t, confidence, [
          `Prolonged sound for ${(prolDur * 1000).toFixed(0)}ms`,
        ]);
        this._prolongEmitted = true;
      }
    } else {
      // ── End of voiced run ──────────────────────────────────
      if (this._run !== null) {
        const runDur = t - this._run.start;
        if (runDur > 0.06) {
          this._onSegmentEnd(this._run.start, t, this._run.maxRms);
        }
        this._run = null;
      }
      if (this._prolongRun !== null) {
        this._prolongRun = null;
        this._prolongEmitted = false;
      }
    }

    // ── Onset detection ──────────────────────────────────────
    if (onset) {
      this._onsets.push(t);
      this._onsets = this._onsets.filter((o) => t - o <= REP_WINDOW_S + 0.1);

      // ── Repetition classifier ──────────────────────────────
      if (this._onsets.length >= REP_MIN_ONSETS) {
        const first = this._onsets[0];
        const span = t - first;
        if (span <= REP_WINDOW_S) {
          const gaps = [];
          for (let i = 1; i < this._onsets.length; i++) {
            gaps.push(this._onsets[i] - this._onsets[i - 1]);
          }
          const allInRange = gaps.every((g) => g >= REP_GAP_MIN_S && g <= REP_GAP_MAX_S);
          if (allInRange) {
            const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            const regularity = Math.max(0, 1 - Math.abs(avgGap - 0.165) / 0.1);
            const confidence = 0.55 + 0.3 * regularity + 0.15 * Math.min(1, (this._onsets.length - 2) / 3);
            this._emitCandidate("repetition", first, t, confidence, [
              `Repeated onset ${this._onsets.length} times in ${(span * 1000).toFixed(0)}ms`,
            ]);
            this._onsets = [this._onsets[this._onsets.length - 1]];
            // A repetition counts as fragments for hesitation purposes
            this._fragments.push({ start: first, end: t, durMs: (t - first) * 1000 });
          }
        }
      }
    }

    // ── Fricative / tense block tracking ──────────────────────
    if (fricative) {
      this._tenseFricFrames.push({ t, rms });
    } else if (this._tenseFricFrames.length > 0) {
      // Frication ended → check if immediately followed by voicing
      const fricStart = this._tenseFricFrames[0].t;
      const fricDur = t - fricStart;
      if (fricDur >= TENSE_MIN_S && voiced) {
        const confidence = 0.5 + 0.3 * Math.min(1, fricDur / 0.3) + 0.2 * Math.min(1, rms / (this._voiceThresh * 3));
        this._emitCandidate("tense_block", fricStart, t, confidence, [
          `Tense onset after ${(fricDur * 1000).toFixed(0)}ms of frication`,
        ]);
      }
      this._tenseFricFrames = [];
    }

    // ── Silence/block tracking ──────────────────────────────
    const blocked = !voiced && rms < this._voiceThresh * RMS_BLOCK_THRESH;
    if (blocked) {
      if (this._silenceStart === null) {
        this._silenceStart = t;
        this._silenceRmsAcc = 0;
        this._silenceCount = 0;
      }
      this._silenceRmsAcc += rms;
      this._silenceCount++;
    } else if (this._silenceStart !== null) {
      // Silence ended → check for sharp release
      const silDur = t - this._silenceStart;
      const avgSilRms = this._silenceRmsAcc / Math.max(1, this._silenceCount);
      const released = voiced && rms > this._voiceThresh * BLOCK_RELEASE_RATIO;
      if (silDur >= BLOCK_MIN_S && released) {
        const durSig = Math.min(1, silDur / 0.5);
        const releaseSig = Math.min(1, rms / (this._voiceThresh * 4));
        const confidence = 0.4 + 0.4 * durSig + 0.2 * releaseSig;
        this._emitCandidate("block", this._silenceStart, t, confidence, [
          `Block of ${(silDur * 1000).toFixed(0)}ms followed by release`,
        ]);
        // Blocks count as fragments for hesitation clustering
        this._fragments.push({ start: this._silenceStart, end: t, durMs: silDur * 1000 });
      }
      this._silenceStart = null;
      this._silenceRmsAcc = 0;
      this._silenceCount = 0;
    }

    // ── Failed onset tracking (tense_block pattern 2) ──────
    if (onset && this._run) {
      // This onset started a run that is NOW ending (checked above in run-end)
    }

    this._prevRms = rms;
    this._prevVoiced = voiced;
  }

  // ── Segment end handler ──────────────────────────────────────────
  _onSegmentEnd(start, end, maxRms) {
    const dur = end - start;
    if (dur <= REP_VOICED_RUN_MAX_S) {
      // Short fragment → store for repetition and hesitation patterns
      this._fragments.push({ start, end, durMs: dur * 1000 });
      // Prune old fragments
      const now = end;
      this._fragments = this._fragments.filter(
        (f) => now - f.start <= HESIT_CLUSTER_WINDOW_S
      );
    }
  }

  // ── Hesitation cluster check (run after segment ends) ──────────
  _checkHesitationCluster(now) {
    // Prune old fragments
    this._fragments = this._fragments.filter(
      (f) => now - f.start <= HESIT_CLUSTER_WINDOW_S
    );

    if (this._fragments.length >= HESIT_MIN_FRAGMENTS) {
      const allInWindow = now - this._fragments[0].start <= HESIT_CLUSTER_WINDOW_S;
      if (allInWindow) {
        const first = this._fragments[0];
        const last = this._fragments[this._fragments.length - 1];
        const spanMs = (last.end - first.start) * 1000;
        const clusterTightness = Math.min(1, HESIT_CLUSTER_WINDOW_S / (last.end - first.start + 0.1) * 0.5);

        // Only emit if span is ≥ 0.5s (meaningful cluster)
        if (spanMs >= 500) {
          const confidence = 0.5 + 0.2 * Math.min(1, (this._fragments.length - 2) / 4) + 0.3 * clusterTightness;
          this._emitCandidate("hesitation_sequence", first.start, last.end, confidence, [
            `${this._fragments.length} hesitation events over ${(spanMs).toFixed(0)}ms`,
          ]);
          // Clear fragments to prevent overlapping sequences
          this._fragments = [];
        }
      }
    }
  }

  // ── PCM forwarding ──────────────────────────────────────────────
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
      this._pcmStartT = null; // reset — next post will set it
    }
  }

  // ── Emit with de-dupe ────────────────────────────────────────────
  _emitCandidate(eventType, startTime, endTime, confidence, reason) {
    // De-dupe: no event if overlapping a recent emit
    const now = endTime;
    const recent = this._lastEmitTimes.filter((t) => now - t < DEDUPE_WINDOW_S);
    if (recent.length > 0) return;

    this._lastEmitTimes.push(now);
    if (this._lastEmitTimes.length > DEDUPE_EVENTS_LAST) this._lastEmitTimes.shift();

    // Threshold: only emit if confidence ≥ 0.45 (keep threshold at worklet level)
    if (confidence < 0.45) return;

    const evt = {
      eventType,
      startTime,
      endTime,
      durationMs: Math.round((endTime - startTime) * 1000),
      confidence: Math.min(1, confidence),
      reason,
    };

    this.port.postMessage({ type: "candidate", evt });

    // After emitting a candidate event, check for hesitation clusters
    // (don't do in hesitation handler itself to avoid recursion)
    if (eventType !== "hesitation_sequence") {
      this._checkHesitationCluster(endTime);
    }
  }
}

registerProcessor("bolo-stutter-detector", BoloStutterDetector);