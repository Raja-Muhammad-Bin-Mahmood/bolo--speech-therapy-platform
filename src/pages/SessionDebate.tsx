/**
 * BOLO — SessionDebate (remodeled: stealth analysis + post-debate reveal)
 *
 * The debate is now a "close-to-the-chest" speaking mode:
 *   1. Pick a topic → the FULL Free Practice pipeline starts silently
 *      (mic → AudioWorklet DSP lane + Speechmatics live transcription +
 *      RMS/ZCR sensor + evidence fusion + stutter-recovery engine + pace
 *      engine) and keeps running in the background for the WHOLE debate —
 *      exactly the same analysis Free Practice runs.
 *   2. While you debate, NONE of that analysis is visible: no stutter
 *      chips, no pace meter, no live transcript. You just argue with the AI.
 *   3. When the debate ends, the reveal unpacks everything that was
 *      captured quietly: real clarity/fluency scores, pace-under-pressure,
 *      and the FULL annotated transcript — stutters, stammers, blocks,
 *      repetitions, prolongations, fillers, pauses and recovered words —
 *      rendered with the same fusion gates as the Free Practice review.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Zap,
  ChevronRight,
  Brain,
  MessageSquare,
  Volume2,
  Sparkles,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Navbar from "../components/Navbar";
import DebateStage from "../components/DebateStage";
import RecordButton from "../components/RecordButton";
import DebatePaceSummary from "../components/DebatePaceSummary";
import StutterSpan from "../components/StutterSpan";
import FeedChip from "../components/FeedChip";
import { useAudioCapture } from "../hooks/useAudioCapture";
import { useSpeechmaticsWS } from "../hooks/useSpeechmaticsWS";
import {
  useAcousticAnalysis,
  type AcousticEvent,
} from "../hooks/useAcousticAnalysis";
import { useAnalyserSensor } from "../hooks/useAnalyserSensor";
import {
  useSessionAnalysis,
  buildTimeline,
  finalizeSessionScore,
} from "../hooks/useSessionAnalysis";
import { usePaceEngine } from "../hooks/usePaceEngine";
import { useEventEngine } from "../hooks/useEventEngine";
import { useLiveEvidenceFusion } from "../hooks/useEvidenceFusion";
import { useEvidenceTuning } from "../context/EvidenceTuningContext";
import { scoreAcousticEvents, type ScoredEvent } from "../lib/evidenceFusion";
import {
  toFeedEvents,
  assignEventsToSpans,
  type FeedEvent,
} from "../lib/feedEvents";
import { buildRecoveredItems } from "../lib/recoveryRender";
import { visibleTagForWord } from "../lib/evidenceGating";
import type { RecoveredAnnotation } from "../lib/recoveryTypes";
import type { PauseEvent } from "../lib/pauseDetector";
import type { PaceReport } from "../lib/paceEngine";

// ─── AI Debate Topics ────────────────────────────────────────────────────

const DEBATE_TOPICS = [
  {
    topic: "Remote work vs. office work",
    opener:
      "I believe working from an office fosters better collaboration and company culture. How can teams truly innovate without face-to-face interaction?",
  },
  {
    topic: "AI in healthcare",
    opener:
      "Artificial intelligence will revolutionize medicine, but we must be cautious. Can we trust machines with human life?",
  },
  {
    topic: "Social media and mental health",
    opener:
      "Social media connects us globally, but at what cost? Studies show it increases anxiety and depression, especially in young people.",
  },
  {
    topic: "Space exploration funding",
    opener:
      "Why spend billions on space when we have problems on Earth? Isn't it irresponsible to fund Mars missions while people go hungry?",
  },
  {
    topic: "Electric vehicles",
    opener:
      "Electric vehicles are the future, but the transition is happening too fast. Our infrastructure simply isn't ready.",
  },
];

const AI_RESPONSES: Record<string, string[]> = {
  "Remote work vs. office work": [
    "That's a fair point — I agree that spontaneous collaboration has value. But isn't it possible that forced interaction isn't true collaboration? Many people report being more productive at home. Don't we need to redefine what collaboration means?",
    "I understand your perspective, but let me challenge it. The data shows hybrid models actually improve retention and reduce burnout. Are we prioritizing tradition over well-being?",
  ],
  "AI in healthcare": [
    "You raise valid concerns about trust. But consider this — AI doesn't get tired, doesn't have biases in the same way humans do, and can process millions of records in seconds. Isn't it more dangerous not to use every tool we have?",
    "I appreciate your caution. But haven't we always been cautious with new technology? The question isn't whether machines are perfect — it's whether they're better than the alternative.",
  ],
  "Social media and mental health": [
    "I see your concern, but isn't the issue how we use these tools rather than the tools themselves? Social media has also given voice to marginalized communities and connected people who would otherwise be isolated.",
    "The studies you mention are correlational, not causal. Could it be that people who are already struggling are drawn to social media, rather than social media causing the struggle?",
  ],
  "Space exploration funding": [
    "That's a compelling argument. But space exploration has given us countless technologies we use every day — from GPS to medical imaging. Could it be that investing in the future is the most responsible thing we can do?",
    "I hear your concern about priorities. But the same people who work on space technology also contribute to solving Earth's problems. Isn't it possible to do both?",
  ],
  "Electric vehicles": [
    "You make a good point about infrastructure. But didn't we say the same thing about the internet, about smartphones, about renewable energy? Every revolution feels impossible until it isn't.",
    "I understand the infrastructure concern. But isn't waiting for perfect infrastructure a recipe for inaction? We need to build as we go — that's how progress has always worked.",
  ],
};

const AI_CHALLENGES = [
  "Could you elaborate on that? I'm not sure I follow your reasoning.",
  "That's interesting — but have you considered the opposite perspective?",
  "I'd push back on that point. What evidence supports your claim?",
  "You said something just now that I'd like to explore further. Can you rephrase that?",
  "I'm not convinced yet. Help me understand your position more clearly.",
];

// ─── Circular Score ──────────────────────────────────────────────────────

function CircularScore({
  score,
  label,
}: {
  score: number;
  label: string;
}) {
  const circumference = 2 * Math.PI * 36;
  const offset = circumference * (1 - score / 100);
  return (
    <div className="flex flex-col items-center">
      <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
        <circle
          cx="40"
          cy="40"
          r="36"
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="4"
        />
        <circle
          cx="40"
          cy="40"
          r="36"
          fill="none"
          stroke="url(#debateScore)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-1000"
        />
        <defs>
          <linearGradient id="debateScore" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#6D56FF" />
            <stop offset="100%" stopColor="#BD8CFF" />
          </linearGradient>
        </defs>
      </svg>
      <span className="font-heading text-2xl font-bold text-white -mt-12">
        {score}%
      </span>
      <span className="text-[10px] text-soft-gray/60 mt-0.5">{label}</span>
    </div>
  );
}

// ─── Reveal vocabulary (same tags + colors as the Free Practice review) ──

const TAG_STYLES: Record<string, string> = {
  filler: "text-amber-300/90 bg-amber-300/10",
  block: "text-orange-300/90 bg-orange-400/10",
  repetition: "text-red-300/90 bg-red-400/10",
  prolongation: "text-pink-300/90 bg-pink-400/10",
  stutter: "text-red-300/90 bg-red-500/10",
  stammer: "text-[#BD8CFF]/90 bg-[#BD8CFF]/10",
};

const TAG_LABELS: Record<string, string> = {
  filler: "Filler",
  block: "Block",
  repetition: "Repetition",
  prolongation: "Prolongation",
  stutter: "Stutter",
  stammer: "Stammer",
};

const PAUSE_LABELS: Record<string, string> = {
  natural: "·",
  thinking: "…",
  awkward: "|",
  severe: "||",
  hesitation_sequence: "||",
};

interface DebateResult {
  clarityScore: number;
  fluencyScore: number;
  overallScore: number;
  totalWords: number;
  disfluentWords: number;
  disfluencyRate: number;
  wpm: number;
  stutters: number;
  stammers: number;
  fillers: number;
  topFiller: string;
  taggedWords: {
    word: string;
    startTime: number;
    endTime: number;
    confidence: number;
    utterance: number;
    tag: string | null;
    fused: number;
  }[];
  pauseEvents: PauseEvent[];
  feedEvents: FeedEvent[];
  acousticEvents: AcousticEvent[];
  sensorEvents: AcousticEvent[];
  recoveredAnnotations: RecoveredAnnotation[];
  pauses: { total: number; thinking: number; awkward: number; severe: number };
  paceReport: PaceReport;
  reasons: string[];
}

type RevealItem =
  | {
      kind: "word";
      word: string;
      tag: string | null;
      startTime: number;
      endTime: number;
      events?: FeedEvent[];
      recovered?: RecoveredAnnotation | null;
    }
  | { kind: "pause"; event: PauseEvent }
  | { kind: "recovered"; rec: RecoveredAnnotation };

// ─── Main Component ──────────────────────────────────────────────────────

export default function SessionDebate() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<
    "choose" | "speaking" | "listening" | "result"
  >("choose");
  const [topicIndex] = useState(0);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [turn, setTurn] = useState(0);
  const maxTurns = 4;
  const [ambientAudio, setAmbientAudio] = useState(false);
  const [result, setResult] = useState<DebateResult | null>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [micFailed, setMicFailed] = useState(false);
  const finishLockRef = useRef(false);
  const turnLockRef = useRef(false);

  // ── Speech + detection pipeline — the SAME fusion stack as Free
  // Practice, running silently for the whole debate. `sessionActive`
  // stays true across every turn (the hooks clear their buffers when
  // inactive, so it must NOT toggle between turns) — this is the
  // "analysis in the background" part. ─────────────────────────────
  const audio = useAudioCapture();
  const ws = useSpeechmaticsWS();
  const acoustic = useAcousticAnalysis(audio.getAnalyser, sessionActive);
  const sensor = useAnalyserSensor(audio.getAnalyser, sessionActive);
  const analysis = useSessionAnalysis(ws.transcripts, acoustic.events);
  const pace = usePaceEngine();

  // Combined acoustic lane (worklet DSP + RMS/ZCR sensor) — same as Free Practice
  const allAcoustic = useMemo(
    () => [...acoustic.events, ...sensor.events],
    [acoustic.events, sensor.events]
  );

  // Stage 3: event-centric stutter recovery (same engine as Free Practice)
  const recovery = useEventEngine({
    active: sessionActive && ws.status === "connected",
    getStreamTime: audio.getStreamTime,
    setOnPcm: audio.setOnPcm,
    transcripts: ws.transcripts,
    events: allAcoustic,
  });

  // Evidence fusion still scores + gates everything in the background.
  // The verdicts are applied to the reveal; nothing is rendered live.
  useLiveEvidenceFusion(ws.transcripts, allAcoustic, analysis.pauseEvents);

  // Wire PCM → Speechmatics
  useEffect(() => {
    audio.setOnAudioData(ws.sendAudio);
  }, [audio, ws.sendAudio]);

  // Pin the stutter clock the moment Speechmatics confirms it's ready
  useEffect(() => {
    if (ws.status === "connected") audio.pinClock();
  }, [ws.status, audio]);

  // Feed the shared pace engine live (same as Free Practice)
  useEffect(() => {
    pace.feedTranscripts(ws.transcripts);
  }, [ws.transcripts, pace]);
  useEffect(() => {
    pace.feedPauses(analysis.pauseEvents);
  }, [analysis.pauseEvents, pace]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      audio.stop();
      ws.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mic-denied detection (same behaviour as Free Practice)
  useEffect(() => {
    if (phase !== "speaking") {
      setMicFailed(false);
      return;
    }
    const t = setTimeout(() => {
      if (!audio.isActive) setMicFailed(true);
    }, 2500);
    return () => clearTimeout(t);
  }, [phase, audio.isActive]);

  const currentTopic = selectedTopic
    ? DEBATE_TOPICS.find((t) => t.topic === selectedTopic) || DEBATE_TOPICS[topicIndex]
    : DEBATE_TOPICS[topicIndex];

  const currentAiResponse =
    turn > 0 && selectedTopic
      ? (AI_RESPONSES[selectedTopic]?.[(turn - 1) % (AI_RESPONSES[selectedTopic]?.length || 1)] ||
          AI_CHALLENGES[(turn - 1) % AI_CHALLENGES.length])
      : currentTopic?.opener || "";

  // ── Start: topic chosen → the silent pipeline begins (once, for all turns) ──
  const handleSelectTopic = (topic: string) => {
    setSelectedTopic(topic);
    finishLockRef.current = false;
    turnLockRef.current = false;
    pace.reset();
    // Brief delay for dramatic effect, then the mic + transcription start
    // quietly in the background.
    setTimeout(() => {
      setSessionActive(true);
      audio.start();
      ws.connect();
      setPhase("speaking");
    }, 300);
  };

  // ── Finish: capture the whole debate (same finalize as Free Practice) ──
  const finishDebate = useCallback(() => {
    if (finishLockRef.current) return;
    finishLockRef.current = true;

    // Capture final data BEFORE the pipeline resets (the hooks clear their
    // refs when `sessionActive` flips false).
    const finalTranscripts = ws.snapshotTranscripts();
    const finalAcoustic = acoustic.getEvents();
    const sensorEvents = sensor.getEvents();
    const allEvents = [...finalAcoustic, ...sensorEvents];
    const finalScore = finalizeSessionScore(finalTranscripts, allEvents);
    const paceReport = pace.finalize();
    const { taggedWords, pauseEvents } = buildTimeline(
      finalTranscripts,
      allEvents
    );
    const recoverySnapshot = recovery.annotations;
    const feedEvents = toFeedEvents(allEvents);

    const disfluentWords = taggedWords.filter((w) => w.tag).length;

    // Filler breakdown (same as Free Practice)
    const fillerCounts: Record<string, number> = {};
    for (const w of taggedWords) {
      if (w.tag !== "filler") continue;
      const key = w.word.toLowerCase().replace(/[^a-z]/g, "");
      if (!key) continue;
      fillerCounts[key] = (fillerCounts[key] ?? 0) + 1;
    }
    const topFiller =
      Object.entries(fillerCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
      "none";

    setResult({
      clarityScore: Math.max(0, Math.round(100 - finalScore.clarityPenalty)),
      fluencyScore: Math.max(0, Math.round(100 - finalScore.fluencyPenalty)),
      overallScore: finalScore.score,
      totalWords: finalScore.totalWords,
      disfluentWords,
      disfluencyRate: finalScore.disfluencyRate,
      wpm: finalScore.wpm,
      stutters: finalScore.stutters,
      stammers: finalScore.stammers,
      fillers: finalScore.fillers,
      topFiller,
      taggedWords,
      pauseEvents,
      feedEvents,
      acousticEvents: finalAcoustic,
      sensorEvents,
      recoveredAnnotations: recoverySnapshot,
      pauses: {
        total: finalScore.pauses.total,
        thinking: finalScore.pauses.thinking,
        awkward: finalScore.pauses.awkward,
        severe: finalScore.pauses.severe,
      },
      paceReport,
      reasons: finalScore.reasons,
    });

    // Stop the session — the reveal is a pure replay of what was captured.
    audio.stop();
    ws.disconnect();
    setSessionActive(false);
    setPhase("result");
  }, [ws, acoustic, sensor, pace, recovery.annotations]);

  // ── Turn flow: mic button ends YOUR turn; the AI takes the floor for a
  // moment (analysis keeps running silently), then it's your turn again. ──
  const handleEndTurn = useCallback(() => {
    if (turnLockRef.current) return;
    turnLockRef.current = true;
    if (turn < maxTurns) {
      setPhase("listening");
      setTimeout(() => {
        turnLockRef.current = false;
        setTurn((t) => t + 1);
        setPhase("speaking");
      }, 2500);
    } else {
      finishDebate();
    }
  }, [turn, finishDebate]);

  const handleNewDebate = () => {
    setPhase("choose");
    setTurn(0);
    setSelectedTopic(null);
    setResult(null);
    finishLockRef.current = false;
    turnLockRef.current = false;
    pace.reset();
  };

  // ── Reveal data: recompute fusion verdicts + annotated transcript from
  // the captured session, with the SAME gates as the Free Practice review. ──
  const { weights } = useEvidenceTuning();

  const revealScored: ScoredEvent[] = useMemo(() => {
    if (!result) return [];
    const raw: unknown[] = [...result.acousticEvents, ...result.sensorEvents];
    if (raw.length === 0) return [];
    const words = result.taggedWords.map((w) => ({
      text: w.word,
      startTime: w.startTime,
      endTime: w.endTime,
    }));
    const sortedPauses = [...result.pauseEvents].sort(
      (a, b) => a.startTime - b.startTime
    );
    return scoreAcousticEvents(
      raw as any[],
      { words, pauses: sortedPauses },
      weights
    );
  }, [result, weights]);

  const reviewWords = useMemo(
    () =>
      result
        ? result.taggedWords.map((w) => ({
            text: w.word,
            startTime: w.startTime,
            endTime: w.endTime,
          }))
        : [],
    [result]
  );

  const revealItems = useMemo<RevealItem[]>(() => {
    if (!result) return [];
    const items: RevealItem[] = result.taggedWords.map((w) => ({
      kind: "word",
      word: w.word,
      tag: w.tag,
      startTime: w.startTime,
      endTime: w.endTime,
    }));

    // Attach existing detector events to their overlapping words by timestamp
    const wordSpans = result.taggedWords.map((w) => ({
      startTime: w.startTime,
      endTime: w.endTime,
    }));
    const assignments = assignEventsToSpans(result.feedEvents, wordSpans);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "word") {
        it.events = assignments[i] ?? [];
      }
    }

    // Attach recovery annotations to their overlapping words (Stage 3)
    const recAssignment = buildRecoveredItems(result.recoveredAnnotations, wordSpans);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "word") {
        it.recovered = recAssignment.attachedByIndex[i] ?? null;
      }
    }

    // Inject scoreable pause badges
    const sortedPauses = [...result.pauseEvents].sort(
      (a, b) => a.startTime - b.startTime
    );
    for (const p of sortedPauses) {
      if (!p.shouldColor) continue;
      const pauseEndMs = p.endTime * 1000;
      let inserted = false;
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        if (item.kind !== "word") continue;
        if (item.startTime * 1000 >= pauseEndMs) {
          items.splice(idx, 0, { kind: "pause", event: p });
          inserted = true;
          break;
        }
      }
      if (!inserted) items.push({ kind: "pause", event: p });
    }

    // Insert standalone recovery annotations inline by timestamp
    for (const rec of recAssignment.standalone) {
      let inserted = false;
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        if (item.kind !== "word") continue;
        if (item.startTime >= rec.startTime) {
          items.splice(idx, 0, { kind: "recovered", rec });
          inserted = true;
          break;
        }
      }
      if (!inserted) items.push({ kind: "recovered", rec });
    }

    return items;
  }, [result]);

  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!result) return counts;
    for (const w of result.taggedWords) {
      if (!w.tag) continue;
      counts[w.tag] = (counts[w.tag] ?? 0) + 1;
    }
    return counts;
  }, [result]);

  const getCoachNote = (r: DebateResult): string => {
    if (r.disfluencyRate > 15) {
      return `Tough crowd — ${r.disfluencyRate}% of your words carried a disfluency. Keep your openings short, pause on purpose, and let the AI's challenge reset your pace.`;
    }
    if (r.disfluencyRate > 8) {
      return `Solid engagement with a moderate ${r.disfluencyRate}% disfluency rate. Replacing "${r.topFiller}" with a deliberate pause will sharpen your rebuttals.`;
    }
    if (r.totalWords > 0 && r.wpm > 0 && (r.wpm < 120 || r.wpm > 160)) {
      return `Your argument was clear (${r.disfluencyRate}% disfluency) but the clock shows ${r.wpm} WPM. Aim for the 120–160 band to land each point with authority.`;
    }
    return `Strong debate — only ${r.disfluencyRate}% disfluency under pressure. Try a tougher topic next round to stretch your fluency.`;
  };

  return (
    <div className="min-h-screen relative overflow-hidden bg-deep-space">
      <Navbar />

      {/* ── Topic selection overlay ───────────────────────────────── */}
      <AnimatePresence>
        {phase === "choose" && (
          <motion.div
            key="topic-select"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-deeper-space/90 backdrop-blur-sm"
          >
            <div className="glass rounded-2xl p-6 max-w-lg w-full mx-4">
              <button
                onClick={() => navigate("/dashboard")}
                className="flex items-center gap-1.5 text-sm text-soft-gray hover:text-white transition-colors mb-4 cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to Dashboard
              </button>

              <h2 className="font-heading text-lg font-semibold text-white mb-1">
                Choose a Debate Topic
              </h2>
              <p className="text-xs text-soft-gray/60 mb-4">
                Step up to the podium. BOLO listens quietly and reveals your
                full annotated transcript when the debate ends.
              </p>
              <div className="space-y-2">
                {DEBATE_TOPICS.map((d) => (
                  <button
                    key={d.topic}
                    onClick={() => handleSelectTopic(d.topic)}
                    className="w-full text-left px-4 py-3 glass rounded-xl hover:border-neon-purple/30 transition-all active:scale-[0.98] cursor-pointer"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-white font-medium">
                        {d.topic}
                      </span>
                      <ChevronRight className="w-4 h-4 text-soft-gray/40" />
                    </div>
                    <p className="text-[10px] text-soft-gray/50 mt-1 line-clamp-1">
                      {d.opener}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Debate Stage (full screen behind everything) ──────────── */}
      {phase !== "choose" && (
        <div className="fixed inset-0 top-0 z-0">
          <DebateStage
            isSpeaking={phase === "speaking"}
            isAIResponding={phase === "listening"}
            turn={turn}
          />
        </div>
      )}

      {/* ── HUD Overlay — deliberately free of analysis UI. No stutter
             chips, no pace meter, no live transcript: the pipeline runs
             silently in the background and only speaks at the reveal. ── */}
      {phase !== "choose" && phase !== "result" && (
        <div className="fixed inset-0 z-10 pointer-events-none">
          {/* Top center — frosted glass topic banner */}
          <div className="absolute top-20 left-1/2 -translate-x-1/2">
            <div className="glass rounded-full px-5 py-2.5 flex items-center gap-2">
              <Zap className="w-3.5 h-3.5 text-neon-purple" />
              <span className="text-sm font-heading font-medium text-white whitespace-nowrap">
                {currentTopic?.topic}
              </span>
              <div className="flex gap-1 ml-2">
                {Array.from({ length: maxTurns + 1 }, (_, i) => (
                  <div
                    key={i}
                    className={`w-1.5 h-1.5 rounded-full transition-all ${
                      i <= turn ? "bg-neon-purple" : "bg-white/10"
                    }`}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Ambient floating AI response */}
          <AnimatePresence>
            {phase === "listening" && (
              <motion.div
                key={turn}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="absolute bottom-28 left-1/2 -translate-x-1/2 max-w-lg w-full px-4"
              >
                <div className="glass-strong rounded-2xl p-4 pointer-events-auto">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Brain className="w-3 h-3 text-neon-purple" />
                    <span className="text-[10px] font-medium text-neon-purple/70">
                      AI Debater
                    </span>
                  </div>
                  <p className="text-sm text-soft-gray leading-relaxed">
                    {currentAiResponse}
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Bottom center — controls */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-auto">
            <div className="glass rounded-2xl px-6 py-3 flex items-center gap-4">
              {/* Turn indicator */}
              <span className="text-[10px] font-mono text-soft-gray/50 whitespace-nowrap">
                Turn {turn + 1}/{maxTurns + 1}
              </span>

              {/* Mic Button — tap to end YOUR turn (analysis keeps running) */}
              {phase === "speaking" && (
                <div className="flex flex-col items-center gap-1">
                  <RecordButton
                    size="md"
                    recording={true}
                    onStop={handleEndTurn}
                  />
                  <span className="text-[9px] text-soft-gray/40 whitespace-nowrap">
                    Tap to end your turn
                  </span>
                </div>
              )}

              {phase === "listening" && (
                <div className="flex items-center gap-2 text-xs text-soft-gray/50">
                  <div className="flex gap-0.5">
                    <div
                      className="w-1.5 h-1.5 rounded-full bg-neon-purple animate-bounce"
                      style={{ animationDelay: "0ms" }}
                    />
                    <div
                      className="w-1.5 h-1.5 rounded-full bg-neon-purple animate-bounce"
                      style={{ animationDelay: "150ms" }}
                    />
                    <div
                      className="w-1.5 h-1.5 rounded-full bg-neon-purple animate-bounce"
                      style={{ animationDelay: "300ms" }}
                    />
                  </div>
                  AI is responding...
                </div>
              )}

              {/* Ambient toggle */}
              <button
                onClick={() => setAmbientAudio((a) => !a)}
                className={`p-2 rounded-full transition-colors cursor-pointer ${
                  ambientAudio
                    ? "text-neon-purple bg-neon-purple/10"
                    : "text-soft-gray/40 hover:text-soft-gray"
                }`}
                title="Ambient audio"
              >
                <Volume2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Quiet reliability notes (never analysis data) */}
          {micFailed && (
            <div className="absolute bottom-24 left-1/2 -translate-x-1/2 glass rounded-full px-3 py-1 text-[10px] text-amber-300/90 border border-amber-400/20">
              Microphone not detected — allow mic access to capture your speech.
            </div>
          )}
          {!micFailed && ws.error && (
            <div className="absolute bottom-24 left-1/2 -translate-x-1/2 glass rounded-full px-3 py-1 text-[10px] text-red-300/90 border border-red-400/20">
              Transcription unavailable — {ws.error}
            </div>
          )}
        </div>
      )}

      {/* ── Results Reveal — the background analysis speaks now. ── */}
      <AnimatePresence>
        {phase === "result" && result && (
          <motion.div
            key="debate-result"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 overflow-y-auto bg-deeper-space/95 backdrop-blur-sm"
          >
            <div className="max-w-3xl mx-auto px-4 py-10">
              {/* Header */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center mb-8"
              >
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-electric-violet to-neon-purple flex items-center justify-center mx-auto mb-4 shadow-[0_0_40px_rgba(109,86,255,0.3)]">
                  <Brain className="w-8 h-8 text-white" />
                </div>
                <h2 className="font-heading text-2xl font-bold text-white mb-1">
                  Debate Complete
                </h2>
                <p className="text-sm text-soft-gray/60">
                  Topic: {selectedTopic} • {turn + 1} exchanges
                </p>
                <p className="text-[10px] text-soft-gray/40 mt-2 inline-flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-neon-purple/60" />
                  Your speech was analyzed quietly in the background — here's
                  the full transcript.
                </p>
              </motion.div>

              {/* Score rings — real numbers from the shared scoring engine */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="flex items-center justify-center gap-8 mb-8"
              >
                <CircularScore score={result.overallScore} label="Overall" />
                <CircularScore score={result.clarityScore} label="Clarity" />
                <CircularScore score={result.fluencyScore} label="Fluency" />
              </motion.div>

              {/* Compact stats strip */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 }}
                className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-8"
              >
                <RevealStat label="Words" value={result.totalWords} color="#BD8CFF" />
                <RevealStat label="Stutters" value={result.stutters} color="#F87171" />
                <RevealStat label="Stammers" value={result.stammers} color="#BD8CFF" />
                <RevealStat label="Fillers" value={result.fillers} color="#FCD34D" />
                <RevealStat label="Pauses" value={result.pauses.total} color="#60A5FA" />
                <RevealStat
                  label="WPM"
                  value={result.wpm > 0 ? result.wpm : "—"}
                  color="#34D399"
                />
              </motion.div>

              {/* Pace Under Pressure — from the shared pace engine */}
              {result.paceReport && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="mb-6"
                >
                  <DebatePaceSummary report={result.paceReport} />
                </motion.div>
              )}

              {/* ── The annotated transcript reveal ─────────────── */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25 }}
                className="glass rounded-2xl p-5 mb-6 border border-neon-purple/10"
              >
                <div className="flex items-center gap-2 mb-3">
                  <MessageSquare className="w-4 h-4 text-neon-purple" />
                  <h3 className="font-heading text-sm font-semibold text-white">
                    Your Transcript, Annotated
                  </h3>
                  <span className="ml-auto text-[10px] text-soft-gray/50">
                    {result.taggedWords.length} words
                  </span>
                </div>

                {/* Legend */}
                {Object.keys(tagCounts).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {Object.entries(tagCounts).map(([tag, count]) => (
                      <span
                        key={tag}
                        className={`text-[10px] px-2 py-0.5 rounded-full ${
                          TAG_STYLES[tag] ?? "text-soft-gray/60 bg-white/5"
                        }`}
                      >
                        {TAG_LABELS[tag] ?? tag}: {count}
                      </span>
                    ))}
                  </div>
                )}

                <div className="bg-white/5 rounded-xl p-4 max-h-80 overflow-y-auto leading-relaxed text-sm scrollbar-thin">
                  {revealItems.length === 0 ? (
                    <p className="text-xs text-soft-gray/50">
                      No speech was captured this debate — keep speaking a
                      little longer next round so BOLO can annotate your
                      transcript.
                    </p>
                  ) : (
                    <p className="text-white/80 leading-relaxed">
                      {revealItems.map((item, i) =>
                        item.kind === "pause" ? (
                          <span
                            key={`p-${i}`}
                            className="inline-flex items-center gap-1 mx-1 rounded px-1.5 py-0.5 text-[10px] font-mono align-middle"
                            style={{
                              color: item.event.colorToken,
                              backgroundColor: `${item.event.colorToken}18`,
                              border: `1px solid ${item.event.colorToken}30`,
                            }}
                            title={item.event.reason.join(" ")}
                          >
                            {PAUSE_LABELS[item.event.type] ?? "·"}
                            {(item.event.durationMs / 1000).toFixed(1)}s
                          </span>
                        ) : item.kind === "recovered" ? (
                          <StutterSpan
                            key={`r-${item.rec.id}`}
                            annotation={item.rec}
                          />
                        ) : (
                          <span
                            key={`w-${i}`}
                            className="inline-flex items-center gap-1 align-middle mr-1"
                          >
                            {item.recovered && (
                              <StutterSpan
                                annotation={item.recovered}
                                className="mr-0.5"
                              />
                            )}
                            <span
                              className={`inline-block rounded px-1 transition-colors ${
                                item.tag &&
                                visibleTagForWord(item, revealScored, reviewWords)
                                  ? `${TAG_STYLES[item.tag] ?? ""} underline decoration-dotted underline-offset-2`
                                  : ""
                              }`}
                              title={
                                item.tag ? TAG_LABELS[item.tag] : undefined
                              }
                            >
                              {item.word}
                            </span>
                            {item.events && item.events.length > 0 && (
                              <span className="inline-flex items-center gap-0.5">
                                {item.events.map((evt) => (
                                  <FeedChip key={evt.id} event={evt} />
                                ))}
                              </span>
                            )}
                          </span>
                        )
                      )}
                    </p>
                  )}
                </div>

                <p className="text-[10px] text-soft-gray/40 mt-3">
                  Colored words = detected disfluency (filler, block,
                  repetition, prolongation, stutter, stammer). Badges =
                  pauses with duration. This is exactly the annotation Free
                  Practice produces.
                </p>
              </motion.div>

              {/* Pause breakdown */}
              {result.pauses.total > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="glass-subtle rounded-2xl px-4 py-3 mb-6 flex flex-wrap items-center gap-2"
                >
                  <span className="text-[10px] uppercase tracking-wider text-soft-gray/50 font-medium mr-1">
                    Pauses
                  </span>
                  <PauseChip label="Thinking" count={result.pauses.thinking} color="#60A5FA" />
                  <PauseChip label="Awkward" count={result.pauses.awkward} color="#FBBF24" />
                  <PauseChip label="Severe" count={result.pauses.severe} color="#FB923C" />
                </motion.div>
              )}

              {/* Why these scores */}
              {result.reasons.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.35 }}
                  className="glass rounded-2xl p-5 mb-6 border border-neon-purple/10"
                >
                  <h3 className="font-heading text-sm font-semibold text-white mb-3 flex items-center gap-2">
                    <Brain className="w-4 h-4 text-neon-purple" />
                    Why These Scores
                  </h3>
                  <ul className="space-y-2">
                    {result.reasons.map((r, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 text-sm text-soft-gray leading-relaxed"
                      >
                        <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-neon-purple/70 shrink-0" />
                        {r}
                      </li>
                    ))}
                  </ul>
                </motion.div>
              )}

              {/* Coach's note */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 }}
                className="glass-strong rounded-2xl p-5 mb-8 border border-neon-purple/10"
              >
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <h3 className="font-heading text-sm font-semibold text-white">
                    Coach's Note
                  </h3>
                </div>
                <p className="text-sm text-soft-gray leading-relaxed">
                  {getCoachNote(result)}
                </p>
              </motion.div>

              {/* Actions */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.45 }}
                className="flex flex-col sm:flex-row gap-3 justify-center"
              >
                <button
                  onClick={handleNewDebate}
                  className="flex items-center justify-center gap-1.5 bg-primary hover:bg-primary-hover text-white text-sm font-medium py-2.5 px-6 rounded-xl transition-all duration-200 active:scale-[0.97] cursor-pointer"
                >
                  New Debate
                  <Zap className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => navigate("/dashboard")}
                  className="flex items-center justify-center gap-1.5 glass text-soft-gray hover:text-white text-sm font-medium py-2.5 px-6 rounded-xl transition-all duration-200 active:scale-[0.97] cursor-pointer"
                >
                  Back to Dashboard
                </button>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Reveal stat chip ────────────────────────────────────────────────────

function RevealStat({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div
      className="glass-subtle rounded-xl px-2 py-2 text-center"
      style={{ border: `1px solid ${color}30`, background: `${color}0d` }}
    >
      <p
        className="text-base font-heading font-bold leading-none tabular-nums"
        style={{ color }}
      >
        {value}
      </p>
      <p className="text-[9px] text-soft-gray/50 mt-1 uppercase tracking-wide">
        {label}
      </p>
    </div>
  );
}

// ─── Pause count chip ────────────────────────────────────────────────────

function PauseChip({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-mono"
      style={{
        color,
        backgroundColor: `${color}18`,
        border: `1px solid ${color}30`,
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      {count} {label.toLowerCase()}
    </span>
  );
}
