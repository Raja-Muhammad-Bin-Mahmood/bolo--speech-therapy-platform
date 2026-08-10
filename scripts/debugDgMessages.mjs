/**
 * BOLO — Raw message flow debug: what does the server actually send?
 * Opens the FIXED auth path, streams 2s of synthesized speech, and logs
 * EVERY message type with a timestamp + relevant fields — no filtering.
 */
import WebSocket from "ws";

const EDGE_FN = "https://drvjzdxycxgvaeskcbgc.supabase.co/functions/v1/deepgram-token";
const QUERY = [
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
const RATE = 16000;

function resonator(freq, bw) {
  const r = Math.exp((-Math.PI * bw) / RATE);
  const theta = (2 * Math.PI * freq) / RATE;
  const a1 = -2 * r * Math.cos(theta);
  const a2 = r * r;
  const b0 = 1 - r;
  let x1 = 0, x2 = 0;
  return {
    process(input) {
      const out = b0 * input - a1 * x1 - a2 * x2;
      x2 = x1;
      x1 = out;
      return out;
    },
  };
}

function vowel(seconds, f0, formants, amp = 0.5) {
  const n = Math.floor(RATE * seconds);
  const out = new Float32Array(n);
  const rs = formants.map(([f, b]) => resonator(f, b));
  let phase = 0;
  for (let i = 0; i < n; i++) {
    phase += (2 * Math.PI * f0) / RATE;
    let glot = 0;
    for (let h = 1; h <= 8; h++) glot += (1 / h) * Math.sin(h * phase);
    let v = glot;
    for (const r of rs) v = r.process(v);
    out[i] = amp * v;
  }
  return out;
}

function fricative(seconds, amp = 0.35) {
  const n = Math.floor(RATE * seconds);
  const out = new Float32Array(n);
  const r = resonator(4500, 900);
  for (let i = 0; i < n; i++) out[i] = amp * r.process(Math.random() * 2 - 1);
  return out;
}

function plosive(amp = 0.5) {
  const n = Math.floor(RATE * 0.03);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (Math.random() * 2 - 1) * amp * (1 - i / n);
  return out;
}

function silence(seconds) {
  return new Float32Array(Math.floor(RATE * seconds));
}

function concat(...chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function toPcm16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return Buffer.from(i16.buffer);
}

// "see" — fricative + ee vowel
const V_ee = [[270, 130], [2290, 310], [3010, 870]];
const audio = concat(
  fricative(0.12, 0.4),
  vowel(0.28, 130, V_ee, 0.5),
  silence(0.6)
);
const pcm = toPcm16(audio);
console.log(`Audio: ${(pcm.length / 2 / RATE).toFixed(2)}s, ${pcm.length / 2} samples`);

const res = await fetch(EDGE_FN, { method: "POST", headers: { "Content-Type": "application/json" } });
const { token } = await res.json();
console.log(`Token: ${token.slice(0, 6)}…(${token.length})\n`);

const url = `wss://api.deepgram.com/v1/listen?${QUERY}`;
const ws = new WebSocket(url, ["token", token], { handshakeTimeout: 8000 });
const t0 = Date.now();

ws.on("open", () => {
  console.log(`[${Date.now() - t0}ms] OPEN`);
  const CHUNK = 1600;
  let off = 0;
  const iv = setInterval(() => {
    if (off < pcm.length) {
      const end = Math.min(off + CHUNK * 2, pcm.length);
      ws.send(pcm.slice(off, end));
      off = end;
      if (off >= pcm.length) {
        console.log(`[${Date.now() - t0}ms] all audio sent (${pcm.length} bytes)`);
        // Wait for processing, then close cleanly
        setTimeout(() => {
          console.log(`[${Date.now() - t0}ms] closing`);
          try { ws.close(1000, "done"); } catch {}
        }, 2500);
      }
    }
  }, 80);
});

ws.on("message", (data) => {
  const dt = Date.now() - t0;
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    console.log(`[${dt}ms] non-JSON: ${data.toString().slice(0, 80)}`);
    return;
  }
  if (msg.type === "Metadata") {
    console.log(`[${dt}ms] METADATA ${JSON.stringify(msg)}`);
  } else if (msg.type === "Results") {
    const alt = msg.channel?.alternatives?.[0];
    console.log(
      `[${dt}ms] RESULTS is_final=${msg.is_final} speech_final=${msg.speech_final} ` +
        `duration=${msg.duration} transcript="${alt?.transcript ?? ""}" words=${alt?.words?.length ?? 0}`
    );
    if (alt?.words?.length) {
      console.log(
        `        words: ${alt.words.map((w) => `"${w.word}"(${w.start.toFixed(2)}-${w.end.toFixed(2)},${w.confidence.toFixed(2)})`).join(" ")}`
      );
    }
  } else {
    console.log(`[${dt}ms] ${msg.type} ${JSON.stringify(msg).slice(0, 200)}`);
  }
});

ws.on("error", (e) => console.log(`[${Date.now() - t0}ms] ERROR ${e.message}`));
ws.on("close", (code, reason) => {
  console.log(`[${Date.now() - t0}ms] CLOSE ${code} "${reason.toString()}"`);
  process.exit(0);
});

setTimeout(() => {
  console.log("TIMEOUT — forcing exit");
  process.exit(0);
}, 15000);
