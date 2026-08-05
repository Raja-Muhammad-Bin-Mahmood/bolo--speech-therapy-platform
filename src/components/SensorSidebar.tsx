/**
 * BOLO — SensorSidebar
 *
 * Vertical sensor display showing live RMS, ZCR, and Delta Energy
 * as vertical meters on the side of the recording view.
 */

import { motion } from "framer-motion";
import { type LiveSensorState } from "../hooks/useLiveSensor";

interface SensorSidebarProps {
  sensor: LiveSensorState;
  isRecording: boolean;
}

function Meter({
  label,
  value,
  color,
  format = "linear",
}: {
  label: string;
  value: number;
  color: string;
  format?: "linear" | "zcr" | "energy";
}) {
  let displayValue = value;
  let displayLabel = "";

  if (format === "linear") {
    displayLabel = `${Math.round(value * 100)}%`;
  } else if (format === "zcr") {
    displayLabel = (value * 100).toFixed(0);
  } else if (format === "energy") {
    displayLabel = (value * 100).toFixed(0);
  }

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative w-3 h-32 rounded-full bg-white/5 overflow-hidden">
        {/* Fill from bottom */}
        <motion.div
          className="absolute bottom-0 left-0 right-0 rounded-full transition-[height] duration-100"
          style={{
            background: `linear-gradient(to top, ${color}60, ${color})`,
            height: `${Math.min(100, Math.max(0, displayValue * 100))}%`,
          }}
          layout
        />
      </div>
      <span className="text-[9px] font-mono text-white/70 font-semibold">
        {displayLabel}
      </span>
      <span className="text-[8px] text-soft-gray/50 uppercase tracking-wider">
        {label}
      </span>
    </div>
  );
}

export default function SensorSidebar({ sensor, isRecording }: SensorSidebarProps) {
  if (!isRecording) return null;

  return (
    <div className="fixed right-4 top-1/2 -translate-y-1/2 z-30">
      <div className="glass rounded-2xl px-2.5 py-5 flex flex-col items-center gap-4">
        {/* Label */}
        <div className="text-[7px] text-soft-gray/40 uppercase tracking-widest text-center leading-tight">
          Audio<br />Physics
        </div>

        <Meter
          label="RMS"
          value={sensor.currentRms}
          color="#6D56FF"
          format="linear"
        />

        <div className="w-6 h-px bg-white/5" />

        <Meter
          label="ZCR"
          value={sensor.currentZcr}
          color="#BD8CFF"
          format="zcr"
        />

        <div className="w-6 h-px bg-white/5" />

        <Meter
          label="ΔE"
          value={sensor.currentDeltaEnergy}
          color="#22D3EE"
          format="energy"
        />

        {/* Status dot */}
        <div
          className={`w-1.5 h-1.5 rounded-full ${
            sensor.isActive ? "bg-emerald-400" : "bg-red-400"
          }`}
        />
      </div>
    </div>
  );
}