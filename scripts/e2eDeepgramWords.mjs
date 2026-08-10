/**
 * BOLO — Raw Deepgram result verification with REAL espeak-ng speech.
 *
 * Synthesizes the exact spec test utterances with espeak-ng, resamples to
 * 16 kHz mono PCM16 (the app's declared format), streams through the FIXED
 * auth path (Sec-WebSocket-Protocol), and captures the COMPLETE raw
 * Deepgram result per word:
 *
 *   word / punctuated_word / start / end / confidence / is_final /
 *   speech_final / alternatives / duration / model metadata
 *
 * This answers the critical question: DOES DEEPGRAM RETURN "ssssslap"
 * RAW, OR ONLY "slap"?
 *
 * Run: node scripts/e2eDeepgramWords.mjs
 */
import WebSocket from "ws";
import { readFileSync } from "fs";

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
const TARGET_RATE = 16000;

function redact(k) {
  return `${k.slice(0, 6)}…(${k.length})`;
}

/** Read a WAV, decode to Float32 mono, resample linearly to target rate. */
function loadWavMono(path, targetRate) {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Not a WAV: ${path}`);
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { off: off + 8, size };
    else if (id === "data") data = { off: off + 8, size };
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`Bad WAV structure: ${path}`);
  const audioFormat = buf.readUInt16LE(fmt.off);
  const channels = buf.readUInt16LE(fmt.off + 2);
  const sampleRate = buf.readUInt32LE(fmt.off + 4);
  const bitsPerSample = buf.readUInt16LE(fmt.off + 14);
  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(data.size / (bytesPerSample * channels));

  const f32 = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const byteOff = data.off + i * bytesPerSample * channels;
    let sample;
    if (bitsPerSample === 16) sample = buf.readInt16LE(byteOff);
    else if (bitsPerSample === 8) sample = (buf.readUInt8(byteOff) - 128) * 256;
    else throw new Error(`Unsupported bitsPerSample ${bitsPerSample}`);
    f32[i] = sample / 32768;
  }

  // Resample (linear) to target rate
  if (sampleRate === targetRate) return f32;
  const ratio = targetRate / sampleRate;
  const outLen = Math.max(1, Math.floor(frames * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(frames - 1, i0 + 1);
    const frac = src - i0;
    out[i] = f32[i0] * (1 - frac) + f32[i1] * frac;
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

function runUtterance(name, wavPath, token) {
  return new Promise((resolve) => {
    const url = `wss://api.deepgram.com/v1/listen?${QUERY}`;
    const ws = new WebSocket(url, ["token", token], { handshakeTimeout: 8000 });
    const result = {
      name,
      opened: false,
      metadata: null,
      rawResults: [],
      rawWords: [],
      errors: [],
      close: null,
    };

    let f32;
    try {
      f32 = loadWavMono(wavPath, TARGET_RATE);
    } catch (e) {
      result.errors.push({ loadError: e.message });
      resolve(result);
      return;
    }
    const pcm = toPcm16(f32);
    const CHUNK = 1600; // 100ms
    let off = 0;
    let done = false;

    const finish = (code, reason) => {
      if (done) return;
      done = true;
      clearInterval(iv);
      try {
        ws.close(1000, "done");
      } catch {}
      resolve(result);
    };

    const iv = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (off < pcm.length) {
        const end = Math.min(off + CHUNK * 2, pcm.length);
        ws.send(pcm.slice(off, end));
        off = end;
      } else if (!done) {
        setTimeout(() => finish(1000, "sent all"), 2000);
      }
    }, 80);

    setTimeout(() => finish(1000, "timeout"), 12000);

    ws.on("open", () => (result.opened = true));
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "Metadata") {
        result.metadata = {
          request_id: msg.request_id,
          model: msg.model_info?.name,
          sample_rate: msg.sample_rate,
          channels: msg.channels,
          duration: msg.duration,
        };
      } else if (msg.type === "Results") {
        const alt = msg.channel?.alternatives?.[0];
        result.rawResults.push({
          is_final: msg.is_final,
          speech_final: msg.speech_final ?? undefined,
          duration: msg.duration,
          start: msg.start,
          transcript: alt?.transcript ?? "",
          confidence: alt?.confidence ?? undefined,
          words: (alt?.words ?? []).map((w) => ({
            word: w.word,
            punctuated_word: w.punctuated_word ?? undefined,
            start: w.start,
            end: w.end,
            confidence: w.confidence,
          })),
        });
        if (msg.is_final && alt) {
          for (const w of alt.words ?? []) {
            const existing = result.rawWords.find(
              (x) => x.word === w.word && Math.abs(x.start - w.start) < 0.05
            );
            if (!existing)
              result.rawWords.push({
                word: w.word,
                punctuated_word: w.punctuated_word ?? w.word,
                start: w.start,
                end: w.end,
                confidence: w.confidence,
                is_final: true,
                speech_final: msg.speech_final ?? false,
              });
          }
        }
      } else if (msg.type === "Error" || msg.type === "error") {
        result.errors.push(msg);
      }
    });
    ws.on("error", (e) => result.errors.push({ wsError: e.message }));
    ws.on("close", (code, reason) => {
      result.close = { code, reason: reason.toString() };
      finish(code, reason.toString());
    });
  });
}

// ── Main ────────────────────────────────────────────────────────────────

const res = await fetch(EDGE_FN, { method: "POST", headers: { "Content-Type": "application/json" } });
const { token } = await res.json();
console.log(`Temp key: ${redact(token)}\n`);

const cases = [
  { name: "ssssslap", wav: "/tmp/bolo-tts/ssssslap.wav" },
  { name: "slap (control)", wav: "/tmp/bolo-tts/slap.wav" },
  { name: "ii-i-i-i", wav: "/tmp/bolo-tts/iiiii.wav" },
  { name: "rrrhrhrhrory", wav: "/tmp/bolo-tts/rory.wav" },
  { name: "um uh", wav: "/tmp/bolo-tts/umuh.wav" },
  { name: "fluent control", wav: "/tmp/bolo-tts/fluent.wav" },
];

for (const c of cases) {
  const r = await runUtterance(c.name, c.wav, token);
  console.log(`\n════════ ${c.name} ════════`);
  console.log(`  opened: ${r.opened ? "✅" : "❌"}  errors: ${r.errors.length}`);
  if (r.metadata) console.log(`  metadata: ${JSON.stringify(r.metadata)}`);
  const finals = r.rawResults.filter((x) => x.is_final);
  console.log(`  RESULTS messages: ${r.rawResults.length} (${finals.length} final)`);
  const lastFinal = finals[finals.length - 1];
  if (lastFinal) {
    console.log(`  last FINAL: transcript="${lastFinal.transcript}" conf=${lastFinal.confidence} duration=${lastFinal.duration} start=${lastFinal.start}`);
    console.log(`  words: ${JSON.stringify(lastFinal.words)}`);
  } else {
    console.log(`  (no final result — closest: ${JSON.stringify(r.rawResults[r.rawResults.length - 1] ?? null)})`);
  }
  console.log(`  close: ${r.close ? `${r.close.code} "${r.close.reason}"` : "(none)"}`);
}

console.log("\nDone.");
process.exit(0);
