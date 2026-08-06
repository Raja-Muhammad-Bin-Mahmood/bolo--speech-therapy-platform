/**
 * BOLO — Evidence Tuning Context
 *
 * Holds the live evidence-fusion weights shared by every mode (Script /
 * Free Speech / Debate) and a rolling log of the most recent scored
 * events for the hidden developer panel. Slider changes here take
 * effect immediately — consumers recompute their gating on the next
 * render (no reload, no rebuild).
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_EVIDENCE_WEIGHTS,
  type EvidenceWeights,
  type ScoredEvent,
} from "../lib/evidenceFusion";

export interface EvidenceTuningState {
  weights: EvidenceWeights;
  setWeight: (key: keyof EvidenceWeights, value: number) => void;
  resetWeights: () => void;
  /** Most recent scored events (live debug readout for the dev panel). */
  recent: ScoredEvent[];
  reportScored: (scored: ScoredEvent[]) => void;
  clearRecent: () => void;
}

const EvidenceTuningContext = createContext<EvidenceTuningState | null>(null);

const MAX_RECENT = 14;

export function EvidenceTuningProvider({ children }: { children: ReactNode }) {
  const [weights, setWeights] = useState<EvidenceWeights>(DEFAULT_EVIDENCE_WEIGHTS);
  const [recent, setRecent] = useState<ScoredEvent[]>([]);

  const setWeight = useCallback((key: keyof EvidenceWeights, value: number) => {
    setWeights((prev) => ({ ...prev, [key]: value }));
  }, []);

  const resetWeights = useCallback(() => {
    setWeights(DEFAULT_EVIDENCE_WEIGHTS);
  }, []);

  const reportScored = useCallback((scored: ScoredEvent[]) => {
    if (scored.length === 0) return;
    setRecent((prev) => {
      const merged = new Map<string, ScoredEvent>();
      // Newest first
      for (const s of scored) merged.set(s.key, s);
      for (const p of prev) if (!merged.has(p.key)) merged.set(p.key, p);
      return [...merged.values()].slice(0, MAX_RECENT);
    });
  }, []);

  const clearRecent = useCallback(() => setRecent([]), []);

  const value = useMemo<EvidenceTuningState>(
    () => ({ weights, setWeight, resetWeights, recent, reportScored, clearRecent }),
    [weights, setWeight, resetWeights, recent, reportScored, clearRecent]
  );

  return (
    <EvidenceTuningContext.Provider value={value}>
      {children}
    </EvidenceTuningContext.Provider>
  );
}

export function useEvidenceTuning(): EvidenceTuningState {
  const ctx = useContext(EvidenceTuningContext);
  if (!ctx) {
    throw new Error("useEvidenceTuning must be used inside <EvidenceTuningProvider>");
  }
  return ctx;
}
