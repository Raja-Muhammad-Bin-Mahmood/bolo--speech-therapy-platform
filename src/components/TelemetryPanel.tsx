/**
 * BOLO — TelemetryPanel (developer telemetry rail)
 *
 * Pinned to the LEFT edge of the practice screen: a slim vertical rail of
 * live ΔE / ZCR / RMS meters with raw numeric readouts. These are the exact
 * same physics that feed the stutter/stammer detector (useAnalyserSensor),
 * so the numbers on screen are the numbers doing the detecting:
 *
 *   • RMS  → loudness / tense hold (stutter bursts, stammer)
 *   • ZCR  → fricative / noisy onsets (stutter bursts, stammer)
 *   • ΔE   → sudden onset spikes, plosive bursts (stutter burst pattern)
 *
 * Purpose: develop, debug and validate the speech telemetry engine while the
 * main recording interface runs untouched beside it.
 */

import { motion } from "framer-motion";
import { Activity } from "lucide-react";
import type { LiveSensorState } from "../hooks/useLiveSensor";
import type { AcousticEvent } from "../hooks/useAcousticAnalysis";

/** Sensor state + raw physics values + the detection events it has fired. */
export interface TelemetrySensor extends LiveSensorState {
  /** Unscaled RMS (0–~0.4 range, raw Float32 audio amplitude). */
  rawRms: number;
  /** Unscaled zero-crossing rate (0–1). */
  rawZcr: number;
  /** Unscaled frame-to-frame RMS delta (signed, can be negative). */
  rawDeltaEnergy: number;
  /** Detection events fired by the sensor lane (stutter / stammer). */
  events: AcousticEvent[];
}

interface TelemetryPanelProps {
  sensor: TelemetrySensor;
  isRecording: boolean;
}

// ─── Vertical meter ──────────────────────────────────────────────────────

function VMeter({
  label,
  value,
  raw,
  color,
  digits = 3,
  hint,
}: {
  label: string;
  /** Normalized 0–1 fill value. */
  value: number;
  /** Raw value shown in the debug readout. */
  raw: number;
  color: string;
  digits?: number;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1" aria-hidden="true">
      {/* Vertical bar — fills bottom-up */}
      <div className="relative w-2 h-24 rounded-full bg-white/5 overflow-hidden">
        <div
          className="absolute bottom-0 left-0 right-0 rounded-full transition-[height] duration-150 ease-out"
          style={{
            background: `linear-gradient(to top, ${color}55, ${color})`,
            height: `${Math.min(100, Math.max(0, value * 100))}%`,
          }}
        />
      </div>
      {/* Raw value */}
      <span className="text-[8px] font-mono text-white/80 tabular-nums leading-none">
        {raw.toFixed(digits)}
      </span>
      {/* Label */}
      <span className="text-[7px] text-soft-gray/50 uppercase tracking-widest leading-none">
        {label}
      </span>
      {/* What this lane detects */}
      {hint && (
        <span className="text-[6px] text-soft-gray/30 text-center leading-tight max-w-12">
          {hint}
        </span>
      )}
    </div>
  );
}

// ─── Panel ───────────────────────────────────────────────────────────────

export default function TelemetryPanel({
  sensor,
  isRecording,
}: TelemetryPanelProps) {
  const live = sensor.isActive;
  const stutters = sensor.events.filter((e) => e.type === "stutter").length;
  const stammers = sensor.events.filter((e) => e.type === "stammer").length;

  return (
    <motion.aside
      initial={{ x: -80, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className="fixed left-0 top-1/2 -translate-y-1/2 z-[25] hidden lg:flex flex-col items-center gap-3 glass rounded-r-2xl rounded-l-none border-l-0 px-2 py-5 select-none"
      aria-label="Speech telemetry debug panel — live delta-energy, zero-crossing rate and RMS meters"
    >
      {/* Header */}
      <Activity className="w-3 h-3 text-neon-purple" aria-hidden="true" />
      <span className="text-[6px] text-soft-gray/40 uppercase tracking-widest -mt-2">
        Sensor
      </span>

      {/* Status: live + recording */}
      <div className="flex flex-col items-center gap-1">
        <span
          className={`w-1.5 h-1.5 rounded-full transition-colors duration-200 ${
            live ? "bg-emerald-400" : "bg-soft-gray/40"
          }`}
        />
        <span
          className={`w-1.5 h-1.5 rounded-full transition-colors duration-200 ${
            isRecording ? "bg-red-400 animate-pulse" : "bg-soft-gray/40"
          }`}
        />
      </div>

      <div className="w-8 h-px bg-white/10" />

      {/* ΔE — plosive onset energy (feeds the stutter burst pattern) */}
      <VMeter
        label="ΔE"
        value={sensor.currentDeltaEnergy}
        raw={sensor.rawDeltaEnergy}
        color="#22D3EE"
        digits={3}
        hint="onset"
      />

      {/* ZCR — fricative / noisy bursts (feeds stutter + stammer) */}
      <VMeter
        label="ZCR"
        value={sensor.currentZcr}
        raw={sensor.rawZcr}
        color="#BD8CFF"
        digits={3}
        hint="noise"
      />

      {/* RMS — loudness / tense hold (feeds stutter + stammer) */}
      <VMeter
        label="RMS"
        value={sensor.currentRms}
        raw={sensor.rawRms}
        color="#6D56FF"
        digits={3}
        hint="level"
      />

      <div className="w-8 h-px bg-white/10" />

      {/* Detection counters — proof the telemetry drives the detector */}
      <div className="flex flex-col items-center gap-1">
        <span className="text-[6px] text-soft-gray/40 uppercase tracking-widest">
          Detected
        </span>
        <span className="text-[8px] font-mono text-[#F87171] tabular-nums">
          S {stutters}
        </span>
        <span className="text-[8px] font-mono text-[#BD8CFF] tabular-nums">
          M {stammers}
        </span>
      </div>
    </motion.aside>
  );
}
