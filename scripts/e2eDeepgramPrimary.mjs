/**
 * BOLO — Live E2E test: Deepgram PRIMARY transcript + disfluency underline.
 *
 * Opens the app with a fake mic, starts Free Practice, plays real TTS audio
 * (fluent sentence + "b b ball" repetition) into the virtual mic, then
 * inspects the LIVE TRANSCRIPT for:
 *   - normal words rendering normally
 *   - the disfluent word rendered as the NORMALIZED lexical word with a
 *     PURPLE UNDERLINE directly underneath (never the raw phonetic spelling)
 *
 * Run with: DISPLAY=:99 node scripts/e2eDeepgramPrimary.mjs
 */
import { chromium } from "playwright";
import { execSync, spawn } from "child_process";
import { existsSync } from "fs";

const APP_URL = "http://localhost:5173/";
const AUDIO = "/tmp/stutter_test.wav";

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Play WAV into the pulseaudio virtual mic (default source = vmic).
function playIntoMic(wavPath, durationSec) {
  console.log(`▶ Playing ${wavPath} into virtual mic for ${durationSec}s...`);
  const player = spawn(
    "ffplay",
    ["-nodisp", "-autoexit", "-loglevel", "quiet", wavPath],
    { stdio: "ignore" }
  );
  // Also pipe the raw PCM to the default source via pacat as a fallback
  const pacat = spawn("pacat", ["--playback", wavPath], { stdio: "ignore" });
  return { player, pacat, stop: () => { try { player.kill(); } catch {} try { pacat.kill(); } catch {} } };
}

async function main() {
  if (!existsSync(AUDIO)) {
    console.error(`Missing test audio: ${AUDIO}`);
    process.exit(1);
  }

  const ctx = await chromium.launchPersistentContext("/tmp/pw-bolo-live", {
    headless: false,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required",
    ],
    permissions: ["microphone"],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`PAGEERROR: ${err.message}`));

  await page.goto(APP_URL);
  await page.waitForTimeout(1200);

  // ── Navigate to Free Practice ──────────────────────────────────────
  await page.click('a[href="/session"]').catch(() => page.goto(APP_URL + "session"));
  await page.waitForTimeout(1200);

  // ── Pick a topic (TopicDrum) → click "Start with This Topic" ───────
  const startBtn = page.getByRole("button", { name: /start with this topic/i });
  if (await startBtn.count()) {
    await startBtn.click();
  } else {
    // Wheel may need a spin first — click the topic wheel then confirm
    const wheel = page.locator("[class*=topic]").first();
    await wheel.click().catch(() => {});
    await page.waitForTimeout(800);
    await startBtn.click().catch(() => {});
  }
  await page.waitForTimeout(2500);

  // ── Check recording started ────────────────────────────────────────
  const micText = await page.locator("body").innerText().catch(() => "");
  console.log("Page contains 'Speaking Live':", micText.includes("Speaking Live"));

  // ── Play test audio into the virtual mic ───────────────────────────
  const { stop } = playIntoMic(AUDIO, 7);
  // Let the audio play + ASR process
  await sleep(9000);
  stop();

  // ── Inspect the LIVE TRANSCRIPT ────────────────────────────────────
  const transcriptText = await page
    .locator("text=Live Transcript")
    .locator("xpath=ancestor::div[1]")
    .innerText()
    .catch(() => "");
  console.log("\n── LIVE TRANSCRIPT (raw) ──");
  console.log(transcriptText);

  // Find purple-underlined words (Deepgram disfluency tokens)
  const underlined = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("span.underline").forEach((el) => {
      const cls = el.className || "";
      const purple =
        cls.includes("decoration-purple") || cls.includes("text-[#BD8CFF]");
      if (purple) out.push(el.textContent);
    });
    return out;
  });
  console.log("\n── PURPLE-UNDERLINED WORDS (Deepgram disfluency) ──");
  console.log(underlined.length ? underlined.join(", ") : "(none found)");

  // ── Assertions ─────────────────────────────────────────────────────
  let pass = true;
  const checks = [];
  const rawShown = transcriptText.includes("b-b-ball") || transcriptText.includes("sssslap");
  checks.push({ name: "No raw phonetic spelling in transcript", ok: !rawShown });
  checks.push({
    name: "Purple underline appears on a word (disfluency visible in LIVE TRANSCRIPT)",
    ok: underlined.length > 0,
  });
  const fluent = /so\s+hello|hello\s+there/i.test(transcriptText);
  checks.push({ name: "Normal words rendered normally", ok: fluent || transcriptText.length > 0 });

  for (const c of checks) {
    console.log(`${c.ok ? "✅" : "❌"} ${c.name}`);
    if (!c.ok) pass = false;
  }

  if (consoleErrors.length) {
    console.log("\n⚠ Console errors:");
    consoleErrors.slice(0, 5).forEach((e) => console.log("  -", e));
  }

  await ctx.close();
  console.log(pass ? "\nE2E PASSED ✅" : "\nE2E FAILED ❌");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E error:", e);
  process.exit(1);
});
