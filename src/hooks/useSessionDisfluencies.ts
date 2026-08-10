/**
 * BOLO — useSessionDisfluencies
 *
 * Grows the structured `sessionDisfluencies[]` collection DURING the live
 * session from the SAME reconciled token array that powers the live
 * transcript (the single source of truth). Nothing is re-detected or
 * re-transcribed — every entry is derived from a live token.
 *
 *   • Deepgram tokens with a structured disfluency tag (or legacy
 *     isDisfluency/locked flags) → recorded with their complete word,
 *     firstLetter, type, timestamp, source and utterance association.
 *   • Speechmatics words the live view colored via `wordTags` (fillers →
 *     yellow) → recorded with the ENTIRE filler word, never just its
 *     first letter.
 *
 * `snapshot()` returns the final collection at session end — call it BEFORE
 * the pipeline resets (the reconciler clears its tokens the moment
 * recording stops), then persist/carry it to the after-session screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  collectSessionDisfluencies,
  type SessionDisfluency,
} from "../lib/sessionDisfluencies";
import type { TranscriptToken } from "../lib/transcriptTokens";

export interface UseSessionDisfluenciesOutput {
  /** Live-growing collection (session-scoped) — never loses an entry. */
  items: SessionDisfluency[];
  /** Final snapshot (sorted, complete) — call at session end. */
  snapshot: () => SessionDisfluency[];
  reset: () => void;
}

export function useSessionDisfluencies(
  tokens: TranscriptToken[],
  wordTags?: ReadonlyMap<string, string>
): UseSessionDisfluenciesOutput {
  const [items, setItems] = useState<SessionDisfluency[]>([]);
  const entriesRef = useRef<SessionDisfluency[]>([]);
  const sigRef = useRef("");

  useEffect(() => {
    // Idempotent by token id: new disfluency tokens are appended, existing
    // entries are never duplicated and never lost.
    const all = collectSessionDisfluencies(tokens, wordTags);
    const sig = all.map((d) => d.tokenId).join("|");
    entriesRef.current = all;
    if (sig !== sigRef.current) {
      sigRef.current = sig;
      setItems(all);
    }
  }, [tokens, wordTags]);

  const snapshot = useCallback(() => entriesRef.current, []);

  const reset = useCallback(() => {
    entriesRef.current = [];
    sigRef.current = "";
    setItems([]);
  }, []);

  return { items, snapshot, reset };
}
