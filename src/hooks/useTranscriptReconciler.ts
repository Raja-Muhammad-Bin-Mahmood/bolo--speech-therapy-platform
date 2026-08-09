/**
 * BOLO — useTranscriptReconciler
 *
 * Owns the STRUCTURED LIVE TRANSCRIPT TOKEN ARRAY (the source of truth for
 * the visible live transcript). Both providers feed it:
 *
 *   • Deepgram FINAL words (fluent AND disfluent) → PRIMARY source tokens
 *     (disfluent ones are fast-tracked and locked)
 *   • Speechmatics FINAL chunks → secondary/fallback tokens (gaps, clarity)
 *
 * Every token passes through reconcileIncoming() (lib/transcriptTokens):
 *   1. reconcile tokens
 *   2. remove collisions / duplicates
 *   3. sort by startTimeMs
 *   4. render (the page renders this array + hides Speechmatics words that
 *      lost a locked Deepgram slot via hiddenSpeechmaticsKeys)
 *
 * Deepgram INTERIM results never enter the array (display-only ghost), and
 * Speechmatics PARTIAL results never enter it either.
 */
import { useRef, useCallback, useEffect, useState } from "react";
import type { TranscriptChunk } from "./useSpeechmaticsWS";
import type { DeepgramFinalWord } from "./useDeepgramWS";
import {
  reconcileIncoming,
  sortTokens,
  normWord,
  type TranscriptToken,
} from "../lib/transcriptTokens";

export interface TranscriptReconcilerOptions {
  active: boolean;
  /** Finalized Speechmatics chunks (live). */
  transcripts: TranscriptChunk[];
  /** Final Deepgram disfluency tokens (live). */
  deepgramFinals: DeepgramFinalWord[];
}

export interface TranscriptReconcilerOutput {
  /** The reconciled, sorted, duplicate-free token array (source of truth). */
  tokens: TranscriptToken[];
  /**
   * Speechmatics word keys (ms key format) that a locked Deepgram token
   * replaced — merge into the renderer's duplicateKeys so the beaten
   * Speechmatics word is hidden from the chunk renderer.
   */
  hiddenSpeechmaticsKeys: Set<string>;
  reset: () => void;
}

export function useTranscriptReconciler(
  options: TranscriptReconcilerOptions
): TranscriptReconcilerOutput {
  const { active, transcripts, deepgramFinals } = options;

  const [tokens, setTokens] = useState<TranscriptToken[]>([]);
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());

  const tokensRef = useRef<TranscriptToken[]>([]);
  const hiddenRef = useRef<Set<string>>(new Set());
  const seenSmRef = useRef<Set<string>>(new Set());
  const seenDgRef = useRef<Set<string>>(new Set());
  const sigRef = useRef("");

  // Session end → drop everything (live-only data).
  useEffect(() => {
    if (!active) {
      tokensRef.current = [];
      hiddenRef.current = new Set();
      seenSmRef.current = new Set();
      seenDgRef.current = new Set();
      sigRef.current = "";
      setTokens([]);
      setHiddenKeys(new Set());
    }
  }, [active]);

  // ── Ingest + reconcile (idempotent via seen-sets) ───────────────────
  useEffect(() => {
    if (!active) return;
    let changed = false;

    // ── Deepgram FINAL words → PRIMARY tokens (fluent + disfluent).
    // Disfluent tokens are locked (Speechmatics can never overwrite them);
    // fluent tokens are normal permanent tokens. Deepgram is the primary
    // live transcript source.
    for (const d of deepgramFinals) {
      const seenKey = `${Math.round(d.startTimeMs)}-${Math.round(
        d.endTimeMs
      )}-${normWord(d.rawWord || d.word)}`;
      if (seenDgRef.current.has(seenKey)) continue;
      seenDgRef.current.add(seenKey);
      changed = true;

      const incoming: TranscriptToken = {
        id: d.id,
        word: d.word,
        rawWord: d.rawWord ?? d.word,
        startTimeMs: d.startTimeMs,
        endTimeMs: Math.max(d.endTimeMs, d.startTimeMs + 1),
        source: "deepgram",
        isDisfluency: d.isDisfluency,
        locked: d.isDisfluency, // only disfluencies are locked
        disfluencyType: d.disfluencyType,
        confidence: d.confidence,
      };
      const res = reconcileIncoming(tokensRef.current, incoming);
      tokensRef.current = res.tokens;
      for (const k of res.hiddenKeys) hiddenRef.current.add(k);
    }

    // ── Speechmatics FINAL words → secondary/fallback tokens (gaps).
    // Only fills slots Deepgram has NOT already covered; a competing word
    // for a locked Deepgram slot is discarded (hidden).
    for (const chunk of transcripts) {
      if (!chunk.isFinal) continue;
      for (const w of chunk.words) {
        const text = (w as any).text || w.word || "";
        if (!text) continue;
        const startMs = Math.round((w.startTime || 0) * 1000);
        const endMs = Math.max(
          Math.round((w.endTime || 0) * 1000),
          startMs + 1
        );
        const norm = normWord(text);
        const seenKey = `${startMs}-${endMs}-${norm}`;
        if (seenSmRef.current.has(seenKey)) continue;
        seenSmRef.current.add(seenKey);
        changed = true;

        const incoming: TranscriptToken = {
          id: `tok-sm-${startMs}-${endMs}-${norm}`,
          word: text,
          startTimeMs: startMs,
          endTimeMs: endMs,
          source: "speechmatics",
          isDisfluency: false,
          locked: false,
          confidence: (w as any).confidence ?? 0.9,
        };
        const res = reconcileIncoming(tokensRef.current, incoming);
        tokensRef.current = res.tokens;
        for (const k of res.hiddenKeys) hiddenRef.current.add(k);
      }
    }

    if (changed) {
      const sig = tokensRef.current.map((t) => t.id).join("|");
      if (sig !== sigRef.current) {
        sigRef.current = sig;
        // React-state-safe sort: copy, never mutate the stored array.
        setTokens(sortTokens(tokensRef.current));
      }
      setHiddenKeys(new Set(hiddenRef.current));
    }
  }, [active, transcripts, deepgramFinals]);

  const reset = useCallback(() => {
    tokensRef.current = [];
    hiddenRef.current = new Set();
    seenSmRef.current = new Set();
    seenDgRef.current = new Set();
    sigRef.current = "";
    setTokens([]);
    setHiddenKeys(new Set());
  }, []);

  return { tokens, hiddenSpeechmaticsKeys: hiddenKeys, reset };
}
