/**
 * BOLO — Browser verification of the AudioWorklet DSP lane.
 *
 * Part A (deterministic): loads public/dsp-self-test.html which drives the
 *   telemetry worklet with an oscillator through the EXACT app topology
 *   (source → AudioWorkletNode, 0 outputs, no destination) and asserts:
 *     (a) worklet module URL returns HTTP 200
 *     (b) no SyntaxError / module-load error in the console
 *     (c) the processor registers (addModule resolves, node created)
 *     (d) the processor receives audio and emits "frame" + "pcm" messages
 *         with real acoustic features
 *     (e) no processorerror, and — since AudioWorklet is supported and the
 *         module loads — the ScriptProcessorNode fallback is unnecessary
 *
 * Part B (real app): drives the actual RecordingSession with a fake mic
 *   (espeak-ng WAV) and asserts the app logs
 *   "Telemetry worklet ACTIVE" and NOT "falling back to ScriptProcessorNode",
 *   with zero page errors — proving the fallback guard is not taken when
 *   AudioWorklet is available, and mic audio actually flows through the
 *   worklet into the Deepgram transport.
 *
 * Usage: node scripts/verifyDspWorklet.mjs   (requires dev server on :5173)
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const BASE = "http://localhost:5173";
const WAV_PATH = "/tmp/bolo-speech.wav";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Launch (fake mic ready for Part B) ───────────────────────────────────
const ctx = await chromium.launchPersistentContext("/tmp/pw-bolo-dsp", {
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    ...(existsSync(WAV_PATH) ? [`--use-file-for-fake-audio-capture=${WAV_PATH}`] : []),
    "--use-fake-ui-for-media-stream",
    "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required",
  ],
  permissions: ["microphone"],
});
const page = ctx.pages()[0] || (await ctx.newPage());

const logs = [];
const workletResponses = [];
page.on("console", (m) => logs.push({ type: m.type(), text: m.text() }));
page.on("pageerror", (e) => logs.push({ type: "pageerror", text: e.message }));
page.on("response", (r) => {
  if (r.url().includes("telemetry-processor.worklet.js")) {
    workletResponses.push({ status: r.status(), url: r.url() });
  }
});
const allText = () => logs.map((l) => l.text).join("\n");

// ═══════════════════════════════════════════════════════════════════════
// PART A — deterministic worklet harness
// ═══════════════════════════════════════════════════════════════════════
console.log("\n═══ PART A — worklet harness (public/dsp-self-test.html) ═══\n");
await page.goto(BASE + "/dsp-self-test.html", { waitUntil: "domcontentloaded" });

const res = await page
  .waitForFunction(() => window.__DSP_RESULT__, null, { timeout: 20000 })
  .then((h) => h.jsonValue())
  .catch(() => null);

if (!res) {
  console.error("❌ No DSP result from harness");
  console.log(allText());
  await ctx.close();
  process.exit(1);
}

console.log("worklet module HTTP status :", res.moduleHttpStatus);
console.log("audioWorklet supported      :", res.audioWorkletSupported);
console.log("module loaded (addModule)   :", res.moduleLoaded, res.moduleLoadError || "");
console.log("processor registered        :", res.processorRegistered);
console.log("node created                :", res.nodeCreated, res.nodeCreatedError || "");
console.log("frames received             :", res.framesReceived);
console.log("pcm chunks received         :", res.pcmChunksReceived);
console.log("processorerror              :", res.processorError || "none");
if (res.firstFrame) {
  console.log("first frame sample          :", JSON.stringify({
    t: +res.firstFrame.t.toFixed(4),
    rms: +res.firstFrame.rms.toFixed(5),
    labelName: res.firstFrame.labelName,
    zcr: +res.firstFrame.zcr.toFixed(3),
    spectralFlatness: +res.firstFrame.spectralFlatness.toFixed(3),
    vad: +res.firstFrame.vad.toFixed(3),
  }));
}
if (res.lastFrame) {
  console.log("last frame sample           :", JSON.stringify({
    t: +res.lastFrame.t.toFixed(4),
    rms: +res.lastFrame.rms.toFixed(5),
    labelName: res.lastFrame.labelName,
    rollingNoiseFloor: +res.lastFrame.rollingNoiseFloor.toFixed(5),
  }));
}

const consoleErrs = logs.filter((l) => l.type === "pageerror" || (l.type === "error" && /syntax|module|worklet/i.test(l.text)));
console.log("console/page errors         :", consoleErrs.length ? consoleErrs.map((e) => e.text).join(" | ") : "none");

const partA =
  res.moduleHttpStatus === 200 &&
  res.moduleLoaded &&
  res.processorRegistered &&
  res.nodeCreated &&
  res.framesReceived > 0 &&
  res.pcmChunksReceived > 0 &&
  !res.processorError &&
  !res.moduleLoadError &&
  consoleErrs.length === 0 &&
  res.firstFrame &&
  res.firstFrame.rms > 0 &&
  res.firstFrame.labelName;

console.log("\nPART A:", partA ? "✅ PASS" : "❌ FAIL");

// ═══════════════════════════════════════════════════════════════════════
// PART B — real app: fallback guard + mic audio through the worklet
// ═══════════════════════════════════════════════════════════════════════
console.log("\n═══ PART B — real app (fallback guard + mic-through-worklet) ═══\n");
logs.length = 0;
workletResponses.length = 0;

await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await sleep(1200);
await page.click('a[href="/session"]').catch(() => page.goto(BASE + "/session"));
await sleep(1200);

const lever = page
  .locator("div[class*='cursor-pointer']")
  .filter({ has: page.locator("div[class*='from-neon-purple to-vibrant-indigo']") })
  .first();
if (await lever.count()) {
  await lever.click().catch(() => {});
  await sleep(2200);
}
const startBtn = page.getByRole("button", { name: /start with this topic/i });
if (await startBtn.count()) {
  await startBtn.click();
  console.log("started recording with fake mic");
} else {
  console.log("⚠ could not find Start button — skipping app drive");
}

await sleep(6000);

const activeLog = logs.find((l) => l.text.includes("Telemetry worklet ACTIVE"));
const fallbackLog = logs.find((l) => l.text.includes("falling back to ScriptProcessorNode"));
const pageErrs = logs.filter((l) => l.type === "pageerror");
const wlResponses = workletResponses.map((r) => r.status);

console.log("worklet module HTTP status :", wlResponses.length ? wlResponses.join(", ") : "(not requested)");
console.log("'Telemetry worklet ACTIVE' :", activeLog ? activeLog.text : "MISSING");
console.log("'falling back to Script…'  :", fallbackLog ? "PRESENT ❌" : "absent ✅");
console.log("page errors                :", pageErrs.length ? pageErrs.map((e) => e.text) : "0");
const micAudioFlow = logs.some((l) => l.text.includes("transmitted=PCM16"));
console.log("mic PCM forwarded          :", micAudioFlow ? "yes" : "no");

const partB =
  activeLog !== undefined &&
  fallbackLog === undefined &&
  pageErrs.length === 0 &&
  wlResponses.every((s) => s === 200) &&
  micAudioFlow;

console.log("\nPART B:", partB ? "✅ PASS" : "❌ FAIL");

await ctx.close();
console.log("\n═══ RESULT ═══");
console.log("DSP worklet lane:", partA && partB ? "✅ RESTORED AND RUNNING IN BROWSER" : "❌ STILL BROKEN");
process.exit(partA && partB ? 0 : 1);
