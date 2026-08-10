/**
 * BOLO — Deterministic Exercise Recommender
 *
 * Personalization layer ONLY. It answers two questions:
 *   1. WHAT PATTERN does this user have? (recorded onsets, confirmed
 *      stutters, fillers, pace, pauses)
 *   2. WHICH PREDEFINED exercise is most relevant?
 *
 * It never invents exercises, never calls an LLM, and never claims clinical
 * improvement. Every recommendation carries its reason, derived from data.
 *
 * PRIORITY (highest → lowest):
 *   1. Most frequent confirmed onset patterns (manual confirmations boost)
 *   2. Repeated manually confirmed stutters (counted into onsets + boosted)
 *   3. Recurring filler words
 *   4. Consistently elevated / unstable pace (existing rolling pace data)
 *   5. Hesitation patterns (awkward / severe pauses)
 *   6. General clarity practice (gentle fallback, always available)
 */
import { EXERCISE_LIBRARY, exerciseForOnset } from "./exerciseLibrary";
import type {
  ExerciseRecommendation,
  TrainingProfile,
} from "./exerciseTypes";

/** The pause profile that counts as a "hesitation pattern". */
function needsHesitation(p: TrainingProfile["pauses"]): boolean {
  if (p.total <= 0) return false;
  return p.awkward + p.severe >= 2 || p.thinking >= 5;
}

export interface RecommendResult {
  /** Ranked recommendations, top 5 — the "Recommended Today" list. */
  recommended: ExerciseRecommendation[];
  /** The full ranked list — the "View All" browser order. */
  all: ExerciseRecommendation[];
}

/** Build the ranked recommendation list for a profile. Deterministic:
 *  same profile → same recommendations, always. */
export function recommendExercises(
  profile: TrainingProfile
): RecommendResult {
  const recs: ExerciseRecommendation[] = [];

  // ── 1 + 2: Onset patterns (most frequent; manual confirmations boost) ──
  const onsets = [...profile.onsets].sort(
    (a, b) => b.count - a.count || a.letter.localeCompare(b.letter)
  );
  for (const o of onsets.slice(0, 6)) {
    const template = exerciseForOnset(o.letter);
    if (!template) continue;
    const manual = profile.manualOnsets.get(o.letter) ?? 0;
    recs.push({
      id: `onset-${o.letter.toLowerCase()}`,
      category: "onset",
      template,
      // The ACTUAL onset BOLO detected — never the shared mapping letter.
      target: o.letter.toUpperCase(),
      count: o.count,
      reason:
        manual > 0
          ? `Your most frequent onset — ${o.count} occurrence${
              o.count === 1 ? "" : "s"
            }, ${manual} confirmed by you.`
          : `Your most frequent onset — ${o.count} occurrence${
              o.count === 1 ? "" : "s"
            } across your sessions.`,
      priority: 100 + o.count + (manual > 0 ? 50 : 0),
    });
  }

  // ── 3: Recurring filler words (the ACTUAL words BOLO detected) ─────────
  const fillers = [...profile.fillers].sort((a, b) => b.count - a.count);
  const topFiller = fillers[0];
  if (topFiller && topFiller.count >= 2) {
    recs.push({
      id: "filler-pause",
      category: "filler",
      template: EXERCISE_LIBRARY.filler_pause_instead!,
      target: topFiller.word,
      count: topFiller.count,
      reason: `"${topFiller.word}" appeared ${topFiller.count} times — a silent pause gives your brain time to find the next word.`,
      priority: 60 + topFiller.count,
      extraFillers: fillers.slice(0, 3).map((f) => `${f.word} × ${f.count}`),
    });
    if (fillers[1] && fillers[1].count >= 2) {
      recs.push({
        id: "filler-clean",
        category: "filler",
        template: EXERCISE_LIBRARY.filler_clean_start!,
        target: fillers[1].word,
        count: fillers[1].count,
        reason: `"${fillers[1].word}" — begin each sentence right after a short natural pause instead.`,
        priority: 50 + fillers[1].count,
      });
    }
  }

  // ── 4: Pace control (existing rolling pace measurement) ────────────────
  if (profile.pace.elevated || profile.pace.unstable) {
    recs.push({
      id: "pace-controlled",
      category: "pace",
      template: EXERCISE_LIBRARY.pace_controlled!,
      target: "Pace",
      count: profile.pace.wpm,
      reason: profile.pace.elevated
        ? `Your pace measured ${profile.pace.wpm} WPM (${profile.pace.zone}) — small natural spaces between phrases keep clarity high.`
        : "Your pace was inconsistent — steady spacing between phrases makes delivery feel calmer.",
      priority: 45,
    });
  }

  // ── 5: Hesitation / flustering ─────────────────────────────────────────
  if (needsHesitation(profile.pauses)) {
    recs.push({
      id: "hesitation-pause-reset",
      category: "hesitation",
      template: EXERCISE_LIBRARY.hesitation_pause_reset!,
      target: "Hesitations",
      count: profile.pauses.awkward + profile.pauses.severe,
      reason: `BOLO recorded ${profile.pauses.awkward} awkward and ${profile.pauses.severe} severe pauses — practice resetting calmly between sentences.`,
      priority: 40,
    });
  }

  // ── 6: General clarity (gentle, always available) ──────────────────────
  recs.push({
    id: "clarity-clear-phrase",
    category: "clarity",
    template: EXERCISE_LIBRARY.clarity_clear_phrase!,
    target: "Clarity",
    count: 0,
    reason: profile.hasSessionData
      ? "A gentle all-round practice — every word deliberate and understandable."
      : "BOLO hasn't recorded a pattern yet — this is a great place to start.",
    priority: 10,
  });

  const ranked = recs.sort((a, b) => b.priority - a.priority);
  return {
    recommended: ranked.slice(0, 5),
    all: ranked,
  };
}
