import { useState, useRef, useCallback, useEffect } from "react";
import type { TranscriptChunk } from "./useSpeechmaticsWS";
import type { AcousticEvent } from "./useAcousticAnalysis";
import {
  detectPauses,
  type PauseEvent,
  type FinalWordLike,
} from "../lib/pauseDetector";

// ─── Types ──────────────────────────────────────────────────────────────

export type TokenState =
  | "unread"
  | "current"
  | "matched"
  | "disfluent"
  | "skipped";

export type DisfluencyKind =
  | "filler"
  | "repetition"
  | "stutter"
  | "stammer"
  | "block"
  | "prolongation";

export interface TokenDetail {
  state: TokenState;
  /** If matched with a disfluency, the kind (for coloring) */
  disfluency?: DisfluencyKind;
  /** Timestamps of the finalized word that matched this token (seconds).
   *  Informational only — the script engine ignores these entirely. */
  startTime?: number;
  endTime?: number;
}

export interface ScriptMetrics {
  matchedWords: number;
  totalTokens: number;
  accuracyPct: number;
  fillers: Record<string, number>;
  fillerCount: number;
  repetitions: number;
  stutters: number;
  stammers: number;
  substitutions: number;
  insertions: number;
  blocks: number;
  prolongations: number;
  pauses: { count: number; avgMs: number; longestMs: number };
  pauseEvents: PauseEvent[];
  pauseMarkers: { tokenIndex: number; event: PauseEvent }[];
  wpm: number;
  articulationWPM: number;
  speakingMs: number;
  totalMs: number;
  phonationRatio: number;
  clarityScore: number;
  activeTokenIndex: number;
  tokenStates: TokenState[];
  tokenDetails: TokenDetail[];
  lastEvent: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────

const FILLER_SET = new Set([
  "um", "uh", "ah", "er", "hmm", "mm", "hm",
  "like", "you know", "sort of", "kind of",
  "actually", "basically", "literally", "i mean",
  "you see", "well", "so yeah", "right", "okay", "anyway",
]);

const LOOKAHEAD = 3;

// ─── Pure helpers ───────────────────────────────────────────────────────

function normalize(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9']/g, "");
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// ─── Tolerant matching (punctuation-insensitive + bounded fuzzy) ────────
// The script's exact spelling (capitalization, punctuation, em dashes,
// quotes, apostrophes) must NEVER be the reason a correctly-read word is
// marked red. Comparisons run on a punctuation-stripped lowercase form;
// when exact equality fails, a bounded Levenshtein check (same first
// letter, small edit distance relative to length) accepts minor ASR
// variation. Completely unrelated words still fail, so real reading
// errors stay visible.

function matchNorm(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  let prev = new Array<number>(bl + 1);
  let curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= bl; j++) prev[j] = curr[j];
  }
  return prev[bl];
}

/** Same first letter + bounded edit distance ⇒ acceptable match. */
function fuzzySimilar(a: string, b: string): boolean {
  const na = matchNorm(a);
  const nb = matchNorm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na[0] !== nb[0]) return false; // different word — reject
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen <= 3) return dist <= 1;
  if (maxLen <= 6) return dist <= 2 && dist / maxLen <= 0.5;
  return dist <= 2 && dist / maxLen <= 0.33;
}

/** Split on non-alphanumerics: "well-known", "step—by-step" → parts. */
function wordSegments(w: string): string[] {
  return w
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((s) => s.length > 0);
}

/**
 * Script↔spoken comparison used by the matcher. Punctuation
 * (. , ? ! : ; — - " ' ( ) etc.) is non-semantic: "Hello," matches
 * "hello", "don't" matches "dont", "well-known" matches "well". Falls
 * back to fuzzy similarity for minor ASR variation — but never accepts
 * unrelated words (first letter must agree). Exported so the tolerance
 * rules can be verified independently.
 */
export function scriptWordMatches(spoken: string, scriptWord: string): boolean {
  const sp = matchNorm(spoken);
  if (!sp) return false;
  const sc = matchNorm(scriptWord);
  if (!sc) return false;
  if (sp === sc) return true;
  // Segment-level: em dash / hyphen joined script words compare per part
  // ("well-known" ↔ "well", "step—by" ↔ "step").
  const spokenSegs = wordSegments(spoken);
  const scriptSegs = wordSegments(scriptWord);
  if (spokenSegs.length > 1 || scriptSegs.length > 1) {
    for (const s of spokenSegs) {
      for (const t of scriptSegs) {
        if (s === t || fuzzySimilar(s, t)) return true;
      }
    }
  }
  return fuzzySimilar(sp, sc);
}

function isFiller(word: string): boolean {
  return FILLER_SET.has(normalize(word));
}

/** Detect a textual stutter: hyphenated fragments or tripled letters */
function isTextualStutter(word: string): boolean {
  const norm = word.toLowerCase();
  if (norm.includes("-")) return true;
  // Triple consecutive identical letter (e.g. "sssome")
  for (let i = 0; i < norm.length - 2; i++) {
    if (norm[i] === norm[i + 1] && norm[i] === norm[i + 2]) return true;
  }
  return false;
}

/** Detect if a word was a repetition of the previous (consecutive same word) */
function isRepetition(
  spoken: string,
  prevSpoken: string | null
): boolean {
  if (!prevSpoken) return false;
  return normalize(spoken) === normalize(prevSpoken);
}

/** Overlap check for acoustic events against a word's time window */
function overlapsAcoustic(
  startTime: number,
  endTime: number,
  events: AcousticEvent[]
): AcousticEvent | null {
  if (events.length === 0) return null;
  const sMs = startTime * 1000;
  const eMs = endTime * 1000;
  for (const ev of events) {
    if (ev.confidence < 0.75) continue;
    const evS = ev.startTime * 1000;
    const evE = ev.endTime * 1000;
    const intersect = Math.min(eMs, evE) - Math.max(sMs, evS);
    if (intersect >= 80) return ev;
  }
  return null;
}

// ─── Hook ───────────────────────────────────────────────────────────────

export function useScriptMatcher(
  passageText: string,
  transcripts: TranscriptChunk[],
  acousticEvents: AcousticEvent[] = []
) {
  const [metrics, setMetrics] = useState<ScriptMetrics>(() =>
    buildEmpty(passageText)
  );

  const scriptTokensRef = useRef<string[]>(tokenize(passageText));
  const consumedRef = useRef(0); // pointer: next expected script token
  const tokenDetailsRef = useRef<TokenDetail[]>(
    scriptTokensRef.current.map(() => ({ state: "unread" }))
  );
  const metricsRef = useRef<ScriptMetrics>(buildEmpty(passageText));
  const lastEventRef = useRef<string | null>(null);

  // Final words pipeline (deduplicated, chronological)
  const finalsRef = useRef<FinalWordLike[]>([]);
  const finalsDedupeRef = useRef<Set<string>>(new Set());
  const pauseProcessedRef = useRef(0); // number of finals processed for pauses
  const lastProcessedSpokenRef = useRef<string | null>(null);

  // Stats
  const fillerCountRef = useRef(0);
  const fillersRef = useRef<Record<string, number>>({});
  const repetitionCountRef = useRef(0);
  const stutterCountRef = useRef(0);
  const stammerCountRef = useRef(0);
  const substitutionCountRef = useRef(0);
  const insertionCountRef = useRef(0);
  const lastWordEndRef = useRef(0);
  const wordTimestampsRef = useRef<number[]>([]);
  const pauseEventsRef = useRef<PauseEvent[]>([]);

  // Acoustic events ref
  const acousticEventsRef = useRef<AcousticEvent[]>(acousticEvents);
  acousticEventsRef.current = acousticEvents;

  // ── Reset when passage changes ───────────────────────────
  useEffect(() => {
    const tokens = tokenize(passageText);
    scriptTokensRef.current = tokens;
    consumedRef.current = 0;
    tokenDetailsRef.current = tokens.map(() => ({ state: "unread" }));
    lastEventRef.current = null;
    finalsRef.current = [];
    finalsDedupeRef.current = new Set();
    pauseProcessedRef.current = 0;
    lastProcessedSpokenRef.current = null;
    fillerCountRef.current = 0;
    fillersRef.current = {};
    repetitionCountRef.current = 0;
    stutterCountRef.current = 0;
    stammerCountRef.current = 0;
    substitutionCountRef.current = 0;
    insertionCountRef.current = 0;
    lastWordEndRef.current = 0;
    wordTimestampsRef.current = [];
    pauseEventsRef.current = [];
    setMetrics(buildEmpty(passageText));
    metricsRef.current = buildEmpty(passageText);
  }, [passageText]);

  // ── Process new transcripts ────────────────────────────
  useEffect(() => {
    const finals = transcripts.filter((t) => t.isFinal);
    let changed = false;

    // Collect new finalised words (deduped by startTime-endTime-word)
    const newFinals: FinalWordLike[] = [];
    for (const chunk of finals) {
      for (const w of chunk.words) {
        const word = (w as any).text || w.word || "";
        if (!word) continue;
        const key = `${w.startTime}:${w.endTime}:${word}`;
        if (finalsDedupeRef.current.has(key)) continue;
        finalsDedupeRef.current.add(key);
        newFinals.push({
          word,
          text: word,
          startTime: w.startTime,
          endTime: w.endTime,
          utterance: chunk.utterance,
          confidence: (w as any).confidence ?? 0.9,
        });
        changed = true;
      }
    }

    if (!changed) return; // nothing new — don't recompute

    // Append new finals in chronological order
    finalsRef.current = [...finalsRef.current, ...newFinals];

    // ── Process each new word for alignment ──────────────
    for (const fw of newFinals) {
      const spoken = normalize(fw.word);
      if (!spoken) continue;

      const endTimeMs = fw.endTime * 1000;
      wordTimestampsRef.current.push(endTimeMs);

      const tokens = scriptTokensRef.current;
      const details = tokenDetailsRef.current;
      const consumed = consumedRef.current;

      // ── Filler detection (does not consume a script token) ──
      if (isFiller(fw.word)) {
        fillersRef.current[spoken] = (fillersRef.current[spoken] || 0) + 1;
        fillerCountRef.current++;
        lastEventRef.current = `filler:${spoken}`;
        // Mark current token as "current" if not yet marked
        if (consumed < details.length && details[consumed].state === "unread") {
          details[consumed] = { ...details[consumed], state: "current" };
        }
        continue;
      }

      // ── Text-level stutter (hyphenated / tripled letters) ──
      if (isTextualStutter(fw.word)) {
        stutterCountRef.current++;
        lastEventRef.current = "stutter";
        // Don't consume a script token
        if (consumed < details.length && details[consumed].state === "unread") {
          details[consumed] = { ...details[consumed], state: "current" };
        }
        continue;
      }

      // ── Repetition (consecutive identical word) ─────────
      if (isRepetition(fw.word, lastProcessedSpokenRef.current)) {
        repetitionCountRef.current++;
        lastEventRef.current = `repeat:${spoken}`;
        // Don't consume a script token
        if (consumed < details.length && details[consumed].state === "unread") {
          details[consumed] = { ...details[consumed], state: "current" };
        }
        continue;
      }

      lastProcessedSpokenRef.current = fw.word;

      // ── Exact match at the current script token ────────
      if (
        consumed < tokens.length &&
        scriptWordMatches(fw.word, tokens[consumed])
      ) {
        const ae = overlapsAcoustic(
          fw.startTime,
          fw.endTime,
          acousticEventsRef.current
        );
        const detail: TokenDetail = {
          state: "matched",
          startTime: fw.startTime,
          endTime: fw.endTime,
        };
        if (ae) {
          detail.disfluency = ae.type as DisfluencyKind;
          // Count disfluency type
          if (ae.type === "stutter") stutterCountRef.current++;
          else if (ae.type === "stammer") stammerCountRef.current++;
          else if (ae.type === "repetition") repetitionCountRef.current++;
        }
        details[consumed] = detail;
        consumedRef.current = consumed + 1;
        if (consumed + 1 < details.length) {
          details[consumed + 1] = { state: "current" };
        }
        lastEventRef.current = "matched";
        continue;
      }

      // ── Forward-search lookahead (tolerant alignment) ──
      if (consumed < tokens.length) {
        let foundAhead = -1;
        for (
          let ahead = 1;
          ahead <= LOOKAHEAD && consumed + ahead < tokens.length;
          ahead++
        ) {
          if (scriptWordMatches(fw.word, tokens[consumed + ahead])) {
            foundAhead = ahead;
            break;
          }
        }

        if (foundAhead > 0) {
          // Mark skipped tokens between current and the match
          for (let s = 0; s < foundAhead; s++) {
            details[consumed + s] = { state: "skipped" };
          }
          substitutionCountRef.current += foundAhead;
          const ae = overlapsAcoustic(
            fw.startTime,
            fw.endTime,
            acousticEventsRef.current
          );
          const detail: TokenDetail = {
            state: "matched",
            startTime: fw.startTime,
            endTime: fw.endTime,
          };
          if (ae) {
            detail.disfluency = ae.type as DisfluencyKind;
            if (ae.type === "stutter") stutterCountRef.current++;
            else if (ae.type === "stammer") stammerCountRef.current++;
          }
          details[consumed + foundAhead] = detail;
          consumedRef.current = consumed + foundAhead + 1;
          if (consumed + foundAhead + 1 < details.length) {
            details[consumed + foundAhead + 1] = { state: "current" };
          }
          lastEventRef.current = "substitution";
          continue;
        }
      }

      // ── No match: insertion — don't advance script pointer ──
      insertionCountRef.current++;
      // Remove the spurious "current" marker we may have added
      lastEventRef.current = `insertion:${spoken}`;
    }

    // ── Pause detection on all finals ───────────────────────
    const pauseResult = detectPauses(finalsRef.current, pauseProcessedRef.current);
    pauseProcessedRef.current = pauseResult.nextIndex;
    const allPauses = pauseResult.pauses;

    // Build pause markers: map each pause to the script token index at that time
    const markers: { tokenIndex: number; event: PauseEvent }[] = [];
    for (const p of allPauses) {
      // Find the first unread/current token; the pause sits just before it
      const idx = consumedRef.current;
      if (idx < scriptTokensRef.current.length) {
        markers.push({ tokenIndex: idx, event: p });
      }
      // Also emit a lastEvent for the event ticker
      if (
        p.type === "thinking" ||
        p.type === "awkward" ||
        p.type === "severe"
      ) {
        lastEventRef.current = `pause:${(p.durationMs / 1000).toFixed(1)}s`;
      }
    }

    pauseEventsRef.current = allPauses;

    const m = recomputeMetrics(allPauses, markers);
    metricsRef.current = m;
    setMetrics(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcripts, acousticEvents]);

  // ── Metrics computation ─────────────────────────────────
  function recomputeMetrics(
    pauseEvents: PauseEvent[],
    pauseMarkers: { tokenIndex: number; event: PauseEvent }[]
  ): ScriptMetrics {
    const tokens = scriptTokensRef.current;
    const details = tokenDetailsRef.current;
    const total = tokens.length;

    let matched = 0;
    let skipped = 0;
    for (const d of details) {
      if (d.state === "matched") matched++;
      if (d.state === "skipped") skipped++;
    }

    let activeIdx = details.findIndex((d) => d.state === "current");
    if (activeIdx === -1)
      activeIdx = details.findIndex((d) => d.state === "unread");
    if (activeIdx === -1) activeIdx = total;

    const accuracyPct = total > 0 ? Math.round((matched / total) * 100) : 0;

    // Pause stats (only count non-natural pauses for score purposes)
    const scoreablePauses = pauseEvents.filter(
      (p) => p.type !== "natural"
    );
    const pauseCount = scoreablePauses.length;
    const totalPauseMs = scoreablePauses.reduce((s, p) => s + p.durationMs, 0);
    const avgPauseMs = pauseCount > 0 ? Math.round(totalPauseMs / pauseCount) : 0;
    const longestPauseMs =
      pauseCount > 0
        ? Math.max(...scoreablePauses.map((p) => p.durationMs))
        : 0;

    // Speaking time & WPM
    const timestamps = wordTimestampsRef.current;
    const totalSpeechMs =
      timestamps.length > 1
        ? timestamps[timestamps.length - 1] - timestamps[0]
        : 0;
    const pauseTimeMs = scoreablePauses.reduce((s, p) => s + p.durationMs, 0);
    const speakingMs = Math.max(1, totalSpeechMs - pauseTimeMs);

    // Use matched count for WPM (spoken words aligned = what we detected)
    const totalMinutes = Math.max(1, totalSpeechMs) / 60000;
    const articulationMinutes = Math.max(1, speakingMs) / 60000;

    const wpm =
      totalMinutes > 0 ? Math.round(matched / totalMinutes) : 0;
    const articulationWPM =
      articulationMinutes > 0
        ? Math.round(matched / articulationMinutes)
        : 0;
    const phonationRatio =
      totalSpeechMs > 0 ? Math.max(0, speakingMs / totalSpeechMs) : 0;

    // ── Clarity score (0–100) without ASR confidence ──────
    const scatterPct =
      total > 0
        ? Math.round(
            ((matched + skipped) / total) * 100
          )
        : 0;

    // Disfluency score: penalty from count of each type
    const disfluencyPenalty = Math.min(
      60,
      stutterCountRef.current * 6 +
        stammerCountRef.current * 6 +
        repetitionCountRef.current * 3 +
        (acousticEventsRef.current.filter((e) => e.type === "block").length) * 8 +
        (acousticEventsRef.current.filter((e) => e.type === "prolongation").length) * 4 +
        fillerCountRef.current * 2 +
        insertionCountRef.current * 1
    );
    const fluencyScore = Math.max(0, 100 - disfluencyPenalty);

    const idealWPM = 120;
    const paceScore = Math.max(0, 100 - Math.abs(wpm - idealWPM) * 0.5);

    const clarityScore = Math.round(
      scatterPct * 0.5 + fluencyScore * 0.3 + paceScore * 0.2
    );

    const lastEvent = lastEventRef.current;
    lastEventRef.current = null;

    const blocks = acousticEventsRef.current.filter(
      (e) => e.type === "block"
    ).length;
    const prolongations = acousticEventsRef.current.filter(
      (e) => e.type === "prolongation"
    ).length;

    return {
      matchedWords: matched,
      totalTokens: total,
      accuracyPct,
      fillers: { ...fillersRef.current },
      fillerCount: fillerCountRef.current,
      repetitions: repetitionCountRef.current,
      stutters: stutterCountRef.current,
      stammers: stammerCountRef.current,
      substitutions: substitutionCountRef.current,
      insertions: insertionCountRef.current,
      blocks,
      prolongations,
      pauses: { count: pauseCount, avgMs: avgPauseMs, longestMs: longestPauseMs },
      pauseEvents,
      pauseMarkers,
      wpm,
      articulationWPM,
      speakingMs: Math.round(speakingMs),
      totalMs: Math.max(1, Math.round(totalSpeechMs)),
      phonationRatio: Math.round(phonationRatio * 100) / 100,
      clarityScore,
      activeTokenIndex: activeIdx,
      tokenStates: details.map((d) => d.state),
      tokenDetails: details.map((d) => ({ ...d })),
      lastEvent,
    };
  }

  const reset = useCallback(() => {
    const tokens = tokenize(passageText);
    scriptTokensRef.current = tokens;
    consumedRef.current = 0;
    tokenDetailsRef.current = tokens.map(() => ({ state: "unread" }));
    lastEventRef.current = null;
    finalsRef.current = [];
    finalsDedupeRef.current = new Set();
    pauseProcessedRef.current = 0;
    lastProcessedSpokenRef.current = null;
    fillerCountRef.current = 0;
    fillersRef.current = {};
    repetitionCountRef.current = 0;
    stutterCountRef.current = 0;
    stammerCountRef.current = 0;
    substitutionCountRef.current = 0;
    insertionCountRef.current = 0;
    lastWordEndRef.current = 0;
    wordTimestampsRef.current = [];
    pauseEventsRef.current = [];
    setMetrics(buildEmpty(passageText));
    metricsRef.current = buildEmpty(passageText);
  }, [passageText]);

  const setActiveTokenIndex = useCallback((idx: number) => {
    const details = [...tokenDetailsRef.current];
    if (idx >= 0 && idx < details.length && details[idx].state === "unread") {
      details[idx] = { state: "current" };
      tokenDetailsRef.current = details;
      const m = {
        ...metricsRef.current,
        activeTokenIndex: idx,
        tokenStates: details.map((d) => d.state),
        tokenDetails: details,
      };
      metricsRef.current = m;
      setMetrics(m);
    }
  }, []);

  return { metrics, reset, setActiveTokenIndex };
}

// ─── Empty state factory ────────────────────────────────────────────

function buildEmpty(passageText: string): ScriptMetrics {
  const tokens = tokenize(passageText);
  return {
    matchedWords: 0,
    totalTokens: tokens.length,
    accuracyPct: 0,
    fillers: {},
    fillerCount: 0,
    repetitions: 0,
    stutters: 0,
    stammers: 0,
    substitutions: 0,
    insertions: 0,
    blocks: 0,
    prolongations: 0,
    pauses: { count: 0, avgMs: 0, longestMs: 0 },
    pauseEvents: [],
    pauseMarkers: [],
    wpm: 0,
    articulationWPM: 0,
    speakingMs: 0,
    totalMs: 1,
    phonationRatio: 0,
    clarityScore: 0,
    activeTokenIndex: 0,
    tokenStates: tokens.map(() => "unread" as TokenState),
    tokenDetails: tokens.map(() => ({ state: "unread" as TokenState })),
    lastEvent: null,
  };
}