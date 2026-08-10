/**
 * BOLO — Microphone constraint profiles (speech-disfluency analysis)
 *
 * Why this exists (verified test requirement):
 *   Browser defaults for getUserMedia apply noiseSuppression=true and
 *   autoGainControl=true. WebRTC noise suppression attenuates STATIONARY
 *   broadband sounds — and a sustained fricative ("ssssslap" = a long /s/)
 *   is exactly that. The suppression can erase the acoustic evidence of a
 *   prolongation BEFORE it reaches the ASR or the DSP lane.
 *
 * Profiles (TEST A / TEST B from the debug spec):
 *   • "analysis" (DEFAULT) — echoCancellation: true, noiseSuppression:
 *     false, autoGainControl: false. Recommended for disfluency analysis.
 *     Echo cancellation stays ON: BOLO must never pick up coach/TTS audio.
 *   • "default" — mimics browser defaults (all processing ON) for A/B
 *     comparison of the raw microphone signal.
 *
 * Select via URL:  ?mic=analysis   |   ?mic=default
 */
export type MicProfile = "analysis" | "default";

export const MIC_PROFILES: MicProfile[] = ["analysis", "default"];

/** Resolve the active profile from the URL (?mic=…), default "analysis". */
export function resolveMicProfile(): MicProfile {
  if (typeof window === "undefined") return "analysis";
  const v = new URLSearchParams(window.location.search).get("mic");
  return v === "default" ? "default" : "analysis";
}

export function getMicConstraints(profile: MicProfile): MediaTrackConstraints {
  switch (profile) {
    case "default":
      // Browser defaults made explicit (noise suppression + AGC ON).
      return {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
    case "analysis":
    default:
      // Speech-disfluency analysis profile: keep echo cancellation (TTS /
      // coach audio must not enter the mic) but disable the processing that
      // destroys sustained fricatives.
      return {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      };
  }
}
