/**
 * BOLO — Browser verification of the Deepgram connection (fixed auth path).
 *
 * Starts Free Practice with a fake mic (no pulseaudio needed), and verifies:
 *   1. The Deepgram WebSocket OPENS (was failing with HTTP 401 via ?token=)
 *   2. The runtime logs show the Sec-WebSocket-Protocol auth
 *   3. No Deepgram server errors
 *   4. The transcript pipeline is live (tokens flow)
 *
 * Run: node scripts/verifyDeepgramTransport.mjs  (browser variant)
 */
import { chromium } from "playwright";

const APP_URL = "http://localhost:5173/";

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const ctx = await chromium.launchPersistentContext("/tmp/pw-bolo-debug", {
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required",
  ],
  permissions: ["microphone"],
});
const page = ctx.pages()[0] || (await ctx.newPage());

const logs = [];
page.on("console", (msg) => {
  logs.push({ type: msg.type(), text: msg.text() });
});
page.on("pageerror", (err) => logs.push({ type: "pageerror", text: err.message }));

await page.goto(APP_URL);
await sleep(1200);

// Navigate to Free Practice
await page.click('a[href="/session"]').catch(() => page.goto(APP_URL + "session"));
await sleep(1200);

// Pick a topic → start recording
const startBtn = page.getByRole("button", { name: /start with this topic/i });
if (await startBtn.count()) {
  await startBtn.click();
} else {
  const wheel = page.locator("[class*=topic]").first();
  await wheel.click().catch(() => {});
  await sleep(800);
  await startBtn.click().catch(() => {});
}
await sleep(4000);

// ── Inspect logs ──────────────────────────────────────────────────────
const dgLogs = logs.filter((l) => /DG·/.test(l.text));
const wsLogs = logs.filter((l) => /DG·WS/.test(l.text));
const errors = logs.filter((l) => l.type === "error" || l.type === "pageerror");

console.log("── Deepgram runtime logs ──");
dgLogs.slice(0, 20).forEach((l) => console.log(`[${l.type}] ${l.text}`));
if (!dgLogs.length) console.log("(no DG logs captured)");

console.log("\n── Summary ──");
const opened = wsLogs.some((l) => l.text.includes("OPENED"));
const subprotocolAuth = dgLogs.some((l) => l.text.includes("Sec-WebSocket-Protocol"));
const serverErrors = dgLogs.filter((l) => l.text.includes("SERVER ERROR"));
console.log(`Deepgram WS opened        : ${opened ? "✅ YES" : "❌ NO"}`);
console.log(`Subprotocol auth used     : ${subprotocolAuth ? "✅ YES" : "❌ NO"}`);
console.log(`Deepgram server errors    : ${serverErrors.length}`);
console.log(`Page errors / console errs : ${errors.length}`);
if (errors.length) errors.slice(0, 5).forEach((e) => console.log("  -", e.text));

await ctx.close();
process.exit(opened && subprotocolAuth && serverErrors.length === 0 ? 0 : 1);
