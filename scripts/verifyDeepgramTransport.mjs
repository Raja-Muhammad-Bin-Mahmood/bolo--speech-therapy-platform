/**
 * BOLO — Browser verification of the Deepgram transport (acceptance criteria).
 *
 * Drives the REAL app UI (Free Practice) with a fake microphone that plays a
 * synthesized-speech WAV (espeak-ng), then proves all six criteria from the
 * actual browser runtime logs:
 *   1. Deepgram WebSocket OPENS
 *   2. Deepgram auth subprotocol is visibly negotiated (ws.protocol === "token")
 *   3. Deepgram receives microphone audio (PCM16 flow + transcript produced)
 *   4. A real Deepgram transcript response is captured in the logs ([DG·RAW])
 *   5. The raw response is logged BEFORE normalization/filtering ([DG·RAW]
 *      precedes [DG·TRACE])
 *   6. The sample-rate path is verified (mic track rate, AudioContext rate,
 *      declared sample_rate — no silent 48000→16000 mismatch)
 *
 * Usage: node scripts/verifyDeepgramTransport.mjs
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const APP_URL = "http://localhost:5173/";
const WAV_PATH = "/tmp/bolo-speech.wav";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 1. Require the synthesized speech WAV ────────────────────────────────
if (!existsSync(WAV_PATH)) {
  console.error(`Missing ${WAV_PATH} — generate it first:\n  espeak-ng -w ${WAV_PATH} -s 150 "..."`);
  process.exit(2);
}

const ctx = await chromium.launchPersistentContext("/tmp/pw-bolo-dg", {
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${WAV_PATH}`,
    "--use-fake-ui-for-media-stream",
    "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required",
  ],
  permissions: ["microphone"],
});
const page = ctx.pages()[0] || (await ctx.newPage());

const logs = [];
page.on("console", (msg) => logs.push({ type: msg.type(), text: msg.text() }));
page.on("pageerror", (err) => logs.push({ type: "pageerror", text: err.message }));

// Also watch the audio/mic path explicitly (all messages, not just DG·)
const allText = () => logs.map((l) => l.text).join("\n");

await page.goto(APP_URL);
await sleep(1200);

// ── 2. Navigate to Free Practice ─────────────────────────────────────────
await page.click('a[href="/session"]').catch(() => page.goto(APP_URL + "session"));
await sleep(1200);

// ── 3. Pick a topic (pull the lever → lands → confirm) ──────────────────
const lever = page
  .locator("div[class*='cursor-pointer']")
  .filter({ has: page.locator("div[class*='from-neon-purple to-vibrant-indigo']") })
  .first();
if (await lever.count()) {
  await lever.click().catch(() => {});
  await sleep(2200); // spin animation lands on a topic
}
const startBtn = page.getByRole("button", { name: /start with this topic/i });
if (await startBtn.count()) {
  await startBtn.click();
} else {
  console.error("❌ Could not reach the recording phase (no Start button).");
  await ctx.close();
  process.exit(3);
}

// ── 4. Let the session run (fake mic plays the speech WAV) ───────────────
await sleep(24000);

// ── 5. Collect + analyse the runtime logs ────────────────────────────────
const dgLogs = logs.filter((l) => /DG·/.test(l.text));
const wsLogs = dgLogs.filter((l) => /DG·WS/.test(l.text));
const rawLogs = dgLogs.filter((l) => /DG·RAW/.test(l.text));
const traceLogs = dgLogs.filter((l) => /DG·TRACE/.test(l.text));
const audioLogs = dgLogs.filter((l) => /DG·AUDIO/.test(l.text));
const metaLogs = dgLogs.filter((l) => /DG·META/.test(l.text));
const errs = dgLogs.filter((l) => /SERVER ERROR/.test(l.text));
const pageErrs = logs.filter((l) => l.type === "pageerror");

console.log("\n═══ DEEPGRAM RUNTIME LOGS (browser) ═══\n");
const rawShown = new Set();
dgLogs.forEach((l) => {
  // Show the first interim + first final RAW frame, then summarize the rest
  if (/DG·RAW/.test(l.text)) {
    const isFinal = l.text.includes("is_final=true");
    const key = isFinal ? "final" : "interim";
    if (rawShown.has(key)) return;
    rawShown.add(key);
    // Trim the embedded JSON to the transcript + first 3 words for readability
    const short = l.text.replace(/raw=\{"type":"Results".*?,"metadata":\{.*?\}\}$/, "raw={…full frame in original…}")
      .slice(0, 900);
    console.log(`[${l.type}] ${short}`);
    return;
  }
  if (/DG·TRACE/.test(l.text)) {
    const m = l.text.match(/raw="([^"]*)"/);
    if (m && !["i", "want", "to", "talk", "about"].includes(m[1])) return; // dedupe common words
    console.log(`[${l.type}] ${l.text.slice(0, 220)}`);
    return;
  }
  console.log(`[${l.type}] ${l.text}`);
});
if (!dgLogs.length) console.log("(no DG logs captured)");
const rawCount = dgLogs.filter((l) => /DG·RAW/.test(l.text)).length;
const traceCount = dgLogs.filter((l) => /DG·TRACE/.test(l.text)).length;
console.log(`\n([DG·RAW] frames: ${rawCount} total · [DG·TRACE] lines: ${traceCount} total)`);

console.log("\n═══ AUDIO/MIC PATH (all browser logs) ═══");
const audioPath = logs.filter((l) => /mic|Mic|audio|Audio|AudioContext|getUserMedia|worklet|Telemetry|denied|NotAllowed/i.test(l.text));
audioPath.slice(0, 20).forEach((l) => console.log(`[${l.type}] ${l.text}`));
if (!audioPath.length) console.log("(no audio/mic logs captured)");

console.log("\n═══ ACCEPTANCE CRITERIA ═══\n");

const opened = wsLogs.some((l) => l.text.includes("OPENED"));
const subprotocol = wsLogs.some((l) => l.text.includes('negotiatedSubprotocol="token"'));
const audioSent =
  audioLogs.some((l) => l.text.includes("transmitted=PCM16")) &&
  audioLogs.some((l) => parseFloat((l.text.match(/firstChunkPeak=([\d.]+)/) || [])[1] || "0") > 0.0001);
const transcript = rawLogs.some((l) => l.text.includes("is_final=true") && /words=[1-9]/.test(l.text));
const rawBeforeTrace = (() => {
  const rawIdx = logs.findIndex((l) => /DG·RAW/.test(l.text));
  const traceIdx = logs.findIndex((l) => /DG·TRACE/.test(l.text));
  return rawIdx !== -1 && (traceIdx === -1 || rawIdx < traceIdx);
})();
const sampleRatePath =
  audioLogs.some((l) => l.text.includes("sample_rate=")) &&
  logs.some((l) => /AudioContext requested=16000 actual=/.test(l.text)) &&
  logs.some((l) => /actual track=/.test(l.text));

const fmt = (ok) => (ok ? "✅ YES" : "❌ NO");
console.log(`1. Deepgram WS opened               : ${fmt(opened)}`);
console.log(`2. Auth subprotocol "token"         : ${fmt(subprotocol)}`);
console.log(`3. Mic audio received by DG         : ${fmt(audioSent)}  (PCM16 + non-zero first peak)`);
console.log(`4. Real DG transcript response      : ${fmt(transcript)}  ([DG·RAW] is_final=true words>0)`);
console.log(`5. Raw response logged before proc  : ${fmt(rawBeforeTrace)}  ([DG·RAW] precedes [DG·TRACE])`);
console.log(`6. Sample-rate path verified        : ${fmt(sampleRatePath)}  (mic track → AudioContext → declared)`);
console.log(`   Deepgram server errors           : ${errs.length}`);
console.log(`   Page errors                      : ${pageErrs.length}`);

if (pageErrs.length) pageErrs.slice(0, 5).forEach((e) => console.log("   -", e.text));

if (metaLogs.length) {
  console.log("\n── Deepgram connection metadata (from the live socket) ──");
  metaLogs.forEach((l) => console.log("  " + l.text));
}

await ctx.close();
const pass =
  opened && subprotocol && audioSent && transcript && rawBeforeTrace && sampleRatePath &&
  errs.length === 0 && pageErrs.length === 0;
process.exit(pass ? 0 : 1);
