/**
 * BOLO — Script↔Transcript Correlation + Pagination
 *
 * Script Mode shows a fixed script and the user reads it aloud. The
 * disfluency annotation must attach to the CORRECT script word — not
 * whatever Deepgram happens to output. This module maps the live
 * transcript (the SAME classification logic Free Speech uses) onto the
 * script tokens:
 *
 *   1. `useScriptMatcher` already aligns the spoken final-word stream to
 *      the script token sequence (exact + tolerant lookahead) and stamps
 *      each matched script token with the spoken word's time window.
 *   2. `correlateScriptTokens` additionally merges the Free Speech tag map
 *      (analysis.wordTags / taggedWords — Deepgram verdict + fusion) onto
 *      each matched script token by TEMPORAL OVERLAP, so a stutter the
 *      detector caught but the matcher's acoustic check missed still
 *      colors the right script word.
 *
 * The script text is NEVER modified: annotations are keyed by token index,
 * so the original word keeps its exact spelling and the raw Deepgram
 * stutter form is never printed over the script.
 *
 * Pagination splits the script into pages of ~6 lines so the reader never
 * sees one infinite wall of text — and because annotations are keyed by
 * GLOBAL token index, a word annotated right before a page flip keeps its
 * purple styling when the page changes (and when the user flips back).
 */
import type { TokenDetail, DisfluencyKind } from "../hooks/useScriptMatcher";
import type { TaggedWord } from "../hooks/useSessionAnalysis";

/** The annotation a script token renders with (global-token-index keyed). */
export interface ScriptTokenAnnotation {
  state: TokenDetail["state"];
  disfluency?: DisfluencyKind;
  startTime?: number;
  endTime?: number;
}

function overlapMs(aS: number, aE: number, bS: number, bE: number): number {
  return Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
}

/**
 * Merge the Free Speech tag map onto the matcher's token details.
 * Non-filler tags (stutter/stammer/block/repetition/prolongation) become
 * the purple disfluency annotation; fillers never attach to a script word
 * (they surface through the separate +1 FILLER indicator).
 */
export function correlateScriptTokens(
  details: TokenDetail[],
  taggedWords: TaggedWord[]
): ScriptTokenAnnotation[] {
  return details.map((d) => {
    const ann: ScriptTokenAnnotation = { state: d.state };
    if (d.startTime != null) ann.startTime = d.startTime;
    if (d.endTime != null) ann.endTime = d.endTime;
    // The matcher's own acoustic overlap already flagged it → keep it.
    if (d.disfluency) {
      ann.disfluency = d.disfluency;
      return ann;
    }
    // Only matched tokens carry the spoken word's time window.
    if (d.state !== "matched" || d.startTime == null || d.endTime == null) {
      return ann;
    }
    // Best temporal overlap wins (sequence/timing/context matching — never
    // bare string equality).
    let best: TaggedWord | null = null;
    let bestOv = 0;
    for (const tw of taggedWords) {
      const ov = overlapMs(d.startTime, d.endTime, tw.startTime, tw.endTime);
      if (ov > bestOv) {
        bestOv = ov;
        best = tw;
      }
    }
    if (best && best.tag && best.tag !== "filler") {
      ann.disfluency = best.tag as DisfluencyKind;
    }
    return ann;
  });
}

// ─── Pagination ─────────────────────────────────────────────────────────

export const WORDS_PER_LINE = 9;
export const LINES_PER_PAGE = 6;

export interface ScriptPageLine {
  tokens: { index: number; word: string }[];
}

export interface ScriptPage {
  /** Global token index of the first token on this page. */
  start: number;
  /** Global token index AFTER the last token on this page (exclusive). */
  end: number;
  lines: ScriptPageLine[];
}

export function scriptTokens(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function paginateScript(text: string): ScriptPage[] {
  const words = scriptTokens(text);
  const pageSize = WORDS_PER_LINE * LINES_PER_PAGE;
  const pages: ScriptPage[] = [];
  for (let start = 0; start < words.length; start += pageSize) {
    const end = Math.min(words.length, start + pageSize);
    const lines: ScriptPageLine[] = [];
    for (let ls = start; ls < end; ls += WORDS_PER_LINE) {
      const le = Math.min(end, ls + WORDS_PER_LINE);
      lines.push({
        tokens: Array.from({ length: le - ls }, (_, k) => ({
          index: ls + k,
          word: words[ls + k],
        })),
      });
    }
    pages.push({ start, end, lines });
  }
  return pages;
}
