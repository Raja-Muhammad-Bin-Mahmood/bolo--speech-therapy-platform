/**
 * BOLO — ManualAnnotationPanel (post-session marker review + annotation)
 *
 * AFTER the session the user reviews every MARKER they dropped (SPACE or the
 * MARKER button), sees the surrounding transcript, selects the actual
 * word(s) that were disfluent, and confirms an annotation:
 *
 *   "Mark as Disfluency" → Stammer · Block · Filler · Stutter · Repetition · Prolongation
 *
 * Confirming creates OFFICIAL disfluency events with source "manual" — the
 * SAME event model as automatic detection, persisted to the authenticated
 * user's account (Supabase, or the local store for demo accounts). Once
 * confirmed, a manual event:
 *   • receives a stable annotation ID + references the selected token(s)
 *   • stores type, session id, timestamp, source="manual"
 *   • immediately renders with the EXISTING disfluency styling
 *     (filler → amber chip; stutter-like → purple underline) via the
 *     `annotations` overlay the parent passes to SessionTranscript
 *   • feeds the user's onset-letter history (stutter-like events store the
 *     COMPLETE word + its first letter; fillers keep the full word)
 *
 * A marker is a timestamped placeholder — NOT a disfluency. Only a manual
 * annotation makes it official.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Flag, Check, CircleDot, X } from "lucide-react";
import type { TranscriptToken } from "../lib/transcriptTokens";
import { deriveUtterances } from "../lib/sessionDisfluencies";
import {
  getOnsetLetterHistory,
  manualEventFromToken,
  persistEvents,
  type OfficialDisfluencyEvent,
  type SessionMarker,
  type UserAccount,
} from "../lib/manualAnnotations";
import MarkerChip from "./MarkerChip";

// ─── Existing terminology (preserved from the live view) ────────────────

export const ANNOTATION_TYPES: { type: string; label: string; filler: boolean }[] = [
  { type: "stammer", label: "Stammer", filler: false },
  { type: "block", label: "Block", filler: false },
  { type: "filler", label: "Filler", filler: true },
  { type: "stutter", label: "Stutter", filler: false },
  { type: "repetition", label: "Repetition", filler: false },
  { type: "prolongation", label: "Prolongation", filler: false },
];

const FILLER_STYLE = "text-amber-300/90 bg-amber-300/10";
const STUTTER_STYLE = "text-[#BD8CFF]/90 bg-[#BD8CFF]/10";

interface ManualAnnotationPanelProps {
  tokens: TranscriptToken[];
  markers: SessionMarker[];
  sessionId: string;
  account: UserAccount | null;
  /** Existing official events for this session (automatic + manual). */
  existingEvents?: OfficialDisfluencyEvent[];
  /** Called with every newly confirmed manual event. */
  onAnnotated?: (events: OfficialDisfluencyEvent[]) => void;
}

export default function ManualAnnotationPanel({
  tokens,
  markers,
  sessionId,
  account,
  existingEvents = [],
  onAnnotated,
}: ManualAnnotationPanelProps) {
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [choosingType, setChoosingType] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const [onsetHistory, setOnsetHistory] = useState<
    { letter: string; count: number }[]
  >([]);

  // Existing annotations keyed by token id → disfluency type (for display).
  const annotatedByToken = useMemo(() => {
    const m = new Map<string, { type: string; source: string }>();
    for (const e of existingEvents) {
      if (e.tokenId) m.set(e.tokenId, { type: e.type, source: e.source });
    }
    return m;
  }, [existingEvents]);

  const selectedMarker = useMemo(
    () => markers.find((m) => m.id === selectedMarkerId) ?? null,
    [markers, selectedMarkerId]
  );

  // ── Surrounding transcript window around the selected marker ──────────
  // The user reviews what happened AT the marker: the same utterance the
  // marker landed in plus one neighboring utterance on each side (the same
  // >1.5s-gap utterance grouping the live/session transcript used).
  const windowTokens = useMemo(() => {
    if (!selectedMarker || tokens.length === 0) return [];
    const utterances = deriveUtterances(tokens);
    const targetU = utterances.get(selectedMarker.tokenId ?? "");
    if (targetU != null) {
      return tokens
        .filter((t) => {
          const u = utterances.get(t.id);
          return u != null && Math.abs(u - targetU) <= 1;
        })
        .sort((a, b) => a.startTimeMs - b.startTimeMs);
    }
    // No token anchor — fall back to a time window (±6s around the marker).
    return tokens
      .filter(
        (t) =>
          Math.abs(t.startTimeMs - selectedMarker.timeMs) <= 6000 ||
          Math.abs(t.endTimeMs - selectedMarker.timeMs) <= 6000
      )
      .sort((a, b) => a.startTimeMs - b.startTimeMs);
  }, [selectedMarker, tokens]);

  const openMarker = useCallback((marker: SessionMarker) => {
    setSelectedMarkerId(marker.id);
    setSelectedIds(new Set());
    setChoosingType(false);
    setJustSaved(null);
  }, []);

  const toggleToken = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedTokens = useMemo(
    () => tokens.filter((t) => selectedIds.has(t.id)),
    [tokens, selectedIds]
  );

  // ── Load the user's onset-letter history (user-level database) ────────
  useEffect(() => {
    if (!account) return;
    let alive = true;
    getOnsetLetterHistory(account)
      .then((h) => {
        if (alive) setOnsetHistory(h);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [account, existingEvents.length]);

  const confirmAnnotation = useCallback(
    async (type: string) => {
      if (!account || selectedTokens.length === 0 || !sessionId) return;
      setSaving(true);
      const created: OfficialDisfluencyEvent[] = [];
      for (const t of selectedTokens) {
        // Skip tokens that already carry an official annotation (auto or
        // manual) — never double-count.
        if (annotatedByToken.has(t.id)) continue;
        const utterance = deriveUtterances(tokens).get(t.id) ?? 0;
        const sentence = tokens
          .filter(
            (x) => deriveUtterances(tokens).get(x.id) === utterance
          )
          .map((x) => x.word)
          .join(" ");
        created.push(
          manualEventFromToken(t, sessionId, type, utterance, sentence)
        );
      }
      if (created.length > 0) {
        await persistEvents(account, created);
        onAnnotated?.(created);
        setJustSaved(`${created.length} ${created.length === 1 ? "annotation" : "annotations"} saved`);
        setSelectedIds(new Set());
        setChoosingType(false);
      } else {
        setJustSaved("Already annotated — nothing new to save");
        setChoosingType(false);
      }
      setSaving(false);
    },
    [account, selectedTokens, sessionId, tokens, annotatedByToken, onAnnotated]
  );

  const selectedFiller = useMemo(() => {
    // If ALL selected tokens are already-annotated fillers we show their
    // word; otherwise preview the first letter of stutter-like words.
    const preview = selectedTokens.map((t) => {
      const existing = annotatedByToken.get(t.id);
      if (existing?.type === "filler") return `"${t.word}" (full word)`;
      const fl = t.firstLetter ?? t.word.toLowerCase().match(/[a-z]/)?.[0] ?? "—";
      return `"${t.word}" → ${fl}`;
    });
    return preview.join(", ");
  }, [selectedTokens, annotatedByToken]);

  const hasMarkers = markers.length > 0;

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="glass rounded-2xl p-5 border border-neon-purple/10">
      <div className="flex items-center gap-2 mb-3">
        <Flag className="w-4 h-4 text-cyan-300" />
        <h3 className="font-heading text-sm font-semibold text-white">
          Review Markers & Annotate
        </h3>
        <span className="ml-auto text-[10px] text-soft-gray/50">
          {hasMarkers
            ? `${markers.length} marker${markers.length === 1 ? "" : "s"} to review`
            : "SPACE during a session drops a marker"}
        </span>
      </div>

      {/* Marker list */}
      {!hasMarkers ? (
        <p className="text-xs text-soft-gray/50 leading-relaxed">
          You didn't drop any markers this session. Next time, press{" "}
          <kbd className="inline-flex items-center rounded bg-white/10 px-1.5 py-px text-[10px] text-white/80">
            SPACE
          </kbd>{" "}
          (or the MARKER button) when something feels off — you can annotate
          it here afterward.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {markers.map((m) => {
            const active = m.id === selectedMarkerId;
            const done = selectedIds.size === 0 && !!m.tokenId && annotatedByToken.has(m.tokenId);
            return (
              <button
                key={m.id}
                onClick={() => openMarker(m)}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-mono transition-all duration-200 active:scale-[0.97] cursor-pointer ${
                  active
                    ? "text-cyan-200 bg-cyan-300/20 border border-cyan-300/60"
                    : "text-cyan-300/80 bg-cyan-300/8 border border-cyan-300/30 hover:brightness-125"
                }`}
                title={`Marker @ ${(m.timeMs / 1000).toFixed(1)}s${
                  m.tokenId ? " — has an anchor word" : ""
                }`}
              >
                {done ? (
                  <Check className="w-3 h-3" />
                ) : (
                  <CircleDot className="w-3 h-3" />
                )}
                {(m.timeMs / 1000).toFixed(1)}s
              </button>
            );
          })}
        </div>
      )}

      {/* Review window */}
      {selectedMarker && windowTokens.length > 0 && (
        <div className="bg-white/5 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <MarkerChip marker={selectedMarker} compact />
            <span className="text-[10px] text-soft-gray/50">
              Review the transcript around this point — select the word(s)
              that were disfluent.
            </span>
            <button
              onClick={() => setSelectedMarkerId(null)}
              className="ml-auto text-soft-gray/50 hover:text-white transition-colors cursor-pointer"
              aria-label="Close review window"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Word chips — multi-select, keyboard accessible */}
          <div
            className="flex flex-wrap gap-1.5 leading-relaxed text-sm"
            role="group"
            aria-label="Transcript words around the marker"
          >
            {windowTokens.map((t) => {
              const existing = annotatedByToken.get(t.id);
              const isSelected = selectedIds.has(t.id);
              const cls = isSelected
                ? "ring-2 ring-cyan-300 text-cyan-100 bg-cyan-300/20 cursor-pointer"
                : existing
                  ? `${existing.type === "filler" ? FILLER_STYLE : STUTTER_STYLE} opacity-80 cursor-pointer`
                  : "text-white/80 hover:bg-white/10 cursor-pointer";
              return (
                <button
                  key={t.id}
                  onClick={() => toggleToken(t.id)}
                  tabIndex={0}
                  className={`inline-block rounded px-1 py-0.5 transition-all duration-150 active:scale-[0.96] ${cls}`}
                  title={
                    existing
                      ? `Already annotated: ${existing.type} (${existing.source})`
                      : `"${t.word}" · first letter ${t.firstLetter ?? "—"}`
                  }
                  aria-pressed={isSelected}
                >
                  {t.word}
                  {existing && (
                    <span className="ml-1 text-[9px] uppercase opacity-70">
                      ·{existing.type}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Annotation actions */}
          <div className="mt-3 pt-3 border-t border-white/10">
            {selectedTokens.length === 0 ? (
              <p className="text-[10px] text-soft-gray/50">
                Select one or more words above, then choose an annotation.
              </p>
            ) : choosingType ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] text-soft-gray/60 mr-1">
                  Mark as Disfluency:
                </span>
                {ANNOTATION_TYPES.map((a) => (
                  <button
                    key={a.type}
                    onClick={() => confirmAnnotation(a.type)}
                    disabled={saving}
                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-medium transition-all duration-200 active:scale-[0.97] cursor-pointer disabled:opacity-50"
                    style={{
                      color: a.filler ? "#FCD34D" : "#BD8CFF",
                      backgroundColor: a.filler
                        ? "rgba(252,211,77,0.1)"
                        : "rgba(189,140,255,0.1)",
                      border: `1px solid ${
                        a.filler
                          ? "rgba(252,211,77,0.3)"
                          : "rgba(189,140,255,0.3)"
                      }`,
                    }}
                  >
                    {a.label}
                  </button>
                ))}
                <button
                  onClick={() => setChoosingType(false)}
                  className="text-[10px] text-soft-gray/50 hover:text-white transition-colors cursor-pointer ml-1"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] text-soft-gray/60">
                  Selected:{" "}
                  <span className="text-white/80">{selectedFiller}</span>
                </span>
                <button
                  onClick={() => setChoosingType(true)}
                  className="inline-flex items-center gap-1 rounded-full bg-primary hover:bg-primary-hover text-white text-[11px] font-medium px-3 py-1.5 transition-all duration-200 active:scale-[0.97] cursor-pointer"
                >
                  <Flag className="w-3 h-3" />
                  Mark as Disfluency
                </button>
              </div>
            )}
            {justSaved && (
              <p className="text-[10px] text-emerald-300/90 mt-2" role="status">
                <Check className="w-3 h-3 inline mr-1" />
                {justSaved}
              </p>
            )}
          </div>
        </div>
      )}

      {/* User-level onset-letter history */}
      {account && onsetHistory.length > 0 && (
        <div className="mt-4 pt-3 border-t border-white/5">
          <p className="text-[10px] text-soft-gray/40 mb-1.5">
            Your onset-letter history (stutter-like words · complete word +
            first letter kept per event):
          </p>
          <div className="flex flex-wrap gap-1.5">
            {onsetHistory.map((h) => (
              <span
                key={h.letter}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-mono bg-[#BD8CFF]/10 text-[#BD8CFF]/90 border border-[#BD8CFF]/25"
                title={`${h.count} stutter-like event${h.count === 1 ? "" : "s"} starting with "${h.letter}"`}
              >
                <span className="font-bold">{h.letter}</span>
                <span className="opacity-60">×{h.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
