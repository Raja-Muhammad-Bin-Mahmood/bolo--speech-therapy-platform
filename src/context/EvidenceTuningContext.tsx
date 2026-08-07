/**
 * BOLO — Evidence Tuning Context
 *
 * Holds the live evidence-fusion weights shared by every mode (Script /
 * Free Speech / Closer) and a rolling log of the most recent scored
 * events for the hidden developer panel. Slider changes here take
 * effect immediately — consumers recompute their gating on the next
 * render (no reload, no rebuild).
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
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

  // Signature guard for reportScored: skips the setState entirely when the
  // incoming batch is identical to the last one we merged. This keeps the
  // telemetry write idempotent — the same events arriving on consecutive
  // renders (or from a render-phase call) can never schedule a redundant
  // provider update, which is what tripped React's "Cannot update a
  // component while rendering a different component" warning.
  const lastReportedRef = useRef("");
  const pendingRef = useRef<ScoredEvent[]>([]);

  const setWeight = useCallback((key: keyof EvidenceWeights, value: number) => {
    setWeights((prev) => ({ ...prev, [key]: value }));
  }, []);

  const resetWeights = useCallback(() => {
    setWeights(DEFAULT_EVIDENCE_WEIGHTS);
  }, []);

  const reportScored = useCallback((scored: ScoredEvent[]) => {
    if (scored.length === 0) return;

    // Batch identity: sorted stable keys. New events (new timestamps) change
    // the signature; identical events short-circuit to avoid redundant renders.
    const signature = scored
      .map((s) => s.key)
      .sort()
      .join("|");
    if (signature === lastReportedRef.current) return;
    lastReportedRef.current = signature;

    // Merge with the previous batch (keeps a rolling window, newest first).
    const merged = new Map<string, ScoredEvent>();
    for (const s of scored) merged.set(s.key, s);
    for (const p of pendingRef.current) if (!merged.has(p.key)) merged.set(p.key, p);

    const next = [...merged.values()].slice(0, MAX_RECENT);
    pendingRef.current = next;
    setRecent(next);
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
