/**
 * BOLO — SensorSidebar
 *
 * Live RMS / ZCR / ΔEnergy vertical meters — the SAME values that drive
 * the stutter/stammer detector (useAnalyserSensor). Shown on the left of
 * the practice screen while recording, so the physics you see are the
 * physics doing the detecting.
 */

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
      <div className="relative w-2.5 h-24 rounded-full bg-white/5 overflow-hidden">
        {/* Fill from bottom */}
        <div
          className="absolute bottom-0 left-0 right-0 rounded-full transition-[height] duration-100"
          style={{
            background: `linear-gradient(to top, ${color}60, ${color})`,
            height: `${Math.min(100, Math.max(0, displayValue * 100))}%`,
          }}
        />
      </div>
      <span className="text-[9px] font-mono text-white/70 font-semibold tabular-nums">
        {displayLabel}
      </span>
      <span className="text-[8px] text-soft-gray/50 uppercase tracking-wider">
        {label}
      </span>
    </div>
  );
}

export default function SensorSidebar({
  sensor,
  isRecording,
}: SensorSidebarProps) {
  if (!isRecording) return null;

  return (
    <div className="flex flex-col items-center gap-2.5 select-none">
      {/* Label */}
      <div className="text-[7px] text-soft-gray/40 uppercase tracking-widest text-center leading-tight">
        Audio
        <br />
        Physics
      </div>

      <div className="flex items-end gap-2.5">
        <Meter
          label="RMS"
          value={sensor.currentRms}
          color="#6D56FF"
          format="linear"
        />

        <Meter
          label="ZCR"
          value={sensor.currentZcr}
          color="#BD8CFF"
          format="zcr"
        />

        <Meter
          label="ΔE"
          value={sensor.currentDeltaEnergy}
          color="#22D3EE"
          format="energy"
        />
      </div>

      {/* Status */}
      <div className="flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            sensor.isActive ? "bg-emerald-400" : "bg-red-400"
          }`}
        />
        <span className="text-[8px] font-mono text-soft-gray/40 tracking-wider">
          {sensor.isActive ? "LIVE" : "OFF"}
        </span>
      </div>
    </div>
  );
}
