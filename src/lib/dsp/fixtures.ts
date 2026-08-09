/**
 * BOLO — Synthetic PCM Test Fixtures
 *
 * Deterministic 16 kHz PCM generators for the negative controls (normal
 * fluent speech that MUST be rejected) and the positive fixtures (real
 * disfluency shapes that MUST be confirmed). The fixture parameters are
 * controlled so the measured features the harness prints are meaningful —
 * the point is not "the fixture passes", it is "the detector's own
 * measurements separate the classes". Thresholds are then tuned from those
 * measurements (see harness.ts), never blindly.
 */

import { SAMPLE_RATE } from "./features";

export interface FixtureDef {
  name: string;
  /** Expected outcome the fixture was designed for. */
  expect: "confirmed" | "rejected";
  description: string;
  make: () => Float32Array;
}

const TAU = Math.PI * 2;

/** Linear attack/release amplitude envelope. */
function env(t: number, dur: number, attack = 0.02, release = 0.06): number {
  if (t < attack) return t / attack;
  if (t > dur - release) return Math.max(0, (dur - t) / release);
  return 1;
}

/** Silence with optional residual room-tone noise (rms ≈ noiseLevel). */
export function silence(durMs: number, noiseLevel = 0.001): Float32Array {
  const n = Math.round((durMs / 1000) * SAMPLE_RATE);
  const out = new Float32Array(n);
  // Deterministic pseudo-noise (mulberry32)
  let seed = 12345;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < n; i++) out[i] = (rand() * 2 - 1) * noiseLevel * 0.35;
  return out;
}

export interface VowelOpts {
  f0: number;
  f1: number;
  f2: number;
  f1Bw?: number;
  f2Bw?: number;
  amp?: number;
  vibratoHz?: number;
  vibratoDepth?: number;
  /** Formant drift in Hz over the duration (raises centroid variance/flux). */
  driftHz?: number;
  /** Amplitude modulation (raises rms variance). */
  amHz?: number;
  amDepth?: number;
}

/** A sustained vowel: harmonics shaped by formant peaks. */
export function vowel(durMs: number, o: VowelOpts): Float32Array {
  const dur = durMs / 1000;
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  const f1Bw = o.f1Bw ?? 120;
  const f2Bw = o.f2Bw ?? 240;
  const amp = o.amp ?? 0.14;
  const harmonics = 28;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const prog = t / dur; // 0..1
    const drift = (o.driftHz ?? 0) * prog;
    const f0 = o.f0 * (1 + (o.vibratoDepth ?? 0) * Math.sin(TAU * (o.vibratoHz ?? 0) * t));
    const f1 = o.f1 + drift;
    const f2 = o.f2 + drift * 0.6;
    const am = 1 - (o.amDepth ?? 0) * (0.5 + 0.5 * Math.sin(TAU * (o.amHz ?? 0) * t));
    let s = 0;
    for (let h = 1; h <= harmonics; h++) {
      const fh = f0 * h;
      const shape =
        Math.exp(-(((fh - f1) / f1Bw) ** 2)) + 0.45 * Math.exp(-(((fh - f2) / f2Bw) ** 2));
      s += shape * Math.sin(TAU * fh * t + h * 0.7);
    }
    out[i] = s * amp * am * env(t, dur, 0.03, 0.08) * 0.02;
  }
  return out;
}

/** A nasal consonant ("m"/"n"): low-frequency tone + slight noise. */
export function nasal(durMs: number, amp = 0.1): Float32Array {
  const dur = durMs / 1000;
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let seed = 777;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const tone = Math.sin(TAU * 220 * t) * 0.6 + Math.sin(TAU * 440 * t) * 0.15;
    const noise = (rand() * 2 - 1) * 0.25;
    out[i] = (tone * 0.8 + noise) * amp * env(t, dur, 0.015, 0.04) * 0.12;
  }
  return out;
}

export interface FricOpts {
  amp?: number;
  /** High-pass the noise to push the centroid up (sibilant "s"). */
  highpass?: boolean;
  /** Low-pass for softer fricatives ("sh" / "f"). */
  lowpass?: boolean;
}

/** A fricative: shaped noise with a controllable spectral tilt. */
export function fricative(durMs: number, o: FricOpts = {}): Float32Array {
  const dur = durMs / 1000;
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let seed = 4242;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const amp = o.amp ?? 0.1;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    let x = rand() * 2 - 1;
    if (o.lowpass) x = prev * 0.6 + x * 0.4; // smooth → low centroid
    if (o.highpass) x = x - prev * 0.85; // differencing → high centroid
    prev = x;
    out[i] = x * amp * env(t, dur, 0.02, 0.05);
  }
  return out;
}

/** A short plosive release burst ("k"/"t"). */
export function burst(durMs: number, amp = 0.16): Float32Array {
  const dur = durMs / 1000;
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let seed = 999;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    out[i] = (rand() * 2 - 1) * amp * Math.exp(-t * 40);
  }
  return out;
}

/** Concatenate parts with inter-part gaps of room tone. */
export function concat(parts: (Float32Array | { gapMs: number; noise?: number })[]): Float32Array {
  const out: number[] = [];
  for (const p of parts) {
    if (p instanceof Float32Array) {
      for (let i = 0; i < p.length; i++) out.push(p[i]);
    } else {
      const gap = silence(p.gapMs, p.noise ?? 0.001);
      for (let i = 0; i < gap.length; i++) out.push(gap[i]);
    }
  }
  return new Float32Array(out);
}

// ─── Fixture library ────────────────────────────────────────────────────

export const FIXTURES: FixtureDef[] = [
  // ── NEGATIVE CONTROLS — fluent speech that MUST NOT confirm ──────────
  {
    name: "mama",
    expect: "rejected",
    description: "fluent 'mama' — two syllables, 2nd softer with pitch declination",
    make: () => {
      const ma1 = concat([nasal(90), vowel(150, { f0: 130, f1: 720, f2: 1150 })]);
      const ma2 = concat([nasal(80), vowel(140, { f0: 108, f1: 720, f2: 1150, amp: 0.09 })]);
      return concat([ma1, { gapMs: 60 }, ma2, { gapMs: 500 }]);
    },
  },
  {
    name: "hello",
    expect: "rejected",
    description: "fluent 'hello' — 'he' and 'lo' differ spectrally",
    make: () => {
      const he = concat([fricative(70, { highpass: true, amp: 0.08 }), vowel(130, { f0: 140, f1: 480, f2: 2100 })]);
      const lo = concat([vowel(120, { f0: 118, f1: 380, f2: 850 }), vowel(90, { f0: 112, f1: 520, f2: 950 })]);
      return concat([he, { gapMs: 40 }, lo, { gapMs: 500 }]);
    },
  },
  {
    name: "wow",
    expect: "rejected",
    description: "fluent 'wow' — 'wo' then 'w' glide, different spectra",
    make: () => {
      const wo = concat([vowel(60, { f0: 150, f1: 420, f2: 900 }), vowel(130, { f0: 150, f1: 700, f2: 1150 })]);
      const w = concat([vowel(70, { f0: 120, f1: 380, f2: 800 }), vowel(120, { f0: 120, f1: 650, f2: 1200 })]);
      return concat([wo, { gapMs: 30 }, w, { gapMs: 500 }]);
    },
  },
  {
    name: "rare",
    expect: "rejected",
    description: "fluent 'rare' — /r/ onset vs /r/ vowel, differing shape",
    make: () => {
      const ra = concat([vowel(70, { f0: 170, f1: 380, f2: 1400 }), vowel(140, { f0: 170, f1: 620, f2: 1500 })]);
      const re2 = concat([vowel(60, { f0: 150, f1: 380, f2: 1400 }), vowel(130, { f0: 150, f1: 620, f2: 1500 })]);
      return concat([ra, { gapMs: 50 }, re2, { gapMs: 500 }]);
    },
  },
  {
    name: "a baby",
    expect: "rejected",
    description: "fluent 'a baby' — 3 syllables, irregular, spectrally distinct",
    make: () => {
      const a = vowel(90, { f0: 140, f1: 800, f2: 1300, amp: 0.08 });
      const ba = concat([burst(25, 0.14), vowel(120, { f0: 130, f1: 700, f2: 1150 })]);
      const by = concat([burst(25, 0.12), vowel(110, { f0: 170, f1: 420, f2: 2300 })]);
      return concat([a, { gapMs: 120 }, ba, { gapMs: 90 }, by, { gapMs: 500 }]);
    },
  },
  {
    name: "normal conversation",
    expect: "rejected",
    description: "natural sentence — varied syllables, prosody, one pause",
    make: () => {
      const i = vowel(100, { f0: 150, f1: 800, f2: 1300, amp: 0.09 });
      const want = concat([vowel(60, { f0: 145, f1: 550, f2: 1100 }), fricative(60, { lowpass: true, amp: 0.07 }), burst(30, 0.13), vowel(70, { f0: 140, f1: 600, f2: 1100 })]);
      const to = concat([burst(20, 0.11), vowel(60, { f0: 130, f1: 500, f2: 1150 })]);
      const go = concat([burst(25, 0.15), vowel(150, { f0: 155, f1: 680, f2: 1050 })]);
      const home = concat([fricative(50, { highpass: true, amp: 0.08 }), vowel(110, { f0: 165, f1: 520, f2: 800 }), nasal(80), vowel(60, { f0: 130, f1: 720, f2: 1200 })]);
      return concat([i, { gapMs: 60 }, want, { gapMs: 50 }, to, { gapMs: 40 }, go, { gapMs: 180 }, home, { gapMs: 500 }]);
    },
  },
  {
    name: "normal pause",
    expect: "rejected",
    description: "speech → 520ms pause with residual room tone → speech",
    make: () => {
      const word1 = concat([nasal(80), vowel(150, { f0: 130, f1: 720, f2: 1150 })]);
      const word2 = concat([nasal(80), vowel(150, { f0: 128, f1: 720, f2: 1150 })]);
      // Residual room tone 0.006 — a real pause is NOT total silence, so the
      // choke's near-silence gate (interruption of phonation) must reject it.
      return concat([word1, { gapMs: 520, noise: 0.006 }, word2, { gapMs: 500 }]);
    },
  },
  {
    name: "normal long vowel",
    expect: "rejected",
    description: "sustained 'aaah' with strong formant drift + amplitude wobble",
    make: () =>
      vowel(600, {
        f0: 140,
        f1: 700,
        f2: 1150,
        driftHz: 800,
        amHz: 6,
        amDepth: 0.22,
        vibratoHz: 5,
        vibratoDepth: 0.05,
      }),
  },
  {
    name: "sss normal phoneme",
    expect: "rejected",
    description: "short 'sss' (250ms) — a normal sibilant, not a prolongation",
    make: () => concat([fricative(250, { highpass: true, amp: 0.09 }), { gapMs: 500 }]),
  },

  // ── POSITIVE FIXTURES — real disfluency shapes that MUST confirm ─────
  {
    name: "ma-ma-mac",
    expect: "confirmed",
    description: "2-unit sound repetition before the word (ma-ma-mac)",
    make: () => {
      const ma = concat([nasal(60), vowel(90, { f0: 140, f1: 720, f2: 1150 })]);
      const mac = concat([nasal(70), vowel(120, { f0: 135, f1: 720, f2: 1150 }), burst(30, 0.12)]);
      // ma —(140ms)— ma —(150ms)— mac  (regular ~145ms gaps, brief units)
      return concat([ma, { gapMs: 90 }, ma, { gapMs: 95 }, mac, { gapMs: 500 }]);
    },
  },
  {
    name: "ma-ma-ma-mac",
    expect: "confirmed",
    description: "3-unit sound repetition before the word",
    make: () => {
      const ma = concat([nasal(55), vowel(85, { f0: 140, f1: 720, f2: 1150 })]);
      const mac = concat([nasal(70), vowel(120, { f0: 135, f1: 720, f2: 1150 }), burst(30, 0.12)]);
      return concat([ma, { gapMs: 90 }, ma, { gapMs: 95 }, ma, { gapMs: 95 }, mac, { gapMs: 500 }]);
    },
  },
  {
    name: "ssssssstop",
    expect: "confirmed",
    description: "prolonged fricative (560ms) releasing into 'op'",
    make: () => concat([fricative(560, { highpass: true, amp: 0.1 }), vowel(140, { f0: 150, f1: 620, f2: 1050 }), { gapMs: 500 }]),
  },
  {
    name: "short s",
    expect: "rejected",
    description: "short 'sss' (300ms) — below the 450ms prolongation floor",
    make: () => concat([fricative(300, { highpass: true, amp: 0.1 }), vowel(120, { f0: 150, f1: 620, f2: 1050 }), { gapMs: 500 }]),
  },
  {
    name: "aaaaaa",
    expect: "confirmed",
    description: "prolonged stable vowel (540ms) — vowel/voiced prolongation",
    make: () =>
      vowel(540, {
        f0: 135,
        f1: 720,
        f2: 1150,
        vibratoHz: 5,
        vibratoDepth: 0.02,
        driftHz: 40,
      }),
  },
  {
    name: "block fixture",
    expect: "confirmed",
    description: "speech → 520ms total silence → sharp release (block)",
    make: () => {
      const word = concat([nasal(80), vowel(160, { f0: 130, f1: 720, f2: 1150 })]);
      // True interruption: silence floor 0.0005 (near-total), then hard onset
      return concat([word, silence(520, 0.0005), nasal(70), vowel(150, { f0: 132, f1: 720, f2: 1150 }), { gapMs: 500 }]);
    },
  },
];

export function getFixture(name: string): FixtureDef | undefined {
  return FIXTURES.find((f) => f.name === name);
}
