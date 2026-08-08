/**
 * Lightweight client-side voice-activity detection for barge-in.
 *
 * This is NOT an ASR model — it's a fast energy/RMS gate that watches the
 * live mic stream. When the customer's audio is playing AND the user starts
 * speaking, we flush the playback queue immediately so the user's voice
 * cuts the customer off without waiting for the server's interruption
 * event. The Gemini session stays open and keeps receiving mic audio.
 */

interface VadState {
  /** Smoothed ambient noise floor (RMS). */
  floor: number;
  /** True when the user is currently "speaking". */
  speaking: boolean;
  /** Frames since the user last crossed above the threshold. */
  sinceSpeech: number;
}

const FLOOR_ALPHA = 0.02; // slow EMA of quiet frames
const SPEECH_RATIO = 2.2; // rms must be this × floor to count as speech
const HYST_RATIO = 1.6; // drop below this to exit speech (hysteresis)
const HOLD_FRAMES = 6; // keep "speaking" for ~150ms after the last loud frame

export function createVoiceActivity() {
  const state: VadState = { floor: 0.004, speaking: false, sinceSpeech: 0 };

  /**
   * Feed one 20ms-ish mic frame. Returns true when the user just STARTED
   * speaking (rising edge) — the exact moment to flush the customer audio.
   */
  const feed = (f32: Float32Array): boolean => {
    // RMS of this frame
    let sumSq = 0;
    for (let i = 0; i < f32.length; i++) {
      sumSq += f32[i] * f32[i];
    }
    const rms = Math.sqrt(sumSq / Math.max(1, f32.length));
    const ratio = rms / Math.max(1e-5, state.floor);

    // Update noise floor only on quiet frames
    if (ratio < 1.2) {
      state.floor = state.floor * (1 - FLOOR_ALPHA) + rms * FLOOR_ALPHA;
      state.floor = Math.max(0.001, state.floor);
    }

    let rising = false;
    if (!state.speaking && ratio > SPEECH_RATIO) {
      state.speaking = true;
      state.sinceSpeech = 0;
      rising = true;
    } else if (state.speaking) {
      state.sinceSpeech += 1;
      if (ratio < HYST_RATIO && state.sinceSpeech > HOLD_FRAMES) {
        state.speaking = false;
      }
    }

    return rising;
  };

  const isSpeaking = () => state.speaking;

  const reset = () => {
    state.floor = 0.004;
    state.speaking = false;
    state.sinceSpeech = 0;
  };

  return { feed, isSpeaking, reset };
}
