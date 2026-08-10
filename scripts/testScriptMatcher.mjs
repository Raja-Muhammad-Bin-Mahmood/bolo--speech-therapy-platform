/**
 * Standalone verification for the Script Mode fixes (bugs 1–3):
 *   1. Tolerant script↔spoken word matching (punctuation-insensitive +
 *      bounded fuzzy) — exercises the REAL `scriptWordMatches` export from
 *      src/hooks/useScriptMatcher.ts via an esbuild bundle.
 *   2. Automatic page-advance simulation — replicates ScriptPager's flip
 *      logic against the REAL paginateScript() from src/lib/scriptCorrelation.
 *
 * Run:  node scripts/testScriptMatcher.mjs
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let pass = 0;
let fail = 0;
function assert(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

// ── Bundle the REAL matcher module (runtime deps: react + pauseDetector) ──
const entry = join(root, "scripts", "testEntryMatcher.ts");
const out = join(root, "scripts", ".testMatcherBundle.cjs");
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["react"],
  outfile: out,
  logLevel: "silent",
});
const mod = await import(`file://${out}`);
const { scriptWordMatches } = mod;
const { paginateScript, WORDS_PER_LINE } = mod;

console.log("\n── 1. Tolerant matching (punctuation / case / fuzzy / reject) ──\n");

// Punctuation is non-semantic
assert('"Hello," matches "hello"', scriptWordMatches("Hello,", "hello"));
assert('"end." matches "end"', scriptWordMatches("end.", "end"));
assert('"don\'t" matches "dont"', scriptWordMatches("don't", "dont"));
assert('"well-known" matches "well"', scriptWordMatches("well", "well-known"));
assert('"step—by" matches "step"', scriptWordMatches("step", "step—by"));
assert('"go." matches "Go!"', scriptWordMatches("go.", "Go!"));
assert('"(the)" matches "the"', scriptWordMatches("the", "(the)"));
assert('"world!" matches "world"', scriptWordMatches("world!", "world"));
assert('"can\'t" matches "cant"', scriptWordMatches("can't", "cant"));
assert('"okay," matches "okay"', scriptWordMatches("okay,", "okay"));

// Case is ignored
assert('"THE" matches "the"', scriptWordMatches("THE", "the"));
assert('"The" matches "the"', scriptWordMatches("The", "the"));

// Minor ASR variation (fuzzy) — same first letter, bounded edit distance
assert('"thier" matches "their"', scriptWordMatches("thier", "their"));
assert('"recieve" matches "receive"', scriptWordMatches("recieve", "receive"));
assert('"tommorow" matches "tomorrow"', scriptWordMatches("tommorow", "tomorrow"));
assert('"focused" matches "focussed"', scriptWordMatches("focused", "focussed"));

// Homophone-ish confusions Deepgram produces are accepted (same first letter,
// small distance) — the user said the right word.
assert('"their" matches "there"', scriptWordMatches("their", "there"));

// Completely unrelated words are REJECTED (never over-loose)
assert('REJECT "cat" vs "dog"', !scriptWordMatches("cat", "dog"));
assert('REJECT "apple" vs "orange"', !scriptWordMatches("apple", "orange"));
assert('REJECT "basket" vs "back"', !scriptWordMatches("basket", "back"));
assert('REJECT "castle" vs "cat"', !scriptWordMatches("castle", "cat"));
assert('REJECT "banana" vs "potato"', !scriptWordMatches("banana", "potato"));

console.log("\n── 2. Automatic page advancement (flip + catch-up jump) ──\n");

// Real pagination of a 200-word script (54 words/page → 4 pages)
const words = Array.from({ length: 200 }, (_, i) => `word${i}`);
const text = words.join(" ");
const pages = paginateScript(text);
assert("200-word script paginates to 4 pages", pages.length === 4);
assert("page 0 covers tokens 0–53", pages[0].start === 0 && pages[0].end === 54);
assert("page 3 covers tokens 162–199", pages[3].start === 162 && pages[3].end === 200);

// Simulates the ScriptPager effect: returns the page after one evaluation.
function stepPager(activeIndex, page) {
  if (pages.length <= 1) return page;
  const cur = pages[page];
  if (!cur) return page;
  if (activeIndex >= cur.end && page < pages.length - 1) {
    return Math.max(page, Math.min(pages.length - 1, page + 1));
  }
  const threshold = Math.max(cur.start, cur.end - WORDS_PER_LINE * 2);
  if (
    activeIndex >= threshold &&
    activeIndex < cur.end &&
    page < pages.length - 1
  ) {
    return Math.min(pages.length - 1, page + 1);
  }
  return page;
}

// Chain single steps until stable (the real effect re-runs after each flip).
function chainTo(activeIndex, startPage) {
  let p = startPage;
  let guard = 0;
  while (guard++ < 20) {
    const np = stepPager(activeIndex, p);
    if (np === p) return p;
    p = np;
  }
  return p;
}

// Normal reading: position enters the last 2 lines → flip
assert("p0, activeIndex=40 → page 1", stepPager(40, 0) === 1);
assert("p1, activeIndex=100 → page 2", stepPager(100, 1) === 2);
assert("p2, activeIndex=150 → page 3", stepPager(150, 2) === 3);
assert("p3, activeIndex=190 → stays page 3 (last)", stepPager(190, 3) === 3);

// Not near the end yet → no flip
assert("p0, activeIndex=5 → stays page 0", stepPager(5, 0) === 0);
assert("p1, activeIndex=60 → stays page 1", stepPager(60, 1) === 1);

// Fast reader / matcher catch-up: position far past the page → chains to the
// page that CONTAINS the position (never lags, never skips past it).
assert("fast catch-up 120 → lands page 2 (contains 120)", chainTo(120, 0) === 2);
assert("fast catch-up 170 → lands page 3 (contains 170)", chainTo(170, 0) === 3);
assert("end of script → last page", chainTo(199, 0) === 3);

// The flip is display-only: session state is never referenced by the pager.
// (Verified structurally in the component — no audio/ws/detector calls.)

console.log(`\n── RESULT: ${pass} passed, ${fail} failed ──\n`);
process.exit(fail > 0 ? 1 : 0);
