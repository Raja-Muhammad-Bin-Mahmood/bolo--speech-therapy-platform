/**
 * BOLO — Deepgram Disfluency Detector + Lexical Normalizer
 *
 * DETECTION operates on the RAW Deepgram token FIRST (never on the
 * normalized form). When a disfluency is confirmed the raw output is then
 * normalized to its intended lexical word so the LIVE TRANSCRIPT never
 * shows phonetic stutter spellings ("ssssslap", "b-b-ball", "mmmmmac").
 *
 * Classified types (metadata for later analytics; the transcript-routing
 * layer only needs `isDisfluency: true`):
 *   1. sound_repetition   — "b-b-ball", "st-st-start", "ma-ma-mac"
 *   2. prolongation       — "sooooo", "aaaand", "ssssslap"
 *   3. filler             — "um", "uh", "er", "erm", "ah" …
 *   4. word_repetition    — "I I I", "the the" (intra-token form)
 *   5. phrase_repetition  — detected at sequence level (hook)
 *   6. revision           — abandoned/revised word (hook, interim-vs-final)
 *   7. block              — Deepgram word-timing gap gated by the BOLO
 *      RMS/isSpeaking energy gate (hook) so ordinary silence is NOT a block
 */

export type DeepgramDisfluencyType =
  | "sound_repetition"
  | "prolongation"
  | "filler"
  | "word_repetition"
  | "phrase_repetition"
  | "revision"
  | "block";

export interface DeepgramDisfluencyVerdict {
  isDisfluency: boolean;
  disfluencyType?: DeepgramDisfluencyType;
}

// ─── Fillers (filler_words=true keeps them in the word stream) ──────────

const FILLERS = new Set([
  "um",
  "umm",
  "uhm",
  "uh",
  "uhh",
  "er",
  "erm",
  "ah",
  "mm",
  "mhm",
  "hmm",
  "eh",
  "hm",
]);

function coreLetters(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z]/g, "");
}

function isFiller(raw: string): boolean {
  return FILLERS.has(coreLetters(raw));
}

// ─── Sound repetition: repeated onset fragments before the completed word
//     "b-b-ball", "st-st-start", "ma-ma-mac", "ss-s-s-slap" ───────────────

function isSoundRepetition(raw: string): boolean {
  if (!raw.includes("-")) return false;
  const segments = raw.split("-").filter(Boolean);
  if (segments.length < 2) return false;
  const last = segments[segments.length - 1].toLowerCase();
  const prev = segments.slice(0, -1).map((s) => s.toLowerCase());
  if (!last) return false;
  // The completed word is the final segment; earlier fragments must be
  // prefixes of it and repeat (b-b-ball → "b" twice + "ball" starts "b").
  const prefixOk = prev.every((s) => last.startsWith(s) || s.startsWith(last));
  if (!prefixOk) return false;
  // Require an actual repetition: ≥2 equal fragments, or 2+ fragments and
  // the final word starts with the fragment (b-b-ball, st-st-start).
  if (prev.length >= 2 && prev[0] === prev[1]) return true;
  if (prev.some((s) => s.length > 0 && last.startsWith(s))) return true;
  return false;
}

// ─── Prolongation: a run of 3+ identical characters ("sooooo", "ssssslap",
//     "aaaand", "mmmmmac"). Legit double letters ("ball", "happy") pass. ────

const PROLONG_RUN = /(.)\1{2,}/;

function isProlongation(raw: string): boolean {
  return PROLONG_RUN.test(raw);
}

// ─── Word repetition inside ONE token: "I I I", "the the", "no no no" ────

function isIntraTokenWordRepetition(raw: string): boolean {
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  const lower = parts.map((p) => coreLetters(p));
  // Any two CONSECUTIVE identical tokens = repeated word.
  for (let i = 1; i < lower.length; i++) {
    if (lower[i].length > 0 && lower[i] === lower[i - 1]) return true;
  }
  return false;
}

/**
 * Classify a RAW Deepgram word token. Detection must run on the raw form —
 * normalization happens AFTER detection, and only for confirmed
 * disfluencies.
 */
export function classifyDeepgramWord(raw: string): DeepgramDisfluencyVerdict {
  const cleaned = raw.trim();
  if (!cleaned) return { isDisfluency: false };

  if (isFiller(cleaned)) return { isDisfluency: true, disfluencyType: "filler" };
  if (isSoundRepetition(cleaned)) {
    return { isDisfluency: true, disfluencyType: "sound_repetition" };
  }
  if (isProlongation(cleaned)) {
    return { isDisfluency: true, disfluencyType: "prolongation" };
  }
  if (isIntraTokenWordRepetition(cleaned)) {
    return { isDisfluency: true, disfluencyType: "word_repetition" };
  }
  return { isDisfluency: false };
}

// ─── Lexical normalization (display layer only) ─────────────────────────
//
// Pipeline: hyphenated onset fragments → completed word, then collapse
// prolongation runs. The result is the intended lexical word:
//   "sssslap"     → "slap"
//   "ss-s-s-slap" → "slap"
//   "b-b-ball"    → "ball"
//   "mmmmmac"     → "mac"
//   "sooooo"      → "so"
//   "aaaand"      → "and"
// Case is preserved from the completed segment.

export function normalizeLexicalWord(raw: string): string {
  let w = raw.trim();
  if (!w) return "";

  // 1) Hyphenated onset fragments → take the completed (last) segment.
  if (w.includes("-")) {
    const segments = w.split("-").filter(Boolean);
    if (segments.length >= 2) {
      w = segments[segments.length - 1];
    }
  }

  // 2) Collapse prolongation runs of 3+ identical chars to a single char.
  let out = "";
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    let j = i;
    while (j + 1 < w.length && w[j + 1] === c) {
      j++;
    }
    const runLen = j - i + 1;
    if (runLen >= 3) {
      out += c; // single char — the intended sound
    } else {
      out += w.slice(i, j + 1);
    }
    i = j;
  }

  return out;
}
