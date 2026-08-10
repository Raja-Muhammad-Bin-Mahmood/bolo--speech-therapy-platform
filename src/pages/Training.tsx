/**
 * BOLO — Personalized Training (universal after Free Speech / Script Mode /
 * Closer Mode → Analysis)
 *
 * Deterministic by design: recommendations are selected from the FIXED
 * exercise library based on the user's recorded onsets, fillers, pace and
 * pauses. No LLM is consulted at runtime. Completed exercises persist to the
 * user's ACCOUNT (Supabase / local fallback) and feed the Progress Report.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Dumbbell,
  List,
  Play,
  ShieldCheck,
  Sparkles,
  Target,
  Timer,
  Type,
} from "lucide-react";
import Navbar from "../components/Navbar";
import { useAuth } from "../context/AuthContext";
import {
  CATEGORY_LABELS,
  EXERCISE_LIBRARY,
  EXERCISE_SAFETY_NOTE,
  durationLabel,
  exercisesByCategory,
  onsetExercisesGrouped,
} from "../lib/exerciseLibrary";
import { recommendExercises } from "../lib/exerciseRecommender";
import {
  buildTrainingProfile,
  buildTrainingStats,
  formatPracticeTime,
  loadTrainingHistory,
  makeCompletionId,
  modeLabel,
  saveTrainingCompletion,
  type SessionSignals,
} from "../lib/exerciseHistory";
import type {
  CompletedExercise,
  ExerciseCategory,
  ExerciseRecommendation,
  TrainingProfile,
} from "../lib/exerciseTypes";

type Phase = "loading" | "dashboard" | "run" | "done";

// ─── Small helpers ──────────────────────────────────────────────────────

function SectionTitle({
  icon: Icon,
  title,
  hint,
}: {
  icon: any;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="w-4 h-4 text-neon-purple shrink-0" />
      <h2 className="font-heading text-base font-semibold text-white">{title}</h2>
      {hint && (
        <span className="ml-auto text-[10px] text-soft-gray/50">{hint}</span>
      )}
    </div>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs text-soft-gray/60 leading-relaxed">{children}</p>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────

export default function Training() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isLocal } = useAuth();

  const originState = useMemo(() => (location.state ?? {}) as SessionSignals & {
    mode?: string | null;
    sessionId?: string | null;
  }, [location.state]);
  const originMode = originState.mode ?? null;
  const originSessionId = originState.sessionId ?? null;

  const [phase, setPhase] = useState<Phase>("loading");
  const [profile, setProfile] = useState<TrainingProfile | null>(null);
  const [history, setHistory] = useState<CompletedExercise[]>([]);
  const [active, setActive] = useState<ExerciseRecommendation | null>(null);
  const [justCompleted, setJustCompleted] = useState<CompletedExercise | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [allFilter, setAllFilter] = useState<ExerciseCategory | "all">("all");

  // ── Load: account history + profile from EXISTING saved speech data ──
  useEffect(() => {
    let alive = true;
    (async () => {
      const account = user ? { id: user.id, isLocal } : { id: "guest", isLocal: true };
      const [p, h] = await Promise.all([
        buildTrainingProfile(account, originState),
        loadTrainingHistory(account),
      ]);
      if (!alive) return;
      setProfile(p);
      setHistory(h);
      setPhase("dashboard");
    })();
    return () => {
      alive = false;
    };
  }, [user, isLocal, originState]);

  const result = useMemo(
    () => (profile ? recommendExercises(profile) : null),
    [profile]
  );
  const stats = useMemo(() => buildTrainingStats(history), [history]);

  // ── Completion: persist to the user's ACCOUNT, then refresh state ──
  const handleExerciseDone = useCallback(
    async (ce: CompletedExercise) => {
      const account = user ? { id: user.id, isLocal } : { id: "guest", isLocal: true };
      await saveTrainingCompletion(account, ce);
      setHistory((prev) =>
        [ce, ...prev].sort((a, b) => b.completedAt.localeCompare(a.completedAt))
      );
      setJustCompleted(ce);
      setPhase("done");
    },
    [user, isLocal]
  );

  const startRun = useCallback((rec: ExerciseRecommendation) => {
    setActive(rec);
    setPhase("run");
  }, []);

  const backToDashboard = useCallback(() => setPhase("dashboard"), []);

  // ── Loading ──────────────────────────────────────────────────────────
  if (phase === "loading" || !profile) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-deep-space">
        <Navbar />
        <div className="relative z-10 pt-40 flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-electric-violet to-neon-purple flex items-center justify-center animate-pulse">
            <Dumbbell className="w-6 h-6 text-white" />
          </div>
          <p className="text-sm text-soft-gray/60">Preparing your training…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative overflow-hidden bg-deep-space">
      <Navbar />
      {/* Ambient orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-electric-violet/5 blur-[120px]" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-neon-purple/5 blur-[120px]" />
      </div>

      <main className="relative z-10 pt-24 pb-16 px-4 max-w-3xl mx-auto">
        <button
          onClick={() => navigate("/dashboard")}
          className="inline-flex items-center gap-1.5 text-sm text-soft-gray hover:text-white transition-colors mb-6 cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Dashboard
        </button>

        <AnimatePresence mode="wait">
          {phase === "dashboard" && (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              <DashboardView
                profile={profile}
                recommended={result?.recommended ?? []}
                stats={stats}
                originMode={originMode}
                onTrain={startRun}
                showAll={showAll}
                setShowAll={setShowAll}
                allFilter={allFilter}
                setAllFilter={setAllFilter}
              />
            </motion.div>
          )}

          {phase === "run" && active && (
            <motion.div
              key="run"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            >
              <RunScreen
                rec={active}
                originMode={originMode}
                originSessionId={originSessionId}
                onDone={handleExerciseDone}
                onExit={backToDashboard}
              />
            </motion.div>
          )}

          {phase === "done" && justCompleted && (
            <motion.div
              key="done"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            >
              <DoneView
                completed={justCompleted}
                originMode={originMode}
                onContinue={backToDashboard}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

// ─── Dashboard View ─────────────────────────────────────────────────────

function DashboardView({
  profile,
  recommended,
  stats,
  originMode,
  onTrain,
  showAll,
  setShowAll,
  allFilter,
  setAllFilter,
}: {
  profile: TrainingProfile;
  recommended: ExerciseRecommendation[];
  stats: ReturnType<typeof buildTrainingStats>;
  originMode: string | null;
  onTrain: (rec: ExerciseRecommendation) => void;
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  allFilter: ExerciseCategory | "all";
  setAllFilter: (v: ExerciseCategory | "all") => void;
}) {
  const hasPatterns =
    profile.onsets.length > 0 ||
    profile.fillers.length > 0 ||
    profile.hasSessionData;

  return (
    <div>
      {/* Header */}
      <div className="text-center mb-8">
        <div className="w-16 h-16 rounded-full bg-gradient-to-br from-electric-violet to-neon-purple flex items-center justify-center mx-auto mb-4 shadow-[0_0_40px_rgba(109,86,255,0.3)]">
          <Dumbbell className="w-8 h-8 text-white" />
        </div>
        <h1 className="font-heading text-2xl md:text-3xl font-bold text-white mb-2">
          Personalized For You
        </h1>
        <p className="text-sm text-soft-gray/60 max-w-md mx-auto">
          Based on the speaking patterns BOLO has recorded across your
          sessions.
        </p>
        {originMode && (
          <div className="inline-flex items-center gap-1.5 mt-3 glass-subtle rounded-full px-3 py-1 text-[10px] text-soft-gray/70">
            <Sparkles className="w-3 h-3 text-neon-purple" />
            Recommended after your {modeLabel(originMode)} session
          </div>
        )}
      </div>

      {/* Your Common Onsets */}
      <section className="glass rounded-2xl p-5 mb-6">
        <SectionTitle
          icon={Type}
          title="Your Common Onsets"
          hint="starting sounds BOLO detected"
        />
        {profile.onsets.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {profile.onsets.slice(0, 8).map((o) => (
              <span
                key={o.letter}
                className="inline-flex items-center gap-2 rounded-xl px-3 py-2 bg-white/5 border border-neon-purple/20"
              >
                <span className="font-heading text-lg font-bold text-neon-purple">
                  {o.letter.toUpperCase()}
                </span>
                <span className="text-[10px] text-soft-gray/60">
                  {o.count} occurrence{o.count === 1 ? "" : "s"}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <EmptyNote>
            BOLO hasn't detected any onset patterns yet. Complete a speech
            session (Free Practice, Script Mode or Closer Mode) and your most
            frequent starting sounds will appear here.
          </EmptyNote>
        )}
      </section>

      {/* Recommended Today */}
      <section className="mb-6">
        <SectionTitle icon={Target} title="Recommended Today" hint="3–5 targeted exercises" />
        {!hasPatterns ? (
          <div className="glass rounded-2xl p-5">
            <EmptyNote>
              BOLO hasn't recorded enough patterns to personalize yet — but
              you can start training right away with the gentle exercises
              below. Every session you complete makes these recommendations
              sharper.
            </EmptyNote>
          </div>
        ) : null}
        {recommended.length === 0 ? (
          <div className="glass rounded-2xl p-5">
            <EmptyNote>
              No recommendations yet — finish a speech session and BOLO will
              build your personalized list.
            </EmptyNote>
          </div>
        ) : (
          <div className="space-y-4">
            {recommended.map((rec, i) => (
              <RecommendationCard
                key={rec.id}
                rec={rec}
                index={i}
                onTrain={() => onTrain(rec)}
              />
            ))}
          </div>
        )}
      </section>

      {/* View All Exercises */}
      <section className="mb-6">
        <button
          onClick={() => setShowAll(!showAll)}
          aria-expanded={showAll}
          className="w-full flex items-center justify-between glass-subtle rounded-xl px-4 py-3 text-left transition-all duration-200 hover:bg-white/[0.06] active:scale-[0.99] cursor-pointer"
        >
          <span className="inline-flex items-center gap-2 text-sm text-white/80 font-medium">
            <List className="w-4 h-4 text-neon-purple" />
            View All Exercises
            <span className="text-[10px] text-soft-gray/50 font-normal">
              ({Object.keys(EXERCISE_LIBRARY).length} in the library)
            </span>
          </span>
          <ChevronDown
            className={`w-4 h-4 text-soft-gray/50 transition-transform duration-200 ${
              showAll ? "rotate-180" : ""
            }`}
          />
        </button>

        {showAll && (
          <div className="mt-3">
            {/* Filter chips */}
            <div className="flex flex-wrap gap-1.5 mb-4">
              {(["all", "onset", "filler", "pace", "hesitation", "clarity"] as const).map(
                (f) => (
                  <button
                    key={f}
                    onClick={() => setAllFilter(f)}
                    className={`text-[11px] px-2.5 py-1 rounded-full border transition-all duration-200 cursor-pointer ${
                      allFilter === f
                        ? "bg-neon-purple/15 border-neon-purple/40 text-neon-purple"
                        : "bg-white/5 border-white/10 text-soft-gray/70 hover:text-white"
                    }`}
                  >
                    {f === "all" ? "All" : CATEGORY_LABELS[f]}
                  </button>
                )
              )}
            </div>

            {/* Onset exercises show their letter groups */}
            {allFilter === "all" || allFilter === "onset" ? (
              <div className="grid sm:grid-cols-2 gap-3 mb-4">
                {onsetExercisesGrouped()
                  .filter(() => allFilter === "onset")
                  .map((g) => (
                    <LibraryCard
                      key={g.template.id}
                      letters={g.letters.join(" / ")}
                      template={g.template}
                      onTrain={() =>
                        onTrain({
                          id: `lib-${g.template.id}`,
                          category: "onset",
                          template: g.template,
                          target: g.letters.join(" / "),
                          reason: "From the full exercise library.",
                          count: 0,
                          priority: 0,
                        })
                      }
                    />
                  ))}
                {allFilter === "all" &&
                  onsetExercisesGrouped().map((g) => (
                    <LibraryCard
                      key={g.template.id}
                      letters={g.letters.join(" / ")}
                      template={g.template}
                      onTrain={() =>
                        onTrain({
                          id: `lib-${g.template.id}`,
                          category: "onset",
                          template: g.template,
                          target: g.letters.join(" / "),
                          reason: "From the full exercise library.",
                          count: 0,
                          priority: 0,
                        })
                      }
                    />
                  ))}
              </div>
            ) : null}

            {/* Other categories */}
            {(["filler", "pace", "hesitation", "clarity"] as const)
              .filter((cat) => allFilter === "all" || allFilter === cat)
              .map((cat) => (
                <div key={cat} className="mb-4">
                  <p className="text-[10px] uppercase tracking-wider text-soft-gray/50 font-medium mb-2">
                    {CATEGORY_LABELS[cat]}
                  </p>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {exercisesByCategory()[cat].map((t) => (
                      <LibraryCard
                        key={t.id}
                        letters={CATEGORY_LABELS[cat]}
                        template={t}
                        onTrain={() =>
                          onTrain({
                            id: `lib-${t.id}`,
                            category: cat,
                            template: t,
                            target: CATEGORY_LABELS[cat],
                            reason: "From the full exercise library.",
                            count: 0,
                            priority: 0,
                          })
                        }
                      />
                    ))}
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>

      {/* Training Progress (Progress Report) */}
      <TrainingProgress profile={profile} stats={stats} />
    </div>
  );
}

// ─── Recommendation Card ────────────────────────────────────────────────

function RecommendationCard({
  rec,
  index,
  onTrain,
}: {
  rec: ExerciseRecommendation;
  index: number;
  onTrain: () => void;
}) {
  const isOnset = rec.category === "onset";
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.06 * index, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="glass rounded-2xl p-5 border border-neon-purple/10 hover:border-neon-purple/25 transition-colors duration-200"
    >
      {/* Target + count */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <span className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 bg-neon-purple/10 border border-neon-purple/25">
          {isOnset && (
            <span className="font-heading text-sm font-bold text-neon-purple">
              ONSET {rec.target}
            </span>
          )}
          {rec.category === "filler" && (
            <span className="text-sm font-semibold text-amber-300">
              FILLER “{rec.target}”
            </span>
          )}
          {rec.category !== "onset" && rec.category !== "filler" && (
            <span className="text-sm font-semibold text-neon-purple">
              {rec.target}
            </span>
          )}
        </span>
        {rec.count > 0 && (
          <span className="text-[10px] text-soft-gray/60">
            {rec.count} occurrence{rec.count === 1 ? "" : "s"}
          </span>
        )}
        <span className="ml-auto text-[10px] text-soft-gray/50">
          {durationLabel(rec.template.estimatedSeconds)}
        </span>
      </div>

      {/* Exercise name + instructions */}
      <h3 className="font-heading text-base font-semibold text-white mb-1">
        {rec.template.name}
      </h3>
      <p className="text-xs text-soft-gray/70 leading-relaxed mb-3 line-clamp-3">
        {rec.template.instructions}
      </p>

      {/* Actual detected fillers (when present) */}
      {rec.extraFillers && rec.extraFillers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {rec.extraFillers.map((f) => (
            <span
              key={f}
              className="text-[10px] px-2 py-0.5 rounded-full bg-amber-300/10 text-amber-300/80 border border-amber-300/20"
            >
              {f}
            </span>
          ))}
        </div>
      )}

      {/* Why */}
      <p className="text-[11px] text-soft-gray/50 italic mb-4">
        Why: {rec.reason}
      </p>

      <button
        onClick={onTrain}
        className="w-full inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-all duration-200 active:scale-[0.97] cursor-pointer"
      >
        TRAIN
        <Play className="w-3.5 h-3.5" />
      </button>
    </motion.div>
  );
}

// ─── Library Card (View All) ────────────────────────────────────────────

function LibraryCard({
  letters,
  template,
  onTrain,
}: {
  letters: string;
  template: { id: string; category: ExerciseCategory; name: string; instructions: string; estimatedSeconds: number };
  onTrain: () => void;
}) {
  return (
    <div className="glass-subtle rounded-xl p-4 flex flex-col">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-heading text-sm font-bold text-white/90">
          {letters}
        </span>
        <span className="text-[10px] text-soft-gray/50">
          {durationLabel(template.estimatedSeconds)}
        </span>
      </div>
      <h4 className="text-sm font-medium text-white mb-1">{template.name}</h4>
      <p className="text-[11px] text-soft-gray/60 leading-relaxed mb-3 line-clamp-2">
        {template.instructions}
      </p>
      <button
        onClick={onTrain}
        className="mt-auto inline-flex items-center justify-center gap-1.5 text-[11px] font-semibold text-neon-purple bg-neon-purple/10 border border-neon-purple/25 px-3 py-1.5 rounded-lg transition-all duration-200 hover:bg-neon-purple/20 active:scale-[0.97] cursor-pointer"
      >
        TRAIN
        <Play className="w-3 h-3" />
      </button>
    </div>
  );
}

// ─── Run Screen (exercise with timer) ───────────────────────────────────

function RunScreen({
  rec,
  originMode,
  originSessionId,
  onDone,
  onExit,
}: {
  rec: ExerciseRecommendation;
  originMode: string | null;
  originSessionId: string | null;
  onDone: (ce: CompletedExercise) => void;
  onExit: () => void;
}) {
  const total = Math.max(10, rec.template.estimatedSeconds);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);

  const elapsedSec = startedAt ? (now - startedAt) / 1000 : 0;
  const remaining = Math.max(0, total - elapsedSec);
  const finished = running && remaining <= 0;

  useEffect(() => {
    if (finished) setRunning(false);
  }, [finished]);

  const start = () => {
    setStartedAt(Date.now());
    setNow(Date.now());
    setRunning(true);
  };

  const saveDuration = Math.max(
    1,
    Math.min(total, Math.round(startedAt ? elapsedSec : 0))
  );

  const finish = () => {
    onDone({
      id: makeCompletionId(),
      exerciseId: rec.template.id,
      category: rec.category,
      target: rec.target,
      exerciseName: rec.template.name,
      completedAt: new Date().toISOString(),
      durationSeconds: saveDuration,
      status: "done",
      sessionId: originSessionId,
      mode: originMode ?? "training",
    });
  };

  const pct = (remaining / total) * 100;
  const isOnset = rec.category === "onset";

  return (
    <div className="glass-strong rounded-3xl p-6 md:p-10 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-neon-purple/[0.05] to-transparent pointer-events-none" />

      <button
        onClick={onExit}
        className="relative inline-flex items-center gap-1.5 text-xs text-soft-gray hover:text-white transition-colors mb-6 cursor-pointer"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to recommendations
      </button>

      <div className="relative text-center">
        {/* Target */}
        <p className="text-[10px] uppercase tracking-[0.2em] text-soft-gray/50 mb-2">
          {isOnset ? "Target Onset" : rec.category === "filler" ? "Filler Word" : "Training Focus"}
        </p>
        <h1 className="font-heading text-4xl md:text-5xl font-bold text-white mb-2">
          {isOnset ? (
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-electric-violet to-neon-purple">
              {rec.target}
            </span>
          ) : rec.category === "filler" ? (
            <span className="text-amber-300">“{rec.target}”</span>
          ) : (
            rec.target
          )}
        </h1>
        <p className="text-sm text-soft-gray/70 mb-8">{rec.template.name}</p>

        {/* Instructions */}
        <div className="max-w-md mx-auto glass-subtle rounded-2xl px-5 py-4 mb-8 text-left">
          <p className="text-sm text-white/85 leading-relaxed">
            {rec.template.instructions}
          </p>
        </div>

        {/* Timer */}
        <div className="flex flex-col items-center gap-4 mb-8">
          <div
            className="relative w-36 h-36"
            role="timer"
            aria-label={`${Math.ceil(remaining)} seconds remaining`}
            aria-live="polite"
          >
            <svg width="144" height="144" className="-rotate-90">
              <circle
                cx="72"
                cy="72"
                r="64"
                fill="none"
                stroke="rgba(255,255,255,0.06)"
                strokeWidth="6"
              />
              <circle
                cx="72"
                cy="72"
                r="64"
                fill="none"
                stroke={finished ? "#34D399" : "#BD8CFF"}
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 64}
                strokeDashoffset={(2 * Math.PI * 64) * (1 - pct / 100)}
                className="transition-all duration-300"
                style={{ filter: "drop-shadow(0 0 6px rgba(189,140,255,0.4))" }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-mono text-4xl font-bold text-white tabular-nums">
                {Math.ceil(remaining)}
              </span>
              <span className="text-[9px] text-soft-gray/50 uppercase tracking-wide">
                seconds
              </span>
            </div>
          </div>

          {finished ? (
            <p className="text-xs text-emerald-300/90 font-medium">
              Time's up — how did that feel?
            </p>
          ) : running ? (
            <p className="text-xs text-soft-gray/60">
              Keep it relaxed — no strain, no forcing.
            </p>
          ) : null}
        </div>

        {/* Actions */}
        <div className="flex flex-col items-center gap-3">
          {!running && !finished && (
            <button
              onClick={start}
              className="inline-flex items-center gap-2 font-heading font-semibold text-white bg-primary hover:bg-primary-hover px-10 py-3.5 rounded-full transition-all duration-200 active:scale-[0.97] neon-glow cursor-pointer"
            >
              START
              <Play className="w-4 h-4" />
            </button>
          )}

          {(running || finished) && (
            <button
              onClick={finish}
              className={`inline-flex items-center gap-2 font-heading font-semibold text-white px-10 py-3.5 rounded-full transition-all duration-200 active:scale-[0.97] cursor-pointer ${
                finished
                  ? "bg-emerald-500 hover:bg-emerald-400 animate-pulse"
                  : "bg-primary hover:bg-primary-hover"
              }`}
            >
              <CheckCircle2 className="w-4 h-4" />
              MARK AS DONE
            </button>
          )}

          {running && !finished && (
            <button
              onClick={finish}
              className="text-[11px] text-soft-gray/50 hover:text-white transition-colors cursor-pointer underline underline-offset-2"
            >
              Finish early
            </button>
          )}
        </div>

        {/* Safety */}
        <div className="flex items-start gap-2 mt-8 text-left">
          <ShieldCheck className="w-3.5 h-3.5 text-soft-gray/50 shrink-0 mt-0.5" />
          <p className="text-[10px] text-soft-gray/50 leading-relaxed">
            {EXERCISE_SAFETY_NOTE} This is structured speaking practice, not
            diagnosis or medical treatment.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Done View (completion moment) ──────────────────────────────────────

function DoneView({
  completed,
  originMode,
  onContinue,
}: {
  completed: CompletedExercise;
  originMode: string | null;
  onContinue: () => void;
}) {
  return (
    <div className="glass-strong rounded-3xl p-8 md:p-12 text-center relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-emerald-400/[0.04] to-transparent pointer-events-none" />
      <motion.div
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 18 }}
        className="relative w-20 h-20 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center mx-auto mb-5 shadow-[0_0_40px_rgba(52,211,153,0.35)]"
      >
        <Check className="w-10 h-10 text-white" strokeWidth={3} />
      </motion.div>
      <h1 className="font-heading text-2xl font-bold text-white mb-2">
        Nice work!
      </h1>
      <p className="text-sm text-soft-gray/70 max-w-sm mx-auto mb-6">
        <span className="text-white font-medium">{completed.exerciseName}</span>{" "}
        saved to your progress — practice adds up, one comfortable minute at a
        time.
      </p>

      <div className="flex flex-wrap items-center justify-center gap-2 mb-8">
        <span className="inline-flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-full bg-white/5 text-soft-gray/80">
          <Timer className="w-3 h-3 text-neon-purple" />
          {formatPracticeTime(completed.durationSeconds)}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-full bg-white/5 text-soft-gray/80">
          <Target className="w-3 h-3 text-neon-purple" />
          {completed.target}
        </span>
        {originMode && (
          <span className="inline-flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-full bg-white/5 text-soft-gray/80">
            <Clock className="w-3 h-3 text-neon-purple" />
            from {modeLabel(originMode)}
          </span>
        )}
      </div>

      <button
        onClick={onContinue}
        className="inline-flex items-center gap-2 font-heading font-semibold text-white bg-primary hover:bg-primary-hover px-8 py-3 rounded-full transition-all duration-200 active:scale-[0.97] neon-glow cursor-pointer"
      >
        Continue Training
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── Training Progress (Progress Report) ────────────────────────────────

function TrainingProgress({
  profile,
  stats,
}: {
  profile: TrainingProfile;
  stats: ReturnType<typeof buildTrainingStats>;
}) {
  // Detected counts (from saved data) merged with completed counts (history)
  const rows: {
    target: string;
    detected: number;
    completed: number;
  }[] = [];

  const practiced = new Map(stats.mostPracticed.map((m) => [m.target, m.count]));
  for (const o of profile.onsets.slice(0, 5)) {
    rows.push({
      target: o.letter.toUpperCase(),
      detected: o.count,
      completed: practiced.get(o.letter.toUpperCase()) ?? 0,
    });
  }
  const fillerDetected = profile.fillers.reduce((s, f) => s + f.count, 0);
  if (fillerDetected > 0) {
    rows.push({
      target: "Fillers",
      detected: fillerDetected,
      completed: practiced.get("Fillers") ?? 0,
    });
  }
  // Completed targets not tied to a detected pattern (pace/hesitation/etc.)
  for (const [target, count] of practiced) {
    if (rows.some((r) => r.target === target)) continue;
    rows.push({ target, detected: 0, completed: count });
  }

  return (
    <section className="glass rounded-2xl p-5 border border-neon-purple/10">
      <SectionTitle
        icon={Dumbbell}
        title="Training Progress"
        hint="practice measured, not clinical claims"
      />

      {/* Stat tiles */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="glass-subtle rounded-xl p-3 text-center">
          <p className="font-heading text-2xl font-bold text-neon-purple">
            {stats.totalCompleted}
          </p>
          <p className="text-[9px] text-soft-gray/50 uppercase tracking-wide mt-0.5">
            Exercises Completed
          </p>
        </div>
        <div className="glass-subtle rounded-xl p-3 text-center">
          <p className="font-heading text-2xl font-bold text-electric-violet">
            {formatPracticeTime(stats.totalPracticeSeconds)}
          </p>
          <p className="text-[9px] text-soft-gray/50 uppercase tracking-wide mt-0.5">
            Practice Time
          </p>
        </div>
        <div className="glass-subtle rounded-xl p-3 text-center">
          <p className="font-heading text-2xl font-bold text-white truncate">
            {stats.currentFocus ?? "—"}
          </p>
          <p className="text-[9px] text-soft-gray/50 uppercase tracking-wide mt-0.5">
            Current Focus
          </p>
        </div>
      </div>

      {stats.totalCompleted === 0 ? (
        <div className="text-center py-4">
          <Dumbbell className="w-6 h-6 text-soft-gray/25 mx-auto mb-2" />
          <p className="text-xs text-soft-gray/60 leading-relaxed">
            No exercises completed yet. Hit TRAIN on any recommendation above —
            your completed exercises and practice time will show up here and
            survive refresh and login.
          </p>
        </div>
      ) : (
        <>
          {/* Detected + completed rows (spec example structure) */}
          <div className="space-y-2 mb-5">
            {rows.slice(0, 6).map((r) => {
              const maxCompleted = Math.max(...rows.map((x) => x.completed), 1);
              return (
                <div key={r.target} className="flex items-center gap-3 text-sm">
                  <span className="w-16 text-white/80 font-semibold truncate">
                    {r.target}
                  </span>
                  <span className="text-[10px] text-soft-gray/60 w-20 shrink-0">
                    {r.detected > 0
                      ? `${r.detected} detected`
                      : "library practice"}
                  </span>
                  <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-neon-purple to-electric-violet transition-all duration-500"
                      style={{ width: `${(r.completed / maxCompleted) * 100}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-soft-gray/60 w-24 text-right shrink-0">
                    {r.completed} exercise{r.completed === 1 ? "" : "s"} done
                  </span>
                </div>
              );
            })}
          </div>

          {/* Recent exercises */}
          <div>
            <p className="text-[10px] uppercase tracking-wider text-soft-gray/50 font-medium mb-2">
              Recent Exercises
            </p>
            <div className="space-y-1.5">
              {stats.recent.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="text-white/80 truncate">
                    {c.exerciseName}
                  </span>
                  <span className="flex items-center gap-2 shrink-0 text-soft-gray/50">
                    <span className="inline-flex items-center gap-1">
                      <Timer className="w-3 h-3" />
                      {formatPracticeTime(c.durationSeconds)}
                    </span>
                    <span>
                      {new Date(c.completedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <p className="text-[10px] text-soft-gray/40 mt-4">
            Progress measures practice only — BOLO never claims exercises cure
            stuttering or improve speech clinically.
          </p>
        </>
      )}
    </section>
  );
}
