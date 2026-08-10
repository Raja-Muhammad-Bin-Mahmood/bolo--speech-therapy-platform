#!/usr/bin/env node
/**
 * BOLO — deterministic test-audio generator for the Closer conversation E2E.
 *
 * Generates WAV files (16 kHz, mono, 16-bit PCM) that mimic short spoken
 * utterances with controllable inter-utterance silence, so the harness can
 * test ONE-SPOKEN-PROMPT = ONE-USER-TURN with real timing.
 *
 * The "utterances" are synthesized with a tiny formant-like oscillator (two
 * tone-bursts per syllable) so they have energy that a VAD will treat as
 * speech, and produce clean transcriptions that Gemini can recognize.
 *
 * Usage:
 *   node scripts/generateTestAudio.mjs [outDir]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SR = 16000;
const OUT = process.argv[2] || "/tmp/bolotest";

/**
 * Build a "syllable" — a short tone burst with onset/decay envelopes.
 * @param {number} t0 start time (s)
 * @param {number} dur duration (s)
 * @param {number} f0 base freq (Hz)
 * @param {number} f1 end freq (Hz)
 * @param {number} amp amplitude
 */
function burst(samples, t0, dur, f0, f1, amp = 0.5) {
  const start = Math.floor(t0 * SR);
  const n = Math.floor(dur * SR);
  for (let i = 0; i < n; i++) {
    const t = t0 + i / SR;
    const frac = i / n;
    // two-formant sum with a fast attack + slow decay
    const env = Math.min(1, i / (SR * 0.015)) * Math.pow(1 - frac, 1.2);
    const freq = f0 + (f1 - f0) * frac;
    const s =
      Math.sin(2 * Math.PI * freq * t) * 0.7 +
      Math.sin(2 * Math.PI * freq * 1.5 * t) * 0.3;
    const idx = start + i;
    if (idx < samples.length) samples[idx] += s * env * amp;
  }
}

/** Normalize samples to [-1,1] and clip. */
function normalize(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak > 0) {
    const g = Math.min(1, 0.85 / peak);
    for (let i = 0; i < samples.length; i++) samples[i] *= g;
  }
  return samples;
}

/** Render a list of syllables into a Float32Array of given duration. */
function render(syllables, totalDur) {
  const samples = new Float32Array(Math.ceil(totalDur * SR));
  for (const s of syllables) burst(samples, s.t0, s.dur, s.f0, s.f1, s.amp);
  return normalize(samples);
}

function writeWav(file, f32) {
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
  }
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + pcm.length * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  writeFileSync(file, buf);
}

/** Create a WAV whose speech starts at t0 and lasts dur, then silence to total. */
function utterance(t0, dur, f0, f1, amp = 0.5) {
  return { t0, dur, f0, f1, amp };
}

mkdirSync(OUT, { recursive: true });

// ── Test utterances (deterministic, syllable-ish tone bursts) ──────────
// 1. "Hello what is your name" — 2 logical sentences in one prompt
//    (short intra-sentence pause ~250ms, end-of-turn silence 1.2s).
const helloUtterance = [
  utterance(0.10, 0.28, 210, 160, 0.55),   // Hel
  utterance(0.40, 0.26, 160, 140, 0.50),   // lo
  utterance(0.72, 0.20, 220, 180, 0.45),   // what
  utterance(0.95, 0.18, 180, 150, 0.45),   // is
  utterance(1.16, 0.30, 200, 240, 0.55),   // your
  utterance(1.50, 0.34, 260, 300, 0.55),   // name
];
// A 250ms pause inside the sentence → "Hello" then "what is your name".
// The full prompt ends at ~1.84s + 1.2s silence = 3.04s.
writeWav(join(OUT, "hello-your-name.wav"), render(helloUtterance, 3.2));

// 2. "And what are you looking for today" — second turn (context follow-up).
const secondUtterance = [
  utterance(0.10, 0.20, 180, 150, 0.50),   // And
  utterance(0.34, 0.22, 220, 180, 0.50),   // what
  utterance(0.60, 0.18, 170, 150, 0.45),   // are
  utterance(0.82, 0.28, 200, 240, 0.55),   // you
  utterance(1.14, 0.30, 240, 260, 0.55),   // look
  utterance(1.46, 0.24, 230, 200, 0.50),   // ing
  utterance(1.74, 0.22, 190, 170, 0.45),   // for
  utterance(2.00, 0.30, 250, 280, 0.55),   // to
  utterance(2.34, 0.32, 280, 300, 0.55),   // day
];
writeWav(join(OUT, "second-turn.wav"), render(secondUtterance, 3.6));

// 3. "Could you tell me more about the warranty" — third turn.
const thirdUtterance = [
  utterance(0.10, 0.26, 190, 160, 0.50),   // Could
  utterance(0.40, 0.20, 170, 150, 0.45),   // you
  utterance(0.64, 0.28, 210, 240, 0.55),   // tell
  utterance(0.96, 0.20, 180, 160, 0.45),   // me
  utterance(1.20, 0.24, 200, 220, 0.50),   // more
  utterance(1.48, 0.28, 230, 250, 0.55),   // a
  utterance(1.80, 0.22, 210, 190, 0.50),   // bout
  utterance(2.06, 0.24, 190, 180, 0.45),   // the
  utterance(2.34, 0.36, 260, 300, 0.60),   // war
  utterance(2.74, 0.30, 240, 220, 0.50),   // ran
  utterance(3.06, 0.28, 200, 220, 0.45),   // ty
];
writeWav(join(OUT, "third-turn.wav"), render(thirdUtterance, 4.2));

// 4. LONG utterance with a SHORT 300ms mid-pause (to prove a natural pause
//    does NOT prematurely end the turn) then continued speech, end 1.5s.
const pauseUtterance = [
  utterance(0.10, 0.30, 220, 260, 0.55),   // Let
  utterance(0.42, 0.24, 230, 210, 0.50),   // me
  utterance(0.70, 0.34, 250, 280, 0.60),   // think
  // 300ms pause here
  utterance(1.35, 0.28, 210, 240, 0.50),   // a
  utterance(1.66, 0.30, 240, 260, 0.55),   // bout
  utterance(2.00, 0.26, 220, 250, 0.50),   // it
  utterance(2.30, 0.24, 200, 230, 0.45),   // for
  utterance(2.58, 0.30, 260, 290, 0.55),   // a
  utterance(2.92, 0.28, 250, 270, 0.50),   // second
];
writeWav(join(OUT, "short-pause-utterance.wav"), render(pauseUtterance, 4.6));

console.log("Generated test audio in", OUT);
for (const f of ["hello-your-name.wav", "second-turn.wav", "third-turn.wav", "short-pause-utterance.wav"]) {
  const p = join(OUT, f);
  const { statSync } = await import("node:fs");
  console.log(`  ${f}: ${statSync(p).size} bytes`);
}
