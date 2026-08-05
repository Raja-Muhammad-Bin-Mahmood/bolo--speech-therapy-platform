/**
 * BOLO — RecordingSession
 *
 * PHASE 1: SENSOR LAYER ONLY
 *
 * This page provides a pure audio physics test bed:
 *   1. User picks a topic (existing TopicDrum)
 *   2. Recording starts the AudioWorklet sensor pipeline
 *   3. Live raw telemetry (RMS, ZCR, Δ Energy) displayed in real time
 *   4. Stop Recording → immediately freezes the sensor, navigates to Analysis
 *
 * No Speechmatics. No stutter detection. No transcription.
 * Just the physics layer — raw numbers in, raw numbers out.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Square, BarChart3, Sparkles } from "lucide-react";
import Navbar from "../components/Navbar";
import TopicDrum from "../components/TopicDrum";
import SensorDebug from "../components/SensorDebug";
import { useSensor } from "../hooks/useSensor";
import type { SensorSession } from "../lib/sensorTypes";

type Phase = "topic" | "recording" | "processing";

export default function RecordingSession() {
  const navigate = useNavigate();
  const sensor = useSensor();

  const [phase, setPhase] = useState<Phase>("topic");
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const analysisLockRef = useRef(false);

  // Store the finalized session data so it survives the state reset
  const finishedSessionRef = useRef<SensorSession | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      /* sensor cleanup is handled inside useSensor */
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Topic selected → start recording immediately ─────────────────────
  const handleTopicSelect = useCallback(
    (topic: string) => {
      setSelectedTopic(topic);
      setPhase("recording");
      sensor.start();
    },
    [sensor]
  );

  // ── Stop recording → transition to analysis ───────────────────────────
  const handleStopRecording = useCallback(() => {
    if (analysisLockRef.current) return;
    analysisLockRef.current = true;

    // IMMEDIATELY stop the sensor — no second click, no delay
    const session = sensor.stop();

    // Store the session data before it's cleared
    finishedSessionRef.current = session;

    setPhase("processing");

    // Navigate to analysis with the captured sensor data
    setTimeout(() => {
      navigate("/analysis", {
        state: {
          topic: selectedTopic,
          // Sensor session data for the analysis page to consume
          sensorSession: session,
          // Minimal placeholder scores for the existing analysis page
          clarityScore: 0,
          fluencyScore: 0,
          totalWords: 0,
          disfluentWords: 0,
          disfluencyRate: 0,
          longestPhrase: 0,
          avgWordsPerBurst: 0,
          topFiller: "none",
          fillerWords: {},
          overallScore: 0,
        },
      });
    }, 600);
  }, [sensor, selectedTopic, navigate]);

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen relative overflow-hidden bg-deep-space">
      <Navbar />

      {/* ─── Ambient Background ─────────────────────────── */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-b from-deep-space via-dark-lavender/[0.08] to-deep-space" />
        <div className="absolute top-1/3 left-1/4 w-[500px] h-[500px] rounded-full bg-neon-purple/[0.04] blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-electric-violet/[0.03] blur-[100px]" />
      </div>

      {/* ─── Topic Selection Phase ──────────────────────── */}
      <AnimatePresence>
        {phase === "topic" && (
          <motion.main
            key="topic-phase"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="relative z-10 pt-28 pb-16 px-4 max-w-2xl mx-auto"
          >
            <div className="text-center mb-8">
              <button
                onClick={() => navigate("/dashboard")}
                className="inline-flex items-center gap-1.5 text-sm text-soft-gray hover:text-white transition-colors mb-6 cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to Dashboard
              </button>
              <h1 className="font-heading text-2xl md:text-3xl font-bold text-white mb-2">
                Sensor Layer Test
              </h1>
              <p className="text-sm text-soft-gray/60 max-w-md mx-auto">
                Pick a topic, then speak to see raw audio physics in real time.
              </p>
            </div>
            <TopicDrum onSelect={handleTopicSelect} />
          </motion.main>
        )}
      </AnimatePresence>

      {/* ─── Recording Phase ────────────────────────────── */}
      <AnimatePresence>
        {phase === "recording" && (
          <motion.div
            key="recording-phase"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-20"
          >
            {/* Glass overlay */}
            <div className="absolute inset-0 bg-deep-space/40 backdrop-blur-[2px]" />

            <div className="relative z-10 flex flex-col h-full pt-20 pb-6 px-4 md:px-8 max-w-3xl mx-auto">
              {/* ── Header ─────────────────────────────────── */}
              <div className="text-center mb-6">
                <div className="inline-flex items-center gap-2 glass rounded-full px-4 py-1.5 mb-3">
                  <Sparkles className="w-3 h-3 text-neon-purple" />
                  <span className="text-xs text-white/80 truncate max-w-[200px]">
                    {selectedTopic}
                  </span>
                </div>
                <h2 className="font-heading text-lg font-semibold text-white">
                  Speaking Live
                </h2>
                <p className="text-xs text-soft-gray/50 mt-1">
                  Raw audio physics — no interpretation
                </p>
              </div>

              {/* ── Sensor Debug Panel ─────────────────────── */}
              <div className="flex-1 flex items-center justify-center px-4">
                <div className="w-full max-w-md">
                  <SensorDebug sensor={sensor} />
                </div>
              </div>

              {/* ── Stop Button ────────────────────────────── */}
              <div className="flex justify-center pb-6 pt-4">
                {sensor.isRecording ? (
                  <motion.button
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={handleStopRecording}
                    className="flex items-center gap-2.5 bg-destructive hover:bg-red-600 text-white text-sm font-medium px-8 py-4 rounded-full transition-all duration-200 shadow-[0_0_25px_rgba(255,80,80,0.35)] cursor-pointer"
                  >
                    <Square className="w-4 h-4 fill-white" />
                    Stop Recording
                  </motion.button>
                ) : (
                  <div className="flex items-center gap-2.5 text-sm text-soft-gray/50">
                    <div className="flex gap-1">
                      <div
                        className="w-2 h-2 rounded-full bg-neon-purple animate-bounce"
                        style={{ animationDelay: "0ms" }}
                      />
                      <div
                        className="w-2 h-2 rounded-full bg-neon-purple animate-bounce"
                        style={{ animationDelay: "150ms" }}
                      />
                      <div
                        className="w-2 h-2 rounded-full bg-neon-purple animate-bounce"
                        style={{ animationDelay: "300ms" }}
                      />
                    </div>
                    Connecting to microphone...
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Processing Phase ────────────────────────────── */}
      <AnimatePresence>
        {phase === "processing" && (
          <motion.div
            key="processing-phase"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-30 flex items-center justify-center"
          >
            {/* Ambient background */}
            <div className="absolute inset-0 bg-deep-space/90 backdrop-blur-md" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-gradient-to-br from-electric-violet/[0.08] to-neon-purple/[0.05] blur-[120px] animate-pulse-glow" />

            <div className="relative z-10 text-center">
              {/* Animated orb */}
              <motion.div
                className="relative w-24 h-24 mx-auto mb-6"
                animate={{
                  scale: [1, 1.08, 1],
                  rotate: [0, 5, -5, 0],
                }}
                transition={{
                  duration: 3,
                  ease: "easeInOut",
                  repeat: Infinity,
                }}
              >
                <div className="absolute inset-0 rounded-full bg-gradient-to-br from-electric-violet to-neon-purple opacity-30 blur-xl animate-pulse" />
                <div className="absolute inset-2 rounded-full bg-gradient-to-br from-electric-violet to-neon-purple flex items-center justify-center">
                  <BarChart3 className="w-10 h-10 text-white" />
                </div>
              </motion.div>

              <h2 className="font-heading text-xl font-bold text-white mb-2">
                Finalizing Sensor Session
              </h2>
              <p className="text-sm text-soft-gray/60 max-w-xs mx-auto">
                Saving {finishedSessionRef.current?.frames.length ?? 0} frames
                of raw audio physics data...
              </p>

              {/* Progress bar */}
              <div className="flex justify-center mt-6">
                <div className="w-48 h-1.5 rounded-full bg-white/5 overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-gradient-to-r from-electric-violet to-neon-purple"
                    initial={{ width: "0%" }}
                    animate={{ width: "100%" }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                  />
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}