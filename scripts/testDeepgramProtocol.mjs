/**
 * BOLO — Verify the Sec-WebSocket-Protocol auth mechanism (browser-safe).
 *
 * Tests: wss://api.deepgram.com/v1/listen?<full params>
 *   subprotocols: ["token", <temp key>]   ← what the Deepgram JS SDK sends
 * Browsers CAN set Sec-WebSocket-Protocol (unlike Authorization), so if this
 * opens, it is the correct in-browser auth path.
 */
import WebSocket from "ws";

const EDGE_FN = "https://drvjzdxycxgvaeskcbgc.supabase.co/functions/v1/deepgram-token";

const FULL_PARAMS = [
  "model=nova-2",
  "language=en-US",
  "smart_format=true",
  "filler_words=true",
  "interim_results=true",
  "punctuate=true",
  "vad_events=true",
  "no_delay=true",
  "utterance_end_ms=1200",
  "encoding=linear16",
  "sample_rate=16000",
  "channels=1",
].join("&");

function redact(k) {
  return `${k.slice(0, 6)}…(${k.length})`;
}

const res = await fetch(EDGE_FN, { method: "POST", headers: { "Content-Type": "application/json" } });
const { token } = await res.json();
console.log(`Temp key: ${redact(token)}`);

const url = `wss://api.deepgram.com/v1/listen?${FULL_PARAMS}`;
console.log(`URL (no token in query): wss://api.deepgram.com/v1/listen?${FULL_PARAMS}`);

const ws = new WebSocket(url, ["token", token], { handshakeTimeout: 8000 });

let gotMetadata = false;
const METADATA_TIMEOUT_MS = 15000;
const timer = setTimeout(() => {
  console.log(`TIMEOUT — no Metadata after ${METADATA_TIMEOUT_MS / 1000}s`);
  try {
    ws.close(1000, "done");
  } catch {}
}, METADATA_TIMEOUT_MS);

ws.on("open", () => {
  console.log("✅ WebSocket OPEN via Sec-WebSocket-Protocol subprotocol");
  // Send a few seconds of PCM16 16k mono (tones — exercises Results path)
  const CHUNK = 3200; // 100ms
  let t = 0;
  const iv = setInterval(() => {
    const buf = Buffer.alloc(CHUNK * 2);
    for (let i = 0; i < CHUNK; i++) {
      const s = t + i / 16000;
      let amp = 0;
      if (s > 0.3 && s < 0.9) amp = 0.3 * Math.sin(2 * Math.PI * 350 * s);
      else if (s > 1.0 && s < 2.2)
        amp = 0.25 * Math.sin(2 * Math.PI * 440 * s) + 0.2 * Math.sin(2 * Math.PI * 990 * s);
      buf.writeInt16LE(Math.round(amp * 32767), i * 2);
    }
    t += CHUNK / 16000;
    if (ws.readyState === WebSocket.OPEN) ws.send(buf);
    if (t > 3.5) clearInterval(iv);
  }, 100);
});

ws.on("message", (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (msg.type === "Metadata") {
    gotMetadata = true;
    console.log(
      `Metadata: request_id=${msg.request_id} model=${msg.model_info?.name} ` +
        `sample_rate=${msg.sample_rate} channels=${msg.channels} duration=${msg.duration}`
    );
  } else if (msg.type === "Results") {
    const alt = msg.channel?.alternatives?.[0];
    console.log(
      `Results: is_final=${msg.is_final} speech_final=${msg.speech_final ?? "?"} ` +
        `transcript="${alt?.transcript ?? ""}"`
    );
  } else if (msg.type === "Error" || msg.type === "error") {
    console.log("❌ SERVER ERROR:", JSON.stringify(msg));
  } else {
    console.log(`Server msg: ${msg.type}`);
  }
});

ws.on("error", (e) => console.log("WS error:", e.message ?? "(none)"));
ws.on("close", (code, reason) => {
  clearTimeout(timer);
  console.log(`Close: code=${code} reason="${reason.toString()}"`);
  console.log(gotMetadata ? "\n✅ AUTH MECHANISM CONFIRMED (Sec-WebSocket-Protocol)" : "\n❌ No Metadata — mechanism NOT confirmed");
  process.exit(gotMetadata ? 0 : 1);
});
