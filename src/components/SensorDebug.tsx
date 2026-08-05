/**
 * BOLO — SensorDebug
 *
 * Minimal debug view that displays the live raw audio physics values
 * from the sensor layer in real time.
 *
 * This is deliberately UNPOLISHED — the goal is to verify the sensor
 * layer works, not to look good.
 */

import { motion } from "framer-motion";
import type { SensorState } from "../lib/sensorTypes";

interface SensorDebugProps {
  sensor: SensorState;
}

export default function SensorDebug({ sensor }: SensorDebugProps) {
  const { currentRms, currentZcr, currentDeltaEnergy, isRecording, isReady, totalFrames, latestTimestamp } = sensor;

  /** Format a float to a fixed number of significant digits. */
  const fmt = (v: number, digits = 4) => v.toFixed(digits);

  /** Map a sensor value to a bar width percentage (0–100). */
  const barWidth = (v: number, max = 0.5) =>
    Math.min(100, Math.max(0, (v / max) * 100));

  /** Color for a value bar — green when quiet, yellow/red when active. */
  const barColor = (v: number, threshold = 0.1) =>
    v > threshold * 2 ? "#FF6B6B" : v > threshold ? "#FBBF24" : "#34D399";

  return (
    <div className="bg-deep-space/80 backdrop-blur-md border border-white/10 rounded-xl p-5 font-mono text-xs">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-white/5">
        <span className="text-neon-purple font-semibold text-sm tracking-wide">
          SENSOR LAYER
        </span>
        <div className="flex items-center gap-2">
          {/* Readiness dot */}
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              isReady ? "bg-green-400" : "bg-soft-gray/40"
            }`}
          />
          <span className="text-soft-gray/60 text-[10px]">
            {isReady ? "READY" : "OFFLINE"}
          </span>
          {/* Recording dot */}
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              isRecording ? "bg-red-400 animate-pulse" : "bg-soft-gray/40"
            }`}
          />
          <span className="text-soft-gray/60 text-[10px]">
            {isRecording ? "REC" : "IDLE"}
          </span>
        </div>
      </div>

      {/* Telemetry values */}
      <div className="space-y-3">
        {/* RMS */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-soft-gray/80">RMS</span>
            <span className="text-white font-bold tabular-nums">
              {fmt(currentRms)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-white/5 overflow-hidden">
            <motion.div
              className="h-full rounded-full transition-all duration-75"
              style={{
                width: `${barWidth(currentRms)}%`,
                backgroundColor: barColor(currentRms),
              }}
            />
          </div>
        </div>

        {/* ZCR */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-soft-gray/80">ZCR</span>
            <span className="text-white font-bold tabular-nums">
              {fmt(currentZcr)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-white/5 overflow-hidden">
            <motion.div
              className="h-full rounded-full transition-all duration-75"
              style={{
                width: `${barWidth(currentZcr, 0.5)}%`,
                backgroundColor: barColor(currentZcr, 0.15),
              }}
            />
          </div>
        </div>

        {/* Delta Energy */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-soft-gray/80">Δ Energy</span>
            <span className="text-white font-bold tabular-nums">
              {fmt(currentDeltaEnergy)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-white/5 overflow-hidden">
            <motion.div
              className="h-full rounded-full transition-all duration-75"
              style={{
                width: `${barWidth(Math.abs(currentDeltaEnergy), 0.2)}%`,
                backgroundColor: barColor(Math.abs(currentDeltaEnergy), 0.05),
              }}
            />
          </div>
        </div>
      </div>

      {/* Footer stats */}
      <div className="mt-4 pt-3 border-t border-white/5 grid grid-cols-2 gap-2 text-[10px] text-soft-gray/50">
        <span>Frames: {totalFrames.toLocaleString()}</span>
        <span>Time: {latestTimestamp.toFixed(1)}s</span>
      </div>

      {/* Legend */}
      <div className="mt-3 pt-2 border-t border-white/5 text-[9px] text-soft-gray/40 leading-relaxed">
        <p>Silence → RMS near 0, ZCR near 0</p>
        <p>Fricative (sssss) → ZCR elevated, moderate RMS</p>
        <p>Plosive (P/B) → Δ Energy spike, brief RMS burst</p>
      </div>
    </div>
  );
}