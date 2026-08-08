/**
 * BOLO — Shared Acoustic Event Merge (single source of truth)
 *
 * Detectors A (worklet/Meyda analysis) and B (RMS/ZCR/ΔEnergy sensor)
 * run on the SAME shared analyser, so a real disfluency often produces
 * an event on BOTH lanes (A sees the fricative spectral pattern, B sees
 * the energy burst). Historically the app merged them with a blind
 * `[...a, ...b]`, which:
 *
 *   • double-counted the same stutter (two events, same timestamp, same
 *     type) across every surface — live metrics, feed, transcript, review;
 *   • gave the fusion layer NO way to know two detectors had agreed.
 *
 * This module is the ONE place all surfaces read events from:
 *
 *   • merges A+B, sorting by startTime
 *   • dedupes near-identical same-type events (same physical disfluency
 *     detected by both lanes) — the STRONGER confidence wins and absorbs
 *     the other's source
 *   • marks `corroborated` on any event when the OTHER lane emitted a
 *     same-type event overlapping it — real cross-detector agreement
 *     evidence for the fusion layer
 *
 * The detectors are untouched — this is merge/dedupe/attribution only.
 */

import type { AcousticEvent } from "../hooks/useAcousticAnalysis";

/** Two events are the same physical disfluency when they share a type and
 *  their windows overlap by at least this fraction of the shorter one. */
const SAME_EVENT_OVERLAP = 0.4;
/** Corroboration window: same-type event from the other lane within ±ms. */
const CORROBORATE_WINDOW_MS = 350;

function overlapRatio(a: AcousticEvent, b: AcousticEvent): number {
  const intersect = Math.max(
    0,
    Math.min(a.endTime, b.endTime) - Math.max(a.startTime, b.startTime)
  );
  const shorter = Math.min(a.endTime - a.startTime, b.endTime - b.startTime);
  if (shorter <= 0) return 0;
  return intersect / shorter;
}

/**
 * Merge two detector lanes into ONE event pool. Pure — never mutates the
 * inputs. Every surface (live metrics, feed, transcript, review) reads
 * from here so they always agree on the exact same set of events.
 */
export function mergeAcousticEvents(
  detectorA: AcousticEvent[],
  detectorB: AcousticEvent[]
): AcousticEvent[] {
  const a: AcousticEvent[] = detectorA.map((e) => ({ ...e }));
  const b: AcousticEvent[] = detectorB.map((e) => ({ ...e }));

  // ── Dedupe same-type near-identical events (the same disfluency seen
  //    by both lanes). The stronger confidence wins and absorbs the
  //    other's source — so the single surviving event carries both
  //    `source` markers and is later flagged `corroborated`.
  for (const evtB of b) {
    let absorbed = false;
    for (const evtA of a) {
      if (evtA.type !== evtB.type) continue;
      if (overlapRatio(evtA, evtB) < SAME_EVENT_OVERLAP) continue;
      // Same physical event — merge into A's entry, keep the stronger signal.
      absorbed = true;
      if (evtB.confidence > evtA.confidence) {
        evtA.confidence = evtB.confidence;
        evtA.acoustic = Math.max(evtA.acoustic, evtB.acoustic);
      }
      evtA.startTime = Math.min(evtA.startTime, evtB.startTime);
      evtA.endTime = Math.max(evtA.endTime, evtB.endTime);
      evtA.durationMs = Math.round((evtA.endTime - evtA.startTime) * 1000);
      evtA.source = "acoustic+sensor";
      break;
    }
    if (!absorbed) a.push(evtB);
  }

  // ── Corroboration: an event is corroborated when the OTHER lane emitted
  //    a same-type event overlapping it (within ±350ms). Cross-detector
  //    agreement is REAL evidence for the fusion layer — it no longer has
  //    to treat A and B as independent unknowns.
  for (const evt of a) {
    const others =
      evt.source === "sensor" || evt.source === "acoustic+sensor"
        ? a.filter((o) => o !== evt && (o.source === "acoustic" || o.source === "acoustic+sensor"))
        : a.filter((o) => o !== evt && o.source === "sensor");
    evt.corroborated = others.some(
      (o) =>
        o.type === evt.type &&
        Math.abs(o.startTime - evt.startTime) * 1000 <= CORROBORATE_WINDOW_MS
    );
  }

  return a.sort((x, y) => x.startTime - y.startTime);
}
