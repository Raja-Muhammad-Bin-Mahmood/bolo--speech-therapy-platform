/**
 * BOLO — SessionScript (Script Mode)
 *
 * Script Mode runs the SAME live speech/disfluency detection pipeline as
 * Free Speech (the reference implementation) — it reuses its existing
 * detection/data logic unchanged:
 *
 *   • Deepgram transcription (PRIMARY, same config)
 *   • Speechmatics fallback transcription
 *   • worklet DSP + RMS/ZCR/ΔEnergy sensor lanes → ONE merged event pool
 *   • the same purple disfluency logic (structured Deepgram tags + fusion)
 *   • the same reconciler token array (single source of truth)
 *   • the same session analysis, structured disfluency data, recovery
 *     engine, pace engine, markers and persistence
 *
 * Only the PRESENTATION changes:
 *   • the script is displayed as continuous PAGES (~6 lines) that advance
 *     automatically as the user approaches the end of the visible section
 *   • a detected stutter/disfluency marks the CORRESPONDING script word
 *     with the existing purple disfluency styling — the script text is
 *     preserved exactly, never replaced, never overwritten with raw
 *     Deepgram stutter spelling (correlation is sequence/timing based)
 *   • fillers surface through a small unobtrusive "+1 FILLER" indicator
 *   • at session end the SAME Free Speech-style /analysis experience is
 *     produced from the SAME event/token model.
 */
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  BookOpen,
  Sparkles,
  StopCircle,
  Gauge,
  Flag,
  TimerReset,
} from "lucide-react";
import LiquidBackground from "../components/LiquidBackground";
import Navbar from "../components/Navbar";
import RecordButton from "../components/RecordButton";
import SessionTimer from "../components/SessionTimer";
import ScriptPager from "../components/ScriptPager";
import PaceMeter from "../components/PaceMeter";
import { SLP_PASSAGES, getRandomPassage, type SLPPassage } from "../data/slpPassages";
import { useAudioCapture } from "../hooks/useAudioCapture";
import { useSpeechmaticsWS } from "../hooks/useSpeechmaticsWS";
import { useAcousticAnalysis } from "../hooks/useAcousticAnalysis";
import { useAnalyserSensor } from "../hooks/useAnalyserSensor";
import { useDeepgramWS } from "../hooks/useDeepgramWS";
import { useTranscriptReconciler } from "../hooks/useTranscriptReconciler";
import { useSessionAnalysis } from "../hooks/useSessionAnalysis";
import { useSessionDisfluencies } from "../hooks/useSessionDisfluencies";
import { useScriptMatcher, type ScriptMetrics } from "../hooks/useScriptMatcher";
import { useEventEngine } from "../hooks/useEventEngine";
import { useLiveEvidenceFusion } from "../hooks/useEvidenceFusion";
import { usePaceEngine, usePaceSnapshot } from "../hooks/usePaceEngine";
import { useAuth } from "../context/AuthContext";
import type { TranscriptToken as TranscriptTokenLike } from "../lib/transcriptTokens";
import { mergeAcousticEvents } from "../lib/mergeAcousticEvents";
import { buildDgFinalChunks, mergeFinalChunks } from "../lib/finalChunks";
import { buildAnalysisPayload } from "../lib/analysisPayload";
import { correlateScriptTokens, type ScriptTokenAnnotation } from "../lib/scriptCorrelation";
import {
  persistSessionDisfluencies,
  type SessionDisfluencySnapshot,
} from "../lib/sessionDisfluencies";
import {
  makeMarkerId,
  persistMarkers,
  persistEvents,
  type OfficialDisfluencyEvent,
  type SessionMarker,
  type UserAccount,
} from "../lib/manualAnnotations";
import { diagBanner } from "../lib/diagnosticLog";

type Phase = "ready" | "recording" | "processing";

export default function SessionScript() {
  const navigate = useNavigate();
  const { user, isLocal, saveSessionData } = useAuth();

  // ── Passage (randomize/select with the existing library animation) ──
  const [passage, setPassage] = useState<SLPPassage>(() => getRandomPassage());
  const [selectedPassage, setSelectedPassage] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [phase, setPhase] = useState<Phase>("ready");
  const [isRecording, setIsRecording] = useState(false);
  const finishLockRef = useRef(false);

  // ── Manual markers (SPACE / MARKER button) — same model as Free Speech ──
  const [markers, setMarkers] = useState<SessionMarker[]>([]);
  const markersRef = useRef<SessionMarker[]>([]);
  const sessionIdRef = useRef<string>(`script-${Date.now().toString(36)}`);
  const userRef = useRef<UserAccount | null>(null);
  useEffect(() => {
    if (!user) return;
    userRef.current = { id: user.id, isLocal };
  }, [user, isLocal]);

  // ══ SAME DETECTION PIPELINE AS FREE SPEECH (reference implementation) ══
  const audio = useAudioCapture();
  const ws = useSpeechmaticsWS();
  const acoustic = useAcousticAnalysis(audio.getAnalyser, isRecording);
  const sensor = useAnalyserSensor(audio.getAnalyser, isRecording);

  // ONE shared merged event pool (worklet DSP + RMS/ZCR sensor) — the same
  // pool every surface reads in Free Speech.
  const allAcoustic = useMemo(
    () => mergeAcousticEvents(acoustic.events, sensor.events),
    [acoustic.events, sensor.events]
  );

  // Deepgram PRIMARY live transcription (same config as Free Speech).
  const dg = useDeepgramWS({
    getAnalyser: audio.getAnalyser,
    getSampleRate: audio.getSampleRate,
    acousticEvents: allAcoustic,
  });

  // Same final-word timeline builders (Deepgram primary + SM fallback).
  const dgFinalChunks = useMemo(() => buildDgFinalChunks(dg.finals), [dg.finals]);
  const mergedFinalChunks = useMemo(
    () => mergeFinalChunks(dgFinalChunks, ws.transcripts),
    [dgFinalChunks, ws.transcripts]
  );

  // Same session analysis (purple disfluency logic + scoring + pauses).
  const analysis = useSessionAnalysis(mergedFinalChunks, allAcoustic);

  // Same live transcript token array (single source of truth).
  const reconciler = useTranscriptReconciler({
    active: isRecording,
    transcripts: ws.transcripts,
    deepgramFinals: dg.finals,
  });

  // ── SCRIPT-SPECIFIC CORRELATION ────────────────────────────────────────
  // The matcher aligns the SAME final-word timeline to the script token
  // sequence (exact + tolerant lookahead + time stamps). correlateScriptTokens
  // merges the Free Speech tag map onto each matched script token by
  // temporal overlap so the CORRECT script word receives the annotation.
  const matcher = useScriptMatcher(passage.text, mergedFinalChunks, allAcoustic);
  const scriptAnnotations = useMemo(
    () => correlateScriptTokens(matcher.metrics.tokenDetails, analysis.taggedWords),
    [matcher.metrics.tokenDetails, analysis.taggedWords]
  );
  const scriptAnnotationsRef = useRef<ScriptTokenAnnotation[]>([]);
  useEffect(() => {
    scriptAnnotationsRef.current = scriptAnnotations;
  }, [scriptAnnotations]);

  // Live ref of matcher metrics (used by the recovery scriptWord memo).
  const scriptMetricsRef = useRef<ScriptMetrics>(matcher.metrics);
  useEffect(() => {
    scriptMetricsRef.current = matcher.metrics;
  }, [matcher.metrics]);

  // Same Stage-3 event-centric recovery (with the script anchor).
  const recovery = useEventEngine({
    active: isRecording && ws.status === "connected",
    getStreamTime: audio.getStreamTime,
    setOnPcm: audio.setOnPcm,
    transcripts: ws.transcripts,
    events: allAcoustic,
    scriptWord: useMemo(() => {
      const idx = scriptMetricsRef.current.activeTokenIndex;
      const detail = scriptMetricsRef.current.tokenDetails?.[idx];
      if (
        idx < 0 ||
        !detail ||
        detail.state === "matched" ||
        detail.state === "skipped" ||
        detail.disfluency
      ) {
        return null;
      }
      return passage.text.split(/\s+/)[idx] ?? null;
    }, [passage.text]),
  });

  // Same evidence-fusion layer (side effects + dev panel parity).
  useLiveEvidenceFusion(ws.transcripts, allAcoustic, analysis.pauseEvents);

  // Same structured session-disfluency collector (full word + firstLetter /
  // full filler word + type + timestamp + sentence).
  const disfluencyCollector = useSessionDisfluencies(reconciler.tokens, analysis.wordTags);

  // Same shared pace engine.
  const pace = usePaceEngine();
  const paceSnapshot = usePaceSnapshot(isRecording ? pace.engine : null);

  // ── FINAL LIVE TRANSCRIPT SNAPSHOT (single source of truth) ──────────
  const finalTokensRef = useRef<TranscriptTokenLike[]>([]);
  const finalHiddenKeysRef = useRef<string[]>([]);
  const mergedDuplicateKeys = useMemo(() => {
    const merged = new Set(recovery.duplicateKeys);
    for (const k of reconciler.hiddenSpeechmaticsKeys) merged.add(k);
    return merged;
  }, [recovery.duplicateKeys, reconciler.hiddenSpeechmaticsKeys]);
  useEffect(() => {
    if (isRecording) {
      finalTokensRef.current = reconciler.tokens as unknown as TranscriptTokenLike[];
      finalHiddenKeysRef.current = Array.from(mergedDuplicateKeys);
    }
  }, [isRecording, reconciler.tokens, mergedDuplicateKeys]);

  // Wire PCM → Speechmatics + Deepgram (one shared mic stream).
  useEffect(() => {
    audio.setOnAudioData((buf) => {
      ws.sendAudio(buf);
      dg.sendAudio(buf);
    });
  }, [audio, ws.sendAudio, dg.sendAudio]);

  // Pin the shared session clock when Speechmatics confirms it's ready.
  useEffect(() => {
    if (ws.status === "connected") audio.pinClock();
  }, [ws.status, audio]);

  // Feed the shared pace engine live (words + pauses).
  useEffect(() => {
    if (!isRecording) return;
    pace.feedTranscripts(mergedFinalChunks);
  }, [mergedFinalChunks, isRecording, pace]);
  useEffect(() => {
    if (!isRecording) return;
    pace.feedPauses(analysis.pauseEvents);
  }, [analysis.pauseEvents, isRecording, pace]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      audio.stop();
      ws.disconnect();
      dg.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Filler indicator ("+1 FILLER" pops) — same filler classification as
  // Free Speech (the session analysis tag map). ───────────────────────────
  const fillerCount = analysis.score.fillers;
  const [fillerPops, setFillerPops] = useState<{ id: number }[]>([]);
  const prevFillerRef = useRef(0);
  useEffect(() => {
    if (fillerCount <= prevFillerRef.current) {
      prevFillerRef.current = Math.max(prevFillerRef.current, fillerCount);
      return;
    }
    prevFillerRef.current = fillerCount;
    const id = Date.now();
    setFillerPops((p) => [...p.slice(-3), { id }]);
    const t = setTimeout(() => {
      setFillerPops((p) => p.filter((x) => x.id !== id));
    }, 1500);
    return () => clearTimeout(t);
  }, [fillerCount]);

  // ── Insert marker (SPACE / MARKER button) — same as Free Speech ────────
  const insertMarker = useCallback(() => {
    if (!isRecording || finishLockRef.current) return;
    const nowSec = audio.getStreamTime();
    if (nowSec == null) return;
    const timeMs = Math.max(0, Math.round(nowSec * 1000));
    const sorted = [...reconciler.tokens].sort((a, b) => a.startTimeMs - b.startTimeMs);
    let nearest: TranscriptTokenLike | null = null;
    let bestDist = Infinity;
    for (const t of sorted) {
      const dist = Math.abs(t.startTimeMs - timeMs);
      if (dist < bestDist) {
        bestDist = dist;
        nearest = t;
      }
    }
    const marker: SessionMarker = {
      id: makeMarkerId(),
      sessionId: sessionIdRef.current,
      timeMs,
      tokenId: nearest && bestDist <= 4000 ? nearest.id : null,
      createdAt: new Date().toISOString(),
    };
    setMarkers((prev) => {
      const next = [...prev, marker];
      markersRef.current = next;
      return next;
    });
  }, [isRecording, audio, reconciler.tokens]);

  useEffect(() => {
    if (!isRecording) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = e.target as HTMLElement | null;
      if (el) {
        const tag = el.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          el.isContentEditable ||
          el.closest("[contenteditable='true']")
        ) {
          return;
        }
      }
      e.preventDefault();
      insertMarker();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isRecording, insertMarker]);

  // ── Start: passage selected → mic + Speechmatics + Deepgram immediately ──
  const handleStart = useCallback(() => {
    finishLockRef.current = false;
    sessionIdRef.current = `script-${Date.now().toString(36)}`;
    setMarkers([]);
    markersRef.current = [];
    prevFillerRef.current = 0;
    setFillerPops([]);
    pace.reset();
    matcher.reset();
    setIsRecording(true);
    setPhase("recording");
    audio.start();
    ws.connect();
    dg.connect();
    diagBanner("SCRIPT SESSION START — recording", {
      passage: passage.title,
      ts: new Date().toISOString(),
      diag: "same pipeline as Free Speech (Deepgram primary + DSP/sensor lanes)",
    });
  }, [audio, ws, dg, pace, matcher, passage]);

  // ── Finish: capture everything → persist → SAME /analysis experience ──
  const finishSession = useCallback(() => {
    if (finishLockRef.current) return;
    finishLockRef.current = true;
    setIsRecording(false);

    // Capture final data BEFORE the pipeline resets.
    const smSnapshot = ws.snapshotTranscripts();
    const finalTranscripts =
      mergedFinalChunks.length > 0 ? mergedFinalChunks : smSnapshot;
    const finalAcoustic = acoustic.getEvents();
    const sensorEvents = sensor.getEvents();
    const all = mergeAcousticEvents(finalAcoustic, sensorEvents);
    const paceReport = pace.finalize();
    const finalTokens = finalTokensRef.current;
    const finalHiddenKeys = finalHiddenKeysRef.current;
    const finalDisfluencies = disfluencyCollector.snapshot();
    const recoverySnapshot = recovery.annotations;
    const sessionId = sessionIdRef.current;
    const finalMarkers = markersRef.current.filter((m) => m.sessionId === sessionId);

    // SAME payload structure as Free Speech (shared builder) + the script
    // review payload (intact script + per-word purple annotations).
    const payload = buildAnalysisPayload({
      sessionId,
      topic: passage.title,
      mode: "script",
      finalTranscripts,
      acousticEvents: finalAcoustic,
      sensorEvents,
      allAcoustic: all,
      recoveryAnnotations: recoverySnapshot,
      finalTokens: finalTokens as any[],
      finalHiddenKeys,
      finalDisfluencies,
      markers: finalMarkers,
      paceReport,
      script: {
        title: passage.title,
        text: passage.text,
        tokens: passage.text.split(/\s+/).filter(Boolean),
        details: scriptAnnotationsRef.current.map((a) => ({
          state: a.state,
          disfluency: a.disfluency ?? null,
        })),
      },
    });

    diagBanner("SCRIPT SESSION END — summary", {
      passage: passage.title,
      ts: new Date().toISOString(),
      words: finalTranscripts.reduce((n, c) => n + (c.isFinal ? c.words.length : 0), 0),
      mergedEvents: all.map((e) => `${e.type}@${e.startTime.toFixed(2)}`),
      savedTranscriptTokens: finalTokens.length,
      savedDisfluencies: finalDisfluencies.map((d) => `${d.type}:"${d.word}"@${d.timeMs}ms`),
      score: payload.overallScore,
    });

    // ── AFTER-SESSION DATA: persist the structured disfluency collection ──
    try {
      persistSessionDisfluencies({
        sessionId,
        topic: passage.title,
        recordedAt: new Date().toISOString(),
        items: finalDisfluencies,
      } satisfies SessionDisfluencySnapshot);
    } catch {
      // non-critical — history persistence is best-effort
    }

    // ── USER-LEVEL PERSISTENCE (markers + official disfluency events) ──
    const account = userRef.current;
    if (account) {
      persistMarkers(account, finalMarkers);
      const automaticEvents: OfficialDisfluencyEvent[] = finalDisfluencies.map(
        (d) => ({
          id: d.tokenId ? `evt_${sessionId}_${d.tokenId}` : makeMarkerId(),
          sessionId,
          tokenId: d.tokenId,
          word: d.word,
          firstLetter: d.firstLetter,
          type: d.type,
          timeMs: d.timeMs,
          source: "automatic" as const,
          utterance: d.utterance,
          sentence: d.sentence,
          createdAt: new Date().toISOString(),
        })
      );
      persistEvents(account, automaticEvents);
    }

    try {
      saveSessionData(payload.overallScore);
    } catch {
      // non-critical — history persistence is best-effort
    }

    setPhase("processing");
    setTimeout(() => {
      navigate("/analysis", { state: payload });
    }, 900);
  }, [
    ws, acoustic, sensor, pace, passage, navigate, saveSessionData,
    recovery.annotations, mergedFinalChunks, disfluencyCollector,
  ]);

  const handleStop = useCallback(() => {
    audio.stop();
    ws.disconnect();
    dg.disconnect();
    finishSession();
  }, [audio, ws, dg, finishSession]);

  const handleTimerComplete = useCallback(() => {
    audio.stop();
    ws.disconnect();
    dg.disconnect();
    finishSession();
  }, [audio, ws, dg, finishSession]);

  const handleSelectPassage = (id: string) => {
    const found = SLP_PASSAGES.find((p) => p.id === id);
    if (found) {
      setPassage(found);
      setSelectedPassage(id);
      setShowLibrary(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────
  const allTargets = passage.targets.map((t) => t.grapheme);
  const scoreablePauses = analysis.pauseEvents.filter((p) => p.shouldColor).length;

  return (
    <div className="min-h-screen relative overflow-hidden">
      <LiquidBackground />
      <div className="relative z-10">
        <Navbar />

        <main className="pt-24 pb-16 px-4 max-w-4xl mx-auto">
          {/* Back */}
          <button
            onClick={() => navigate("/dashboard")}
            className="flex items-center gap-1.5 text-sm text-soft-gray hover:text-white transition-colors mb-6 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </button>

          {/* Mode indicator */}
          <div className="flex items-center justify-between mb-6">
            <div className="glass rounded-full inline-flex items-center gap-2 px-3 py-1 text-xs text-electric-violet/80">
              <BookOpen className="w-3 h-3" />
              Script Mode — Live Reading
            </div>
            {!isRecording && phase === "ready" && (
              <button
                onClick={() => setShowLibrary(true)}
                className="text-[10px] px-3 py-1.5 glass rounded-full text-soft-gray hover:text-white transition-colors cursor-pointer"
              >
                Change Passage
              </button>
            )}
          </div>

          {/* Passage header */}
          <div className="glass rounded-2xl p-4 mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-heading text-base font-semibold text-white">
                {passage.title}
              </h2>
              <p className="text-xs text-soft-gray/60 mt-0.5">
                {passage.description}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5 justify-end">
              {passage.targets.map((t, i) => (
                <span
                  key={`${t.grapheme}-${i}`}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-neon-purple/10 text-neon-purple/70"
                >
                  {t.grapheme} ({t.ipa})
                </span>
              ))}
            </div>
          </div>

          {/* Passage Library */}
          <AnimatePresence>
            {showLibrary && (
              <motion.div
                initial={{ opacity: 0, y: -10, height: 0 }}
                animate={{ opacity: 1, y: 0, height: "auto" }}
                exit={{ opacity: 0, y: -10, height: 0 }}
                className="glass rounded-2xl p-4 mb-4 overflow-hidden"
              >
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-heading text-sm font-semibold text-white flex items-center gap-1.5">
                    <BookOpen className="w-3.5 h-3.5 text-neon-purple" />
                    Passage Library
                  </h3>
                  <button
                    onClick={() => setShowLibrary(false)}
                    className="text-[10px] text-soft-gray/40 hover:text-white cursor-pointer"
                  >
                    Close
                  </button>
                </div>
                <div className="grid gap-2 max-h-60 overflow-y-auto">
                  {SLP_PASSAGES.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => handleSelectPassage(p.id)}
                      className={`w-full text-left px-3 py-2.5 rounded-xl transition-all cursor-pointer ${
                        selectedPassage === p.id
                          ? "bg-neon-purple/10 border border-neon-purple/20"
                          : "bg-white/5 border border-white/5 hover:bg-white/10"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-white font-medium">{p.title}</p>
                          <p className="text-[10px] text-soft-gray/50 mt-0.5">
                            {p.duration}s • {p.difficulty}
                          </p>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-neon-purple/10 text-neon-purple/70">
                          {p.targets.length} targets
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => handleSelectPassage(getRandomPassage().id)}
                  className="mt-3 flex items-center gap-1.5 text-xs text-neon-purple/60 hover:text-neon-purple transition-colors cursor-pointer"
                >
                  <Sparkles className="w-3 h-3" />
                  Surprise me
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Main content area */}
          <div className="grid md:grid-cols-2 gap-4">
            {/* Left panel: pager + metrics */}
            <div className="flex flex-col gap-4">
              <ScriptPager
                text={passage.text}
                isActive={isRecording}
                annotations={scriptAnnotations}
                activeIndex={matcher.metrics.activeTokenIndex}
                targets={allTargets}
                resetKey={passage.id}
              />

              {/* Live metrics strip (same numbers as Free Speech analysis) */}
              <AnimatePresence>
                {isRecording && (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    className="glass rounded-2xl px-4 py-3 flex items-center justify-between gap-2 overflow-x-auto"
                  >
                    <div className="flex items-center gap-4 text-[10px] whitespace-nowrap">
                      <span className="flex items-center gap-1.5">
                        <Gauge className="w-3 h-3 text-neon-purple" />
                        <span className="text-soft-gray/50">Accuracy</span>
                        <span className="text-white font-mono font-medium">
                          {matcher.metrics.accuracyPct}%
                        </span>
                      </span>
                      <span className="w-px h-3 bg-white/10" />
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400/70" />
                        <span className="text-soft-gray/50">Fillers</span>
                        <span className="text-white font-mono font-medium">
                          {fillerCount}
                        </span>
                      </span>
                      <span className="w-px h-3 bg-white/10" />
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#F87171]" />
                        <span className="text-soft-gray/50">Stutters</span>
                        <span className="text-white font-mono font-medium">
                          {analysis.score.stutters}
                        </span>
                      </span>
                      <span className="w-px h-3 bg-white/10" />
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#BD8CFF]" />
                        <span className="text-soft-gray/50">Stammers</span>
                        <span className="text-white font-mono font-medium">
                          {analysis.score.stammers}
                        </span>
                      </span>
                      <span className="w-px h-3 bg-white/10" />
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-white/30" />
                        <span className="text-soft-gray/50">Pauses</span>
                        <span className="text-white font-mono font-medium">
                          {scoreablePauses}
                        </span>
                      </span>
                      <span className="w-px h-3 bg-white/10" />
                      <span className="flex items-center gap-1.5">
                        <TimerReset className="w-3 h-3 text-electric-violet" />
                        <span className="text-soft-gray/50">Pace</span>
                        <span className="text-white font-mono font-medium">
                          <PaceMeter snapshot={paceSnapshot} variant="compact" />
                        </span>
                      </span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Filler indicator — small, unobtrusive "+1 FILLER" pops */}
              <div className="flex items-center gap-1.5 min-h-[22px]">
                <AnimatePresence>
                  {fillerPops.map((f) => (
                    <motion.span
                      key={f.id}
                      initial={{ opacity: 0, y: 8, scale: 0.85 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-mono font-semibold text-amber-300 bg-amber-300/10 border border-amber-300/30"
                      role="status"
                    >
                      +1 FILLER
                    </motion.span>
                  ))}
                </AnimatePresence>
              </div>
            </div>

            {/* Right panel: controls */}
            <div
              className="glass rounded-2xl p-6 flex flex-col items-center gap-4 relative overflow-hidden"
              style={{ height: "420px" }}
            >
              {phase !== "processing" ? (
                <>
                  <p className="text-sm text-soft-gray/60 text-center relative z-10">
                    {isRecording
                      ? "Follow the script — BOLO is tracking every word live"
                      : "Read the passage aloud — the script pages advance with you"}
                  </p>

                  {ws.status === "error" && (
                    <div className="w-full glass-subtle rounded-xl px-3 py-2 text-center relative z-10">
                      <p className="text-[10px] text-destructive/80">
                        {ws.error || "Transcription unavailable"}
                      </p>
                    </div>
                  )}

                  <SessionTimer
                    duration={passage.duration}
                    isRunning={isRecording}
                    onComplete={handleTimerComplete}
                  />
                  <RecordButton
                    size="lg"
                    recording={isRecording}
                    onStart={handleStart}
                    onStop={handleStop}
                  />

                  {isRecording && (
                    <div className="flex flex-col items-center gap-2 relative z-10">
                      {/* MARKER control — same as Free Speech */}
                      <button
                        onClick={insertMarker}
                        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-mono text-cyan-300 bg-cyan-300/10 border border-cyan-300/35 transition-all duration-200 hover:brightness-125 active:scale-[0.97] cursor-pointer"
                        title="Insert a marker at the current point (or press SPACE)"
                      >
                        <Flag className="w-3 h-3" />
                        MARKER
                        <span className="hidden sm:inline-flex items-center rounded bg-cyan-300/15 px-1 py-px text-[9px] text-cyan-200/90">
                          {markers.length}
                        </span>
                      </button>
                      <button
                        onClick={handleStop}
                        className="flex items-center gap-1.5 text-xs text-red-400/60 hover:text-red-400 transition-colors cursor-pointer"
                      >
                        <StopCircle className="w-3.5 h-3.5" />
                        Stop early
                      </button>
                    </div>
                  )}

                  {!isRecording && phase === "ready" && (
                    <p className="text-[10px] text-soft-gray/40 text-center relative z-10">
                      {passage.duration}s session • same live detection as Free Practice
                    </p>
                  )}
                </>
              ) : (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="w-full text-center space-y-3 pt-10"
                >
                  <div className="w-14 h-14 rounded-full bg-gradient-to-br from-electric-violet to-neon-purple flex items-center justify-center mx-auto animate-pulse">
                    <Sparkles className="w-6 h-6 text-white" />
                  </div>
                  <p className="font-heading text-lg font-semibold text-white">
                    Building your analysis…
                  </p>
                  <p className="text-xs text-soft-gray/60">
                    Same fluency report as Free Practice
                  </p>
                </motion.div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
