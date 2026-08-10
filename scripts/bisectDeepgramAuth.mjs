/**
 * BOLO — Deepgram auth bisect (test-first)
 *
 * Isolates WHY the browser connection fails:
 *   A. ?token=<temp> with NO params            → is the token param supported?
 *   B. Authorization: Bearer <temp>, no params → does the temp key work at all?
 *   C. Authorization: Bearer <temp> + full params → do params break it?
 *   D. ?token=<temp> + full params (control)   → reproduces the app
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

function probe(name, url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 8000 });
    const out = { name, opened: false, metadata: null, errors: [], closed: null };
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {}
      resolve(out);
    }, 9000);
    ws.on("open", () => {
      out.opened = true;
      // send a short silence to elicit Metadata
      try {
        ws.send(Buffer.alloc(3200)); // 100ms silence @16k mono
      } catch {}
    });
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "Metadata") {
        out.metadata = {
          request_id: msg.request_id,
          model: msg.model_info?.name,
          sample_rate: msg.sample_rate,
        };
      } else if (msg.type === "Error" || msg.type === "error") {
        out.errors.push(msg);
      }
      if (msg.type === "Metadata") {
        clearTimeout(timer);
        try {
          ws.close(1000, "ok");
        } catch {}
        setTimeout(() => resolve(out), 500);
      }
    });
    ws.on("error", (e) => {
      out.errors.push({ wsError: e.message ?? "(no message)" });
    });
    ws.on("close", (code, reason) => {
      out.closed = { code, reason: reason.toString() || "" };
      clearTimeout(timer);
      resolve(out);
    });
  });
}

const res = await fetch(EDGE_FN, { method: "POST", headers: { "Content-Type": "application/json" } });
const { token } = await res.json();
console.log(`Temp key: ${redact(token)}\n`);

const BASE = "wss://api.deepgram.com/v1/listen";

const A = await probe("A: ?token= (no params)", `${BASE}?token=${encodeURIComponent(token)}`, {});
const B = await probe("B: Bearer header (no params)", BASE, { Authorization: `Token ${token}` });
const C = await probe("C: Bearer header + full params", `${BASE}?${FULL_PARAMS}`, { Authorization: `Token ${token}` });
const D = await probe("D: ?token= + full params (app control)", `${BASE}?${FULL_PARAMS}&token=${encodeURIComponent(token)}`, {});

for (const r of [A, B, C, D]) {
  console.log(`\n── ${r.name} ──`);
  console.log(`  opened    : ${r.opened ? "✅ YES" : "❌ NO"}`);
  console.log(`  metadata  : ${r.metadata ? JSON.stringify(r.metadata) : "(none)"}`);
  console.log(`  errors    : ${JSON.stringify(r.errors)}`);
  console.log(`  closed    : ${JSON.stringify(r.closed)}`);
}
