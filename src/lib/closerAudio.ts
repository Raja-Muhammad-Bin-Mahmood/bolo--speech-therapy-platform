/**
 * PCM helpers for Closer Mode:
 *  - mic Float32 (16 kHz) → Int16 PCM Blob for the Gemini Live socket
 *  - Gemini Live PCM16 base64 (24 kHz) → sequential WebAudio playback
 */

const INT16_MAX = 32768;

/** Float32 samples (16 kHz mic lane) → Int16LE bytes. */
export function float32ToInt16(f32: Float32Array): ArrayBuffer {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * INT16_MAX : s * (INT16_MAX - 1);
  }
  return out.buffer;
}

/** Int16 bytes → base64 (chunked so btoa never chokes on large arrays). */
export function int16ToBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

/** Mic Float32 chunk → `audio/pcm;rate=16000` Blob for `sendRealtimeInput`. */
export function float32ToPcmBlob(f32: Float32Array): Blob {
  return new Blob([float32ToInt16(f32)], { type: "audio/pcm;rate=16000" });
}

/** Gemini Live PCM16 base64 (24 kHz) → Float32 samples. */
export function decodePcm16ToFloat32(b64: string): Float32Array<ArrayBuffer> {
  const u8 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const out = new Float32Array(u8.length / 2);
  for (let i = 0; i < out.length; i++) {
    const sample = u8[i * 2] | (u8[i * 2 + 1] << 8);
    out[i] = (sample >= 32768 ? sample - 65536 : sample) / 32768;
  }
  return out;
}

/**
 * Sequential WebAudio playback queue for the customer's spoken replies.
 * Chunks are scheduled back-to-back so speech never overlaps or stutters.
 */
export class AudioQueue {
  private ctx: AudioContext | null = null;
  private nextTime = 0;
  /** Currently scheduled/playing buffer sources — tracked so flush() can stop them. */
  private active: AudioBufferSourceNode[] = [];

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 24000 });
      this.nextTime = 0;
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  enqueue(b64: string): void {
    try {
      const ctx = this.ensureCtx();
      const f32 = decodePcm16ToFloat32(b64);
      const buffer = ctx.createBuffer(1, f32.length, ctx.sampleRate);
      buffer.copyToChannel(f32, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const when = Math.max(ctx.currentTime, this.nextTime);
      src.start(when);
      this.nextTime = when + buffer.duration;
      this.active.push(src);
      src.onended = () => {
        const i = this.active.indexOf(src);
        if (i >= 0) this.active.splice(i, 1);
      };
    } catch {
      // Skip a corrupt chunk — never let audio kill the call.
    }
  }

  /** Number of audio chunks currently playing or queued (for verification). */
  depth(): number {
    return this.active.length;
  }

  /**
   * Immediately stop whatever is playing and drop everything still queued.
   * The context stays alive so the next chunk plays instantly (barge-in).
   */
  flush(): void {
    for (const src of this.active) {
      try {
        src.stop();
      } catch {
        // Already ended — fine.
      }
    }
    this.active = [];
    this.nextTime = this.ctx?.currentTime ?? 0;
  }

  /** Full teardown (end of call). */
  stop(): void {
    this.flush();
    try {
      void this.ctx?.close();
    } catch {
      // noop
    }
    this.ctx = null;
  }
}

/**
 * Short "call ended" tone (two descending beeps) synthesized with WebAudio
 * so the hang-up moment feels real without shipping an audio asset.
 */
export function playHangupTone(): void {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    const beep = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    };
    beep(880, now, 0.12);
    beep(660, now + 0.14, 0.16);
    window.setTimeout(() => void ctx.close(), 600);
  } catch {
    // audio unsupported — noop
  }
}
