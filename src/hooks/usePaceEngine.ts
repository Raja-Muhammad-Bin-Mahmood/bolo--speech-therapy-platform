import { useCallback, useEffect, useRef, useState } from "react";
import {
  PaceEngine,
  baselineSnapshot,
  collectFinalWords,
  type PaceSnapshot,
  type PaceReport,
} from "../lib/paceEngine";
import type { FinalWordLike, PauseEvent } from "../lib/pauseDetector";

/**
 * Owns a single PaceEngine instance for a session.
 * Feeding is imperative (no state churn) — only display components
 * that subscribe via usePaceSnapshot() re-render on the 500ms cadence.
 */
export function usePaceEngine() {
  const engineRef = useRef<PaceEngine | null>(null);
  if (!engineRef.current) engineRef.current = new PaceEngine();

  const feedTranscripts = useCallback(
    (
      chunks: {
        isFinal: boolean;
        utterance?: number;
        words: {
          word: string;
          startTime: number;
          endTime: number;
          confidence?: number;
          text?: string;
        }[];
      }[]
    ) => {
      const words = collectFinalWords(chunks as Parameters<typeof collectFinalWords>[0]);
      engineRef.current!.setFinalizedWords(words);
    },
    []
  );

  const feedPauses = useCallback((pauses: PauseEvent[]) => {
    engineRef.current!.setPauseEvents(pauses);
  }, []);

  const feed = useCallback((words: FinalWordLike[], pauses: PauseEvent[]) => {
    engineRef.current!.feed(words, pauses);
  }, []);

  const finalize = useCallback((): PaceReport => {
    return engineRef.current!.finalize();
  }, []);

  const reset = useCallback(() => {
    engineRef.current = new PaceEngine();
  }, []);

  return {
    engine: engineRef.current,
    feedTranscripts,
    feedPauses,
    feed,
    finalize,
    reset,
  };
}

/**
 * Lightweight subscription hook for display components.
 * Only the component that calls this re-renders on pace updates —
 * the parent tree stays untouched (React perf rule).
 */
export function usePaceSnapshot(engine: PaceEngine | null): PaceSnapshot {
  const [snap, setSnap] = useState<PaceSnapshot>(() =>
    engine ? engine.getSnapshot() : baselineSnapshot()
  );

  useEffect(() => {
    if (!engine) return;
    // Sync immediately, then subscribe
    setSnap(engine.getSnapshot());
    const unsub = engine.subscribe((s) => setSnap(s));
    return unsub;
  }, [engine]);

  return snap;
}

/** Stable reference to the engine for props (avoids re-renders). */
export function useStableEngine(engine: PaceEngine | null): PaceEngine | null {
  const ref = useRef<PaceEngine | null>(engine);
  ref.current = engine;
  return ref.current;
}