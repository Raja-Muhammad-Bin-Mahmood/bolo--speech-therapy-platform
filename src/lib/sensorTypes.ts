/**
 * BOLO — Sensor Layer Data Types
 *
 * The raw physics output of the AudioWorklet sensor pipeline.
 * No interpretation, no classification — just the numbers.
 *
 * Each SensorFrame represents one 20ms frame of audio analysis.
 */

/** A single frame of raw audio physics extracted in the AudioWorklet. */
export interface SensorFrame {
  /** Seconds since session start (worklet-relative). */
  timestamp: number;
  /** Root Mean Square energy of the frame (0–1 typically). */
  rms: number;
  /** Zero Crossing Rate (0–1). */
  zcr: number;
  /** Delta Energy from the exact previous frame (RMS change). */
  deltaEnergy: number;
  /** Optional: raw sample count in this frame (for debugging). */
  sampleCount?: number;
}

/** A completed recording session with its full sensor frame buffer. */
export interface SensorSession {
  /** Unique session identifier (timestamp-based). */
  sessionId: string;
  /** Timestamp when recording started (Date.now()). */
  startedAt: number;
  /** Timestamp when recording stopped (Date.now()). */
  endedAt: number;
  /** Total duration in seconds. */
  totalDuration: number;
  /** Ordered array of sensor frames from the session. */
  frames: SensorFrame[];
}

/** Live sensor state exposed by the useSensor hook. */
export interface SensorState {
  /** Current RMS value (latest frame). */
  currentRms: number;
  /** Current ZCR value (latest frame). */
  currentZcr: number;
  /** Current Delta Energy value (latest frame). */
  currentDeltaEnergy: number;
  /** Whether recording is currently active. */
  isRecording: boolean;
  /** Whether the audio pipeline is fully initialized and ready. */
  isReady: boolean;
  /** Timestamp of the latest frame (seconds since session start). */
  latestTimestamp: number;
  /** Rolling buffer of recent frames (≥30 seconds). */
  frameBuffer: SensorFrame[];
  /** Total number of frames received so far. */
  totalFrames: number;
}

/** Message posted from the worklet to the main thread. */
export interface SensorWorkletMessage {
  type: "frame";
  frame: {
    t: number;
    rms: number;
    zcr: number;
    deltaEnergy: number;
    sampleCount: number;
  };
}