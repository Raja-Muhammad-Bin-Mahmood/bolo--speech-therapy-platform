/**
 * BOLO — Internal Exercise Library (deterministic, editable)
 *
 * The library contains the ACTUAL exercise instructions. The recommender
 * NEVER invents exercises — it only selects from this fixed set based on the
 * user's recorded onsets, disfluency types, fillers, pace and pauses.
 *
 * EDITING: add/edit entries here (or remap letters in ONSET_MAPPINGS) and
 * every user — Free Speech, Script Mode and Closer Mode alike — picks the
 * change up immediately. The same underlying exercise may be assigned to
 * multiple onsets that share a sound-production pattern (B/P, C/K/Q, S/Z…);
 * the user-facing card always shows the ACTUAL onset BOLO detected.
 *
 * SAFETY: these are SPEECH PRACTICE exercises, not diagnosis or treatment.
 * No exercise ever asks the user to force their voice, shout, strain, or
 * continue through pain.
 */
import type {
  ExerciseCategory,
  ExerciseTemplate,
  OnsetMapping,
} from "./exerciseTypes";

/** Shown on every run screen — never instructs strain or pain. */
export const EXERCISE_SAFETY_NOTE =
  "Speak comfortably. Never force your voice, shout, strain, or continue through pain — stop and rest if anything feels uncomfortable.";

/** Short human label per category (used across the UI). */
export const CATEGORY_LABELS: Record<ExerciseCategory, string> = {
  onset: "Onset / Sound Control",
  filler: "Filler-Word Control",
  pace: "Pace Control",
  hesitation: "Hesitation Control",
  clarity: "General Clarity",
};

// ─── The Library ─────────────────────────────────────────────────────────
// Keyed by stable id. Instructions are short, readable, repeatable, and
// understandable without a speech therapist present.

export const EXERCISE_LIBRARY: Record<string, ExerciseTemplate> = {
  // ── CATEGORY 1: ONSET / SOUND CONTROL (A–Z) ─────────────────────────
  onset_ah: {
    id: "onset_ah",
    category: "onset",
    name: "Gentle A sound practice",
    instructions:
      'Practice a gentle "ah" onset, then speak short controlled syllables beginning with A (ah — ah-tuh — "apple" slowly). Keep the start soft and steady. Continue for about 1 minute.',
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_lip_release: {
    id: "onset_lip_release",
    category: "onset",
    name: "Lip-release sound practice",
    instructions:
      "Close your lips gently, build a little air, then release into a short repeated syllable (puh — puh — puh, buh — buh — buh). Keep the release light and relaxed. Continue for about 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_back_release: {
    id: "onset_back_release",
    category: "onset",
    name: "Back-of-mouth release practice",
    instructions:
      "Use controlled short syllables that start at the back of the mouth (kuh — kuh — kuh, guh — guh — guh). Release the sound cleanly without pushing. Continue for about 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_tongue_tip: {
    id: "onset_tongue_tip",
    category: "onset",
    name: "Tongue-tip contact practice",
    instructions:
      "Touch your tongue tip lightly behind your teeth, then release into short repeated syllables (duh — duh — duh, tuh — tuh — tuh). Keep the tap gentle. Continue for about 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_ee: {
    id: "onset_ee",
    category: "onset",
    name: "Gentle E sound practice",
    instructions:
      'Begin with a gentle "ee" vowel, then follow it with short controlled words that start with E ("eel", "eat", "easy") spoken slowly. Continue for about 1 minute.',
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_airflow_fv: {
    id: "onset_airflow_fv",
    category: "onset",
    name: "Airflow sound practice (F / V)",
    instructions:
      "Send controlled airflow through your lips and teeth, alternating the two sounds (fff — vvv — fff — vvv). Keep the airflow steady and relaxed. Continue for about 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_g: {
    id: "onset_g",
    category: "onset",
    name: "Gentle G sound practice",
    instructions:
      "Use controlled back-of-mouth consonant releases (guh — guh — guh, then short words like “go”, “gap”). Release lightly without forcing. Continue for about 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_h: {
    id: "onset_h",
    category: "onset",
    name: "Gentle H airflow practice",
    instructions:
      "Start with a gentle airflow sound (huh — huh — huh), then follow each one with a short vowel (huh-ah, huh-ee). Keep the airflow easy. Continue for about 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_i: {
    id: "onset_i",
    category: "onset",
    name: "Gentle I sound practice",
    instructions:
      'Begin with a gentle vowel onset, then follow it with short controlled syllables beginning with I ("it", "in", "is") spoken slowly. Continue for about 1 minute.',
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_j: {
    id: "onset_j",
    category: "onset",
    name: "Controlled J sound practice",
    instructions:
      "Produce a controlled J onset, then short syllable repetitions (juh — juh — juh, then words like “jump”, “jam”). Keep the start easy. Continue for about 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_l: {
    id: "onset_l",
    category: "onset",
    name: "Controlled L sound practice",
    instructions:
      "Place your tongue tip lightly against the ridge behind your teeth, then speak short syllables (luh — luh — luh, then “lap”, “low”). Keep the placement light. Continue for about 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_m: {
    id: "onset_m",
    category: "onset",
    name: "Gentle M sound practice",
    instructions:
      "Close your lips gently, hum a soft M, release, then speak short syllables (mmm — muh — muh, then “my”, “man”). Keep it relaxed. Continue for about 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_n: {
    id: "onset_n",
    category: "onset",
    name: "Controlled N sound practice",
    instructions:
      "Start with a controlled nasal onset (nnn — nuh — nuh), then short syllables and words (“no”, “now”). Keep the sound forward and easy. Continue for about 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_o: {
    id: "onset_o",
    category: "onset",
    name: "Gentle O sound practice",
    instructions:
      'Begin with a gentle rounded-vowel onset (oh — oh — oh), then short controlled syllables beginning with O ("old", "open") spoken slowly. Continue for about 1 minute.',
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_r: {
    id: "onset_r",
    category: "onset",
    name: "Gentle R sound practice",
    instructions:
      'Produce a comfortable "r" sound softly, gradually moving your pitch slightly higher and lower while keeping the sound relaxed. Then roll it into short words like “red”, “run”. Continue for 30–60 seconds. Do NOT force loudness, strain, or uncomfortable sustained phonation.',
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_sz: {
    id: "onset_sz",
    category: "onset",
    name: "Controlled airflow practice (S / Z)",
    instructions:
      "Send controlled airflow through the front of your mouth, alternating unvoiced and voiced versions (sss — zzz — sss — zzz). Keep the stream steady and relaxed. Continue for about 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_u: {
    id: "onset_u",
    category: "onset",
    name: "Gentle U sound practice",
    instructions:
      'Begin with a gentle rounded-vowel onset, then short controlled syllables beginning with U ("up", "us") spoken slowly. Keep the start soft. Continue for about 1 minute.',
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_w: {
    id: "onset_w",
    category: "onset",
    name: "Gentle W sound practice",
    instructions:
      "Start with a gentle rounded-lip onset (wuh — wuh — wuh), then short syllables and words (“we”, “way”). Keep the lips soft and relaxed. Continue for about 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_x: {
    id: "onset_x",
    category: "onset",
    name: "X sound practice (by actual sound)",
    instructions:
      "X is rarely a sound of its own — in words like “box” it is a /ks/ combination, while in “xylophone” it starts as a /z/ sound. Say the word you struggled with slowly, using the sound X actually makes in that word, then repeat the full word a few times. Continue for about 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  onset_y: {
    id: "onset_y",
    category: "onset",
    name: "Gentle Y sound practice",
    instructions:
      "Start with a gentle Y onset (yuh — yuh — yuh), then short syllables and words (“yes”, “you”). Keep the glide light and easy. Continue for about 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },

  // ── CATEGORY 2: FILLER-WORD CONTROL ──────────────────────────────────
  filler_pause_instead: {
    id: "filler_pause_instead",
    category: "filler",
    name: "Pause Instead",
    instructions:
      "Speak a short thought. When you feel the urge to use a filler word, pause silently for about one second, breathe naturally, then continue. Repeat for 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
  filler_clean_start: {
    id: "filler_clean_start",
    category: "filler",
    name: "Clean Start",
    instructions:
      "Practice beginning each sentence immediately after a short natural pause instead of using a filler word. Repeat for 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },

  // ── CATEGORY 3: PACE CONTROL ─────────────────────────────────────────
  pace_controlled: {
    id: "pace_controlled",
    category: "pace",
    name: "Controlled Pace",
    instructions:
      "Read or speak a short passage while deliberately leaving a small natural space between phrases. Focus on clarity rather than speed. Practice for 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },

  // ── CATEGORY 4: HESITATION / FLUSTERING ──────────────────────────────
  hesitation_pause_reset: {
    id: "hesitation_pause_reset",
    category: "hesitation",
    name: "Pause and Reset",
    instructions:
      "Speak one sentence. Pause naturally. Take a comfortable breath. Start the next sentence without rushing. Repeat for 1 minute — the goal is to stay in control while thinking and speaking at the same time.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },

  // ── CATEGORY 5: GENERAL CLARITY ──────────────────────────────────────
  clarity_clear_phrase: {
    id: "clarity_clear_phrase",
    category: "clarity",
    name: "Clear Phrase Practice",
    instructions:
      "Speak short phrases slowly enough that every word is deliberate and understandable. Gradually return toward a natural speaking pace while keeping that clarity. Practice for 1 minute.",
    estimatedSeconds: 60,
    safetyNote: EXERCISE_SAFETY_NOTE,
  },
};

// ─── A–Z Display-Onset Mappings ──────────────────────────────────────────
// These are DISPLAY ONSETS, not unique phonetic categories: letters that
// share a sound-production pattern reuse the same exercise template. The
// card always displays the ACTUAL letter BOLO detected.
export const ONSET_MAPPINGS: OnsetMapping[] = [
  { letters: ["A"], exerciseId: "onset_ah" },
  { letters: ["B", "P"], exerciseId: "onset_lip_release" },
  { letters: ["C", "K", "Q"], exerciseId: "onset_back_release" },
  { letters: ["D", "T"], exerciseId: "onset_tongue_tip" },
  { letters: ["E"], exerciseId: "onset_ee" },
  { letters: ["F", "V"], exerciseId: "onset_airflow_fv" },
  { letters: ["G"], exerciseId: "onset_g" },
  { letters: ["H"], exerciseId: "onset_h" },
  { letters: ["I"], exerciseId: "onset_i" },
  { letters: ["J"], exerciseId: "onset_j" },
  { letters: ["L"], exerciseId: "onset_l" },
  { letters: ["M"], exerciseId: "onset_m" },
  { letters: ["N"], exerciseId: "onset_n" },
  { letters: ["O"], exerciseId: "onset_o" },
  { letters: ["R"], exerciseId: "onset_r" },
  { letters: ["S", "Z"], exerciseId: "onset_sz" },
  { letters: ["U"], exerciseId: "onset_u" },
  { letters: ["W"], exerciseId: "onset_w" },
  { letters: ["X"], exerciseId: "onset_x" },
  { letters: ["Y"], exerciseId: "onset_y" },
];

/** Exercise template for a display onset letter (case-insensitive).
 *  Returns null for letters without a mapping (non-alphabetic). */
export function exerciseForOnset(letter: string): ExerciseTemplate | null {
  const l = letter.toUpperCase();
  for (const m of ONSET_MAPPINGS) {
    if (m.letters.includes(l)) return EXERCISE_LIBRARY[m.exerciseId] ?? null;
  }
  return null;
}

/** All onset exercise templates, grouped by their display letters — used by
 *  the "View All Exercises" browser. */
export function onsetExercisesGrouped(): {
  letters: string[];
  template: ExerciseTemplate;
}[] {
  return ONSET_MAPPINGS.map((m) => ({
    letters: m.letters,
    template: EXERCISE_LIBRARY[m.exerciseId]!,
  }));
}

/** All exercises, grouped by category for the "View All" browser. */
export function exercisesByCategory(): Record<
  ExerciseCategory,
  ExerciseTemplate[]
> {
  const groups: Record<ExerciseCategory, ExerciseTemplate[]> = {
    onset: [],
    filler: [],
    pace: [],
    hesitation: [],
    clarity: [],
  };
  for (const t of Object.values(EXERCISE_LIBRARY)) {
    groups[t.category].push(t);
  }
  return groups;
}

/** Short human duration label for a template (e.g. "~1 min"). */
export function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  return m === 1 ? "~1 min" : `~${m} min`;
}
