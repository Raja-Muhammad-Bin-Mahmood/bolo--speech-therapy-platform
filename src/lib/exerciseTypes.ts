/**
 * BOLO — Personalized Training: shared types
 *
 * The training system is DETERMINISTIC: a fixed exercise library + a
 * personalization layer that only maps "what pattern does this user have?"
 * → "which predefined exercise is most relevant?". No LLM is ever consulted
 * at runtime. These types are the contract between the library, the
 * recommender and the training UI.
 */

/** The five exercise categories. */
export type ExerciseCategory =
  | "onset" // onset / sound control (A–Z)
  | "filler" // filler-word control
  | "pace" // pace control
  | "hesitation" // hesitation / flustering
  | "clarity"; // general clarity

/** A single predefined exercise in the internal library. The instructions
 *  live HERE — the app never asks an AI to invent them. */
export interface ExerciseTemplate {
  /** Stable id (editable library key, e.g. "onset_r", "filler_pause"). */
  id: string;
  category: ExerciseCategory;
  /** Display name, e.g. "Gentle R sound practice". */
  name: string;
  /** The actual step-by-step instructions the user reads and follows. */
  instructions: string;
  /** Target duration in seconds (shown on the card + used for the timer). */
  estimatedSeconds: number;
  /** Optional safety note rendered on the run screen. */
  safetyNote?: string;
}

/** Which display letters share an exercise template (B/P, C/K/Q, S/Z…).
 *  The underlying exercise can be shared, but the user-facing card always
 *  shows the ACTUAL onset BOLO detected. */
export interface OnsetMapping {
  /** Display onsets (uppercase letters) that map to this exercise. */
  letters: string[];
  exerciseId: string;
}

/** One recommended exercise card — target + reason + template. */
export interface ExerciseRecommendation {
  /** Stable id per target (e.g. "onset-r", "filler-pause"). */
  id: string;
  category: ExerciseCategory;
  template: ExerciseTemplate;
  /** The personalized target shown on the card:
   *  the ACTUAL onset letter (uppercase), the actual filler word, or a
   *  category label ("Pace", "Hesitations", "Clarity"). */
  target: string;
  /** Why BOLO recommends this — always derived from recorded data. */
  reason: string;
  /** Observed occurrence count for the target (onsets / fillers / pauses). */
  count: number;
  /** Deterministic ranking weight (higher = more relevant). */
  priority: number;
  /** Extra filler words to list on a filler card (word + count). */
  extraFillers?: string[];
}

/** Everything the recommender knows about the user's recorded patterns. */
export interface TrainingProfile {
  /** Onset-letter counts, most frequent first (from saved official events). */
  onsets: { letter: string; count: number }[];
  /** Per-letter counts of MANUALLY CONFIRMED stutter-like events. */
  manualOnsets: Map<string, number>;
  /** Total manually confirmed stutter-like events. */
  manualStutterCount: number;
  /** Recurring filler words (complete words, never first letters). */
  fillers: { word: string; count: number }[];
  /** Pace measured by the existing rolling pace engine (from the session
   *  that led here; user-level pace history is not persisted). */
  pace: {
    wpm: number;
    zone: string;
    consistency: number | null;
    elevated: boolean;
    unstable: boolean;
  };
  /** Pause breakdown from the session that led here. */
  pauses: {
    thinking: number;
    awkward: number;
    severe: number;
    total: number;
  };
  /** True when the profile includes data from the originating session. */
  hasSessionData: boolean;
}

/** A persisted training completion (account-level history). */
export interface CompletedExercise {
  id: string;
  /** The exercise template id from the library. */
  exerciseId: string;
  category: ExerciseCategory;
  /** The personalized target: onset letter (uppercase), filler word, or
   *  category label. */
  target: string;
  exerciseName: string;
  completedAt: string;
  durationSeconds: number;
  status: "done";
  /** Originating session id, when the entry came from one. */
  sessionId?: string | null;
  /** Originating mode: "free" | "script" | "closer" | "training". */
  mode?: string | null;
}

/** Aggregate progress-report stats — measures PRACTICE, never clinical
 *  improvement (BOLO never fabricates scores or cure claims). */
export interface TrainingStats {
  totalCompleted: number;
  totalPracticeSeconds: number;
  mostPracticed: { target: string; count: number }[];
  recent: CompletedExercise[];
  currentFocus: string | null;
}
