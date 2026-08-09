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

// ════════════════════════════════════════════════════════════════════════
//  Structured WordToken + persistent detector (spec pipeline)
//
//  Deepgram response → WordToken → DisfluencyDetector.processToken →
//  DisfluencyTag → TranscriptToken.disfluency → LIVE TRANSCRIPT renderer
//  → purple underline.
//
//  The DETECTOR is a persistent, history-aware instance (one per recording
//  session). It evaluates:
//    A. sound_repetition — repeated onset fragments ("b-b-ball") on RAW
//       evidence, BEFORE lexical normalization destroys it
//    B. prolongation     — repeated characters ("ssssslap") on RAW evidence,
//       plus BOLO acoustic/DSP corroboration when Deepgram already
//       normalized the spelling away ("ssssslap" → "slap")
//    C. word_repetition  — consecutive identical normalized finals
//       ("you you you know", "I I I")
//    D. phrase_repetition— a repeated 2–3 word sequence ("I want I want")
//    E. revision         — abandoned/restarted word (interim vs final)
//    F. block            — word-timing gap gated by the BOLO RMS/isSpeaking
//       gate (a Deepgram LEXICAL block tag — NOT the acoustic DSP block
//       event system, which is left untouched)
//  ════════════════════════════════════════════════════════════════════════

export interface DeepgramWordToken {
  /** Displayed lexical word (punctuated when the API provides it). */
  word: string;
  /** Lowercased, punctuation-stripped comparison form. */
  normalizedWord: string;
  /** Raw API word output — detection/debugging only (never displayed). */
  rawWord?: string;
  /** Session-relative milliseconds (shared BOLO session clock). */
  startTimeMs: number;
  endTimeMs: number;
  confidence: number;
  source: "deepgram";
  isFinal: true;
}

export interface DeepgramDisfluencyTag {
  type: DeepgramDisfluencyType;
  confidence: number;
}

export interface DeepgramProcessedToken {
  token: DeepgramWordToken;
  /** Structured tag when a rule matched, otherwise null. */
  disfluency: DeepgramDisfluencyTag | null;
  /** Rule family that produced the tag ("none" when fluent). Debug only. */
  rule: DeepgramDisfluencyType | "none";
  /**
   * Every rule family evaluated for this token, IN ORDER (A sound
   * repetition + B prolongation + filler are grouped as the raw-spelling
   * pass; then C word repetition, D phrase repetition, E revision, F
   * block, then acoustic corroboration). Trace/debug only — the LIVE
   * TRANSCRIPT renderer never reads this.
   */
  evaluated: DeepgramDisfluencyType[];
  /**
   * The BOLO acoustic/DSP-lane evidence mapped for this token (echo of the
   * `ctx.acousticEvidence` input; null when the pool had nothing in
   * tolerance). Lets the trace log show exactly what acoustic evidence
   * existed when no lexical/timing rule matched.
   */
  acousticEvidence: DeepgramDisfluencyType | null;
}

export interface DeepgramDetectorContext {
  /**
   * BOLO acoustic/DSP-lane evidence overlapping this token, mapped to the
   * closest Deepgram type (a prolongation event → "prolongation", a
   * stutter/stammer/repetition event → "sound_repetition", a block event
   * → "block"). Used when Deepgram already normalized the phonetic stutter
   * away ("ssssslap" → "slap") so the lexical string carries no evidence.
   */
  acousticEvidence?: DeepgramDisfluencyType | null;
}

export interface DeepgramDetectorOptions {
  /** BOLO RMS/isSpeaking gate — ordinary silence is NOT a block. */
  isSpeaking?: () => boolean;
  /** Word-timing gap ABOVE which a block is considered (ms). */
  blockMinGapMs?: number;
  /** Gaps larger than this are silence/utterance breaks, never blocks (ms). */
  blockMaxGapMs?: number;
  /** Word-repetition window: same normalized word within this time (ms). */
  repeatWindowMs?: number;
  /** Phrase-repetition lookback window (ms). */
  phraseWindowMs?: number;
  /** Keep finalized-token history for this long (ms). */
  historyWindowMs?: number;
  /** Revision tolerance: interim word within this of token start (ms). */
  revisionToleranceMs?: number;
}

const DEFAULT_DETECTOR_OPTIONS = {
  blockMinGapMs: 450,
  blockMaxGapMs: 2500,
  repeatWindowMs: 1500,
  phraseWindowMs: 4000,
  historyWindowMs: 8000,
  revisionToleranceMs: 350,
} satisfies Required<
  Omit<DeepgramDetectorOptions, "isSpeaking">
>;

const RULE_CONFIDENCE: Record<DeepgramDisfluencyType, number> = {
  sound_repetition: 0.92,
  prolongation: 0.9,
  filler: 0.95,
  word_repetition: 0.9,
  phrase_repetition: 0.85,
  revision: 0.8,
  block: 0.85,
};

/**
 * AUTHORITATIVE DEEPGRAM VERDICT (free-speech rule).
 *
 * The RAW token Deepgram returns for a word IS Deepgram's own verdict on
 * how that word was spoken. When that raw form itself exhibits disfluency —
 * a filler ("um", "uh", "er"), a hyphenated sound repetition ("b-b-ball",
 * "st-st-start", "ma-ma-mac"), a prolongation run ("ssssslap", "sooooo"),
 * or an intra-token word repetition ("I I I", "the the") — this returns
 * the structured tag IMMEDIATELY and UNCONDITIONALLY.
 *
 * No confidence-band / zHR / A-level / evidence-fusion visibility floor
 * ever gates this verdict: if Deepgram's own output for the word is
 * disfluent, the word IS a disfluency and the live transcript underlines
 * it. The BOLO sequence detector (rules C–F) and acoustic corroboration
 * remain only as a BACKSTOP for words Deepgram already normalized clean
 * ("ssssslap" → "slap"), where the raw token carries no evidence.
 */
export function classifyDeepgramVerdict(
  raw: string
): DeepgramDisfluencyTag | null {
  const verdict = classifyDeepgramWord(raw);
  if (!verdict.isDisfluency || !verdict.disfluencyType) return null;
  return {
    type: verdict.disfluencyType,
    confidence: RULE_CONFIDENCE[verdict.disfluencyType],
  };
}

interface RecentFinal {
  norm: string;
  raw: string;
  startMs: number;
}

export class DeepgramDisfluencyDetector {
  private opts: Required<
    Omit<DeepgramDetectorOptions, "isSpeaking">
  > & { isSpeaking: () => boolean };
  /** Recent finalized Deepgram words — sequence-level rule context. */
  private recent: RecentFinal[] = [];
  /** Latest interim hypothesis — revision (abandoned word) detection. */
  private interim: { norm: string; startMs: number }[] = [];
  /** End of the previous finalized word — block (timing gap) detection. */
  private lastWordEndMs: number | null = null;

  constructor(options: DeepgramDetectorOptions = {}) {
    this.opts = {
      ...DEFAULT_DETECTOR_OPTIONS,
      ...options,
      isSpeaking: options.isSpeaking ?? (() => true),
    };
  }

  /** Replace the latest interim hypothesis (revision detection input). */
  setInterim(words: { norm: string; startMs: number }[]): void {
    this.interim = words;
  }

  /** New recording session → drop all history. */
  reset(): void {
    this.recent = [];
    this.interim = [];
    this.lastWordEndMs = null;
  }

  /**
   * Rebase every internally-tracked timestamp onto a new axis (the shared
   * session-clock pin event). When the ASR origin lands, the session clock
   * shifts every provisional timestamp by the same delta
   * (sessionTime = provisionalTime − shift); the detector's history
   * (finalized words, interim hypothesis, previous-word end) must move with
   * it so the sequence rules (C word repetition, D phrase repetition,
   * F block) keep comparing times on ONE axis.
   */
  rebase(deltaMs: number): void {
    if (deltaMs === 0) return;
    this.recent = this.recent.map((r) => ({
      ...r,
      startMs: r.startMs + deltaMs,
    }));
    this.interim = this.interim.map((i) => ({
      ...i,
      startMs: i.startMs + deltaMs,
    }));
    if (this.lastWordEndMs != null) this.lastWordEndMs += deltaMs;
  }

  private tag(type: DeepgramDisfluencyType): DeepgramDisfluencyTag {
    return { type, confidence: RULE_CONFIDENCE[type] };
  }

  // A + B (+ filler): single-token rules on RAW evidence. Detection runs
  // on the raw form FIRST — normalization happens later, so lexical
  // normalization never destroys "b-b-ball" / "ssssslap" evidence.
  private classifyRaw(raw: string): DeepgramDisfluencyTag | null {
    const verdict = classifyDeepgramWord(raw);
    if (!verdict.isDisfluency || !verdict.disfluencyType) return null;
    return this.tag(verdict.disfluencyType);
  }

  // C. Word repetition — consecutive identical normalized finals.
  private wordRepetition(token: DeepgramWordToken): boolean {
    const prev = this.recent[this.recent.length - 1];
    if (!prev) return false;
    return (
      token.normalizedWord.length > 0 &&
      prev.norm.length > 0 &&
      prev.norm === token.normalizedWord &&
      token.startTimeMs - prev.startMs <= this.opts.repeatWindowMs
    );
  }

  // D. Phrase repetition — a 2–3 word sequence that occurred earlier
  //    ("I want I want", "I have to I have to").
  private phraseRepetition(token: DeepgramWordToken): boolean {
    const recent = this.recent;
    if (recent.length < 2) return false;
    const { phraseWindowMs } = this.opts;
    for (const span of [2, 3] as const) {
      if (recent.length < span) continue;
      // Current gram = last (span-1) history words + this token.
      const gram = recent
        .slice(recent.length - (span - 1))
        .map((r) => r.norm)
        .concat(token.normalizedWord);
      // The previous occurrence must sit fully BEFORE the current gram's
      // history window (indices [len-(span-1), len-1]).
      const gramHistoryStart = recent.length - (span - 1);
      const maxStart = gramHistoryStart - span;
      if (maxStart < 0) continue;
      for (let i = 0; i <= maxStart; i++) {
        let match = true;
        for (let k = 0; k < span; k++) {
          if (recent[i + k].norm !== gram[k]) {
            match = false;
            break;
          }
        }
        if (!match) continue;
        const prevLastStart = recent[i + span - 1].startMs;
        if (token.startTimeMs - prevLastStart <= phraseWindowMs) return true;
      }
    }
    return false;
  }

  // E. Revision — an interim word occupied this interval with a DIFFERENT
  //    lexical form (the speaker abandoned/restarted the word).
  private revision(token: DeepgramWordToken): boolean {
    const { revisionToleranceMs } = this.opts;
    return this.interim.some(
      (iw) =>
        iw.norm !== token.normalizedWord &&
        Math.abs(iw.startMs - token.startTimeMs) <= revisionToleranceMs
    );
  }

  // F. Block — Deepgram word-timing gap gated by the BOLO RMS/isSpeaking
  //    gate so ordinary silence is NOT a block.
  private block(token: DeepgramWordToken): boolean {
    if (this.lastWordEndMs == null) return false;
    const gapMs = token.startTimeMs - this.lastWordEndMs;
    return (
      gapMs > this.opts.blockMinGapMs &&
      gapMs < this.opts.blockMaxGapMs &&
      this.opts.isSpeaking()
    );
  }

  /**
   * Process ONE finalized Deepgram word. Returns the token with a structured
   * `disfluency` tag when a rule matched (this is the data the LIVE
   * TRANSCRIPT renderer reads — the underline is driven by `disfluency !=
   * null`, never by the Detection Feed).
   */
  processToken(
    token: DeepgramWordToken,
    ctx?: DeepgramDetectorContext
  ): DeepgramProcessedToken {
    const raw = token.rawWord ?? token.word;
    const evaluated: DeepgramDisfluencyType[] = [];
    let disfluency: DeepgramDisfluencyTag | null = null;
    let rule: DeepgramDisfluencyType | "none" = "none";

    // A + B + filler: single-token rules on RAW evidence. Detection runs on
    // the raw form FIRST — normalization happens later, so lexical
    // normalization never destroys "b-b-ball" / "ssssslap" evidence.
    disfluency = this.classifyRaw(raw);
    if (disfluency) {
      rule = disfluency.type;
    } else {
      // Record that the raw-spelling pass evaluated (and did NOT match) —
      // the trace log needs to show WHY a normalized word wasn't flagged.
      evaluated.push("sound_repetition", "prolongation", "filler");
    }

    // C. Word repetition — consecutive identical normalized finals.
    if (!disfluency) {
      evaluated.push("word_repetition");
      if (this.wordRepetition(token)) {
        disfluency = this.tag("word_repetition");
        rule = "word_repetition";
      }
    }
    // D. Phrase repetition — a 2–3 word sequence that occurred earlier.
    if (!disfluency) {
      evaluated.push("phrase_repetition");
      if (this.phraseRepetition(token)) {
        disfluency = this.tag("phrase_repetition");
        rule = "phrase_repetition";
      }
    }
    // E. Revision — an interim word occupied this interval with a DIFFERENT
    //    lexical form (the speaker abandoned/restarted the word).
    if (!disfluency) {
      evaluated.push("revision");
      if (this.revision(token)) {
        disfluency = this.tag("revision");
        rule = "revision";
      }
    }
    // F. Block — Deepgram word-timing gap gated by the BOLO RMS/isSpeaking
    //    gate so ordinary silence is NOT a block.
    if (!disfluency) {
      evaluated.push("block");
      if (this.block(token)) {
        disfluency = this.tag("block");
        rule = "block";
      }
    }
    // Acoustic/DSP corroboration: Deepgram already normalized the phonetic
    // spelling away ("ssssslap" → "slap") — the BOLO acoustic lane carries
    // the evidence the lexical string no longer does.
    if (!disfluency && ctx?.acousticEvidence) {
      evaluated.push(ctx.acousticEvidence);
      disfluency = this.tag(ctx.acousticEvidence);
      rule = ctx.acousticEvidence;
    }

    // Keep EVERY final word as sequence context (fluent too).
    this.recent = [
      ...this.recent.filter(
        (r) => token.startTimeMs - r.startMs <= this.opts.historyWindowMs
      ),
      { norm: token.normalizedWord, raw, startMs: token.startTimeMs },
    ].slice(-60);
    this.lastWordEndMs = token.endTimeMs;

    return {
      token,
      disfluency,
      rule,
      evaluated,
      acousticEvidence: ctx?.acousticEvidence ?? null,
    };
  }
}
