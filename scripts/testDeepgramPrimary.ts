/**
 * BOLO — Deepgram PRIMARY pipeline verification harness.
 *
 * Traces the complete spec path:
 *   Deepgram raw word → structured WordToken → DeepgramDisfluencyDetector
 *   .processToken → structured DisfluencyTag → TranscriptToken.disfluency
 *   → reconcileIncoming → sorted token array → render-style output (WordSpan
 *   equivalent: NORMAL word + purple underline when `disfluency != null`).
 *
 * Uses the EXACT test utterances from the spec:
 *   1. "ssssslap" / "ssssl..." prolongation → renders "slap" + purple underline
 *   2. "b-b-ball" / "ma-ma-mac" repetition  → renders "ball"/"mac" + purple underline
 *   3. a normal fluent sentence → renders normally (no underline)
 *   4. word repetition "you you you know" → repeated token underlined
 *   5. phrase repetition "I want I want" → repeated phrase underlined
 *   6. block: timing gap while speaking → next word underlined "block"
 *   7. acoustic corroboration: Deepgram normalized "ssssslap"→"slap" but the
 *      acoustic lane carries a prolongation event → underlined "prolongation"
 */
import {
  DeepgramDisfluencyDetector,
  normalizeLexicalWord,
  type DeepgramWordToken,
} from "../src/lib/deepgramDisfluency";
import {
  reconcileIncoming,
  sortTokens,
  type TranscriptToken,
} from "../src/lib/transcriptTokens";

let uid = 0;
let tMs = 0;
function makeWordToken(raw: string): DeepgramWordToken {
  const start = tMs;
  const end = tMs + 350;
  tMs += 420;
  return {
    word: normalizeLexicalWord(raw),
    normalizedWord: normalizeLexicalWord(raw)
      .toLowerCase()
      .replace(/[^a-z0-9']/g, ""),
    rawWord: raw,
    startTimeMs: start,
    endTimeMs: end,
    confidence: 0.95,
    source: "deepgram",
    isFinal: true,
  };
}

/**
 * Process ONE word through the detector exactly once and produce the
 * TranscriptToken. Tests that need the detector verdict must use this
 * result — NEVER process the same word a second time (the detector is
 * history-aware and would see it as a word repetition).
 */
function makeDgToken(
  raw: string,
  detector: DeepgramDisfluencyDetector
): TranscriptToken {
  const processed = detector.processToken(makeWordToken(raw));
  return {
    id: `dg-${uid++}`,
    word: processed.token.word,
    rawWord: raw,
    startTimeMs: processed.token.startTimeMs,
    endTimeMs: processed.token.endTimeMs,
    source: "deepgram",
    isDisfluency: processed.disfluency != null,
    disfluency: processed.disfluency,
    locked: processed.disfluency != null,
    disfluencyType: processed.disfluency?.type,
    confidence: 0.95,
  };
}

/** Process once AND return { token, verdict } for checks that need both. */
function processOnce(
  raw: string,
  detector: DeepgramDisfluencyDetector,
  ctx?: { acousticEvidence?: import("../src/lib/deepgramDisfluency").DeepgramDisfluencyType | null }
) {
  const processed = detector.processToken(makeWordToken(raw), ctx);
  const token: TranscriptToken = {
    id: `dg-${uid++}`,
    word: processed.token.word,
    rawWord: raw,
    startTimeMs: processed.token.startTimeMs,
    endTimeMs: processed.token.endTimeMs,
    source: "deepgram",
    isDisfluency: processed.disfluency != null,
    disfluency: processed.disfluency,
    locked: processed.disfluency != null,
    disfluencyType: processed.disfluency?.type,
    confidence: 0.95,
  };
  return { token, verdict: processed.disfluency?.type ?? "none" };
}

function renderWord(t: TranscriptToken): string {
  const disfluent = t.disfluency != null || t.isDisfluency || t.locked;
  return disfluent
    ? `[${t.word} ⟍ PURPLE UNDERLINE (${t.disfluency?.type ?? t.disfluencyType ?? "disfluency"})]`
    : t.word;
}

let failures = 0;
function check(name: string, actual: string, expected: string) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) {
    console.log(`   expected: ${expected}`);
    console.log(`   actual:   ${actual}`);
  }
}

// ── 1. Prolongation: "sssslap" / "ssssl..." ────────────────────────────
{
  const det = new DeepgramDisfluencyDetector();
  const tok = makeWordToken("sssslap");
  const proc = det.processToken(tok);
  check("sssslap → detected prolongation", proc.disfluency?.type ?? "none", "prolongation");
  check("sssslap → normalized to 'slap'", normalizeLexicalWord("sssslap"), "slap");

  const token = makeDgToken("sssslap", new DeepgramDisfluencyDetector());
  const { tokens } = reconcileIncoming([], token);
  check("sssslap token disfluency=prolongation", tokens[0].disfluency?.type ?? "none", "prolongation");
  check("sssslap token isDisfluency=true", String(tokens[0].isDisfluency), "true");
  check("sssslap token locked=true", String(tokens[0].locked), "true");
  check("render: slap + purple underline", renderWord(tokens[0]), "[slap ⟍ PURPLE UNDERLINE (prolongation)]");
}

// ── 2. Sound repetition: "b-b-ball" / "ma-ma-mac" ───────────────────────
{
  const det = new DeepgramDisfluencyDetector();
  const proc = det.processToken(makeWordToken("b-b-ball"));
  check("b-b-ball → detected sound_repetition", proc.disfluency?.type ?? "none", "sound_repetition");
  check("b-b-ball → normalized to 'ball'", normalizeLexicalWord("b-b-ball"), "ball");

  const token = makeDgToken("b-b-ball", new DeepgramDisfluencyDetector());
  const { tokens } = reconcileIncoming([], token);
  check("b-b-ball renders ball + underline", renderWord(tokens[0]), "[ball ⟍ PURPLE UNDERLINE (sound_repetition)]");

  const det2 = new DeepgramDisfluencyDetector();
  check("ma-ma-mac → sound_repetition", det2.processToken(makeWordToken("ma-ma-mac")).disfluency?.type ?? "none", "sound_repetition");
  check("ma-ma-mac → 'mac'", normalizeLexicalWord("ma-ma-mac"), "mac");
}

// ── 3. Normal fluent sentence ───────────────────────────────────────────
{
  const det = new DeepgramDisfluencyDetector();
  const tokens: TranscriptToken[] = [];
  for (const w of ["So", "hello", "there", "my", "name", "is", "Alex"]) {
    const { tokens: next } = reconcileIncoming(tokens, makeDgToken(w, det));
    tokens.length = 0;
    tokens.push(...next);
  }
  const sorted = sortTokens(tokens);
  const rendered = sorted.map(renderWord).join(" ");
  check("fluent sentence renders normally", rendered, "So hello there my name is Alex");
  check("fluent words are NOT disfluent", String(sorted.some((t) => t.disfluency != null)), "false");
}

// ── 4. Word repetition: "you you you know" ──────────────────────────────
{
  const det = new DeepgramDisfluencyDetector();
  const tokens: TranscriptToken[] = [];
  const reps: string[] = [];
  for (const w of ["you", "you", "you", "know"]) {
    const { token, verdict } = processOnce(w, det);
    reps.push(verdict);
    const { tokens: next } = reconcileIncoming(tokens, token);
    tokens.length = 0;
    tokens.push(...next);
  }
  check("you→you→you word_repetition on 2nd+3rd", reps.join(","), "none,word_repetition,word_repetition,none");
  const rendered = sortTokens(tokens).map(renderWord).join(" ");
  check("word repetition renders clean + underlined", rendered, "you [you ⟍ PURPLE UNDERLINE (word_repetition)] [you ⟍ PURPLE UNDERLINE (word_repetition)] know");
}

// ── 5. Phrase repetition: "I want I want" ───────────────────────────────
{
  const det = new DeepgramDisfluencyDetector();
  const types: string[] = [];
  for (const w of ["I", "want", "I", "want"]) {
    const { verdict } = processOnce(w, det);
    types.push(verdict);
  }
  check("phrase repetition 'I want I want'", types.join(","), "none,none,none,phrase_repetition");
}

// ── 6. Block: timing gap while speaking → next word underlined ──────────
{
  const det = new DeepgramDisfluencyDetector({ isSpeaking: () => true });
  det.processToken(makeWordToken("hello")); // fluent, sets lastWordEndMs
  tMs += 900; // gap of ~900ms while speaking → block
  const proc = det.processToken(makeWordToken("world"));
  check("timing gap + speaking → block tag", proc.disfluency?.type ?? "none", "block");
}

// ── 7. Acoustic corroboration: DG normalized "ssssslap"→"slap" ──────────
{
  // Deepgram returns the CLEAN word "slap" (it already normalized the
  // prolongation away) — but BOLO's acoustic lane independently detected a
  // prolongation overlapping this word. The detector must tag it.
  const det = new DeepgramDisfluencyDetector();
  const { token, verdict } = processOnce("slap", det, {
    acousticEvidence: "prolongation",
  });
  check("clean 'slap' + acoustic prolongation → prolongation tag", verdict, "prolongation");
  check("clean 'slap' renders slap + purple underline", renderWord(token), "[slap ⟍ PURPLE UNDERLINE (prolongation)]");
}

// ── 8. Full mixed flow: fluent + disfluent interleaved ──────────────────
{
  const det = new DeepgramDisfluencyDetector();
  const tokens: TranscriptToken[] = [];
  for (const w of ["So", "sssslap", "the", "b-b-ball", "is", "on", "the", "table"]) {
    const { tokens: next } = reconcileIncoming(tokens, makeDgToken(w, det));
    tokens.length = 0;
    tokens.push(...next);
  }
  const rendered = sortTokens(tokens).map(renderWord).join(" ");
  check(
    "mixed flow: normal words + underlined disfluencies, raw spellings never shown",
    rendered,
    "So [slap ⟍ PURPLE UNDERLINE (prolongation)] the [ball ⟍ PURPLE UNDERLINE (sound_repetition)] is on the table"
  );
  const rawShown = rendered.includes("sssslap") || rendered.includes("b-b-ball");
  check("raw phonetic spellings NEVER appear", String(rawShown), "false");
}

// ── 9. Speechmatics fallback: fills a gap, never overwrites locked DG ───
{
  // Deepgram "slap" (disfluent, locked) at 500ms
  const dg = makeDgToken("sssslap", new DeepgramDisfluencyDetector());
  const { tokens: withDg } = reconcileIncoming([], dg);
  // Speechmatics later says "rap" at the SAME slot — must be discarded
  const sm: TranscriptToken = {
    id: "sm-1",
    word: "rap",
    startTimeMs: withDg[0].startTimeMs + 20,
    endTimeMs: withDg[0].endTimeMs - 20,
    source: "speechmatics",
    isDisfluency: false,
    locked: false,
    confidence: 0.9,
  };
  const { tokens: afterSm, hiddenKeys } = reconcileIncoming(withDg, sm);
  check("SM 'rap' competing for locked DG slot is hidden", String(hiddenKeys.length > 0), "true");
  check("DG 'slap' still present after SM", String(afterSm.some((t) => t.source === "deepgram" && t.word === "slap")), "true");
  check("SM 'rap' NOT added as duplicate", String(afterSm.some((t) => t.word === "rap")), "false");

  // SM fills a GAP (no DG token at that slot) — allowed
  const gapSm: TranscriptToken = {
    id: "sm-2",
    word: "background",
    startTimeMs: 3000,
    endTimeMs: 3400,
    source: "speechmatics",
    isDisfluency: false,
    locked: false,
    confidence: 0.92,
  };
  const { tokens: withGap } = reconcileIncoming(afterSm, gapSm);
  check("SM fills a gap Deepgram missed", String(withGap.some((t) => t.word === "background")), "true");
}

console.log(failures === 0 ? "\nALL CHECKS PASSED ✅" : `\n${failures} CHECKS FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
