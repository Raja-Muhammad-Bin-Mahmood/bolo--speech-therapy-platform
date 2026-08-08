import { useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PhoneOff,
  PhoneIncoming,
  Signal,
  Mic,
  AlertTriangle,
  X,
} from "lucide-react";
import type { CallContext, TranscriptLine } from "../lib/closerTypes";

export function formatCallTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

interface CallScreenProps {
  phase: "ringing" | "connecting" | "live" | "ending" | "error";
  /** Explicit live-call sub-state (per spec §23). */
  liveState: string;
  context: CallContext;
  elapsed: number;
  transcript: TranscriptLine[];
  customerPartial: string;
  /** Live user transcript (from Gemini input transcription). */
  userPartial: string;
  customerSpeaking: boolean;
  /** 0–1 user mic level (drives the user waveform + mic glow). */
  speakingLevel: number;
  interruptedAt: number;
  liveError: string | null;
  micMissing: boolean;
  sttNote: boolean;
  liveStatus: string;
  onEnd: () => void;
}

function Avatar({
  name,
  size,
  speaking,
}: {
  name: string;
  size: "lg" | "md";
  speaking: boolean;
}) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const dims = size === "lg" ? "w-28 h-28 text-4xl" : "w-10 h-10 text-sm";
  return (
    <div className="relative shrink-0">
      {speaking && (
        <motion.div
          className="absolute inset-0 rounded-full bg-neon-purple/40 blur-xl"
          animate={{ opacity: [0.35, 0.9, 0.35], scale: [1, 1.14, 1] }}
          transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
          aria-hidden
        />
      )}
      <div
        className={`relative ${dims} rounded-full bg-gradient-to-br from-neon-purple to-electric-violet flex items-center justify-center font-heading font-bold text-white ring-4 ring-white/10 shadow-2xl`}
      >
        {initials}
      </div>
    </div>
  );
}

/** Decorative speaking-level bars for the caller (deterministic shape). */
function LevelBars({ level }: { level: number }) {
  const heights = useMemo(
    () =>
      Array.from({ length: 18 }, (_, i) => 0.3 + 0.7 * Math.abs(Math.sin(i * 2.4))),
    []
  );
  return (
    <div className="flex items-center justify-center gap-[3px] h-10" aria-hidden>
      {heights.map((h, i) => {
        const active = level > 0.02 && (i + Math.floor(Date.now() / 120)) % 4 < 3;
        const hgt = active ? h * (0.4 + level) : 0.08;
        return (
          <div
            key={i}
            className="w-[3px] rounded-full bg-gradient-to-t from-neon-purple to-electric-violet transition-all duration-100"
            style={{ height: `${Math.max(3, hgt * 40)}px` }}
          />
        );
      })}
    </div>
  );
}

export default function CallScreen(props: CallScreenProps) {
  const {
    phase,
    liveState,
    context,
    elapsed,
    transcript,
    customerPartial,
    userPartial,
    customerSpeaking,
    speakingLevel,
    interruptedAt,
    liveError,
    micMissing,
    sttNote,
    liveStatus,
    onEnd,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript.length, customerPartial]);

  const showInterrupted =
    interruptedAt > 0 && Date.now() - interruptedAt < 3500;

  const statusLine =
    phase === "ringing"
      ? "Calling…"
      : phase === "connecting"
        ? "Connecting…"
        : phase === "error"
          ? "Call failed"
          : "Connected";

  return (
    <motion.div
      key="call"
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto w-full max-w-sm"
    >
      {/* Phone frame */}
      <div className="glass-strong rounded-[2.5rem] border border-white/10 shadow-2xl p-6 relative overflow-hidden">
        <div className="absolute -top-24 -right-24 w-64 h-64 rounded-full bg-neon-purple/20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -left-24 w-64 h-64 rounded-full bg-electric-violet/20 blur-3xl pointer-events-none" />

        <div className="relative flex flex-col items-center">
          {/* Header */}
          <div className="w-full flex items-center justify-between mb-8">
            <span className="text-[10px] uppercase tracking-widest text-soft-gray/50">
              Cold call
            </span>
            <div className="flex items-center gap-2">
              {phase === "live" && (
                <>
                  <Signal className="w-4 h-4 text-emerald-300" aria-label="Signal" />
                  <span className="font-mono text-sm text-white tabular-nums">
                    {formatCallTime(elapsed)}
                  </span>
                </>
              )}
              {phase === "ringing" && (
                <button
                  onClick={onEnd}
                  aria-label="Cancel call"
                  className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-soft-gray transition-all active:scale-90 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Avatar + status */}
          <div className="flex flex-col items-center mb-6">
            <div className="relative">
              {/* Ringing pulse rings */}
              {phase === "ringing" && (
                <>
                  {[0, 1, 2].map((i) => (
                    <motion.span
                      key={i}
                      className="absolute inset-0 rounded-full border border-neon-purple/40"
                      animate={{ scale: [1, 1.9], opacity: [0.7, 0] }}
                      transition={{
                        duration: 1.8,
                        repeat: Infinity,
                        delay: i * 0.6,
                        ease: "easeOut",
                      }}
                      aria-hidden
                    />
                  ))}
                </>
              )}
              <Avatar
                name={context.customerName}
                size="lg"
                speaking={phase === "live" && customerSpeaking}
              />
            </div>

            <h2 className="font-heading text-2xl font-bold text-white mt-5">
              {context.customerName}
            </h2>
            <p className="text-xs text-soft-gray/60 mt-1">
              {phase === "live" ? (
                <>
                  Selling <span className="text-neon-purple">{context.product}</span>
                </>
              ) : phase === "ringing" ? (
                <span className="flex items-center gap-1.5">
                  <PhoneIncoming className="w-3.5 h-3.5 text-neon-purple animate-pulse" />
                  Ring… Ring… Ring…
                </span>
              ) : (
                <span className="text-neon-purple animate-pulse">{statusLine}</span>
              )}
            </p>
          </div>

          {/* Live call body — visible for live AND error so the classified
              error banner + End Call control always stay reachable. */}
          {(phase === "live" || phase === "error") && (
            <div className="w-full flex flex-col items-center gap-4">
              {/* Transcript — rendered live, or kept if the call already had
                  content when an unexpected error hit. */}
              {(phase === "live" ||
                transcript.length > 0 ||
                customerPartial ||
                userPartial) && (
                <div
                  ref={scrollRef}
                  className="w-full h-52 overflow-y-auto space-y-2.5 pr-1 rounded-xl"
                  role="log"
                  aria-live="polite"
                  aria-label="Call transcript"
                >
                  {phase === "live" &&
                    transcript.length === 0 &&
                    !customerPartial && (
                      <p className="text-center text-xs text-soft-gray/40 pt-10">
                        Say hello — the customer just picked up…
                      </p>
                    )}
                {transcript.map((line, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-2 ${line.role === "user" ? "flex-row-reverse" : ""}`}
                  >
                    <span className="text-[10px] font-mono text-soft-gray/40 mt-1 w-8 shrink-0 text-right">
                      {formatCallTime(line.atSec)}
                    </span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${
                        line.role === "customer"
                          ? "bg-neon-purple/20 text-neon-purple"
                          : "bg-electric-violet/20 text-electric-violet"
                      }`}
                    >
                      {line.role === "customer" ? "Customer" : "You"}
                    </span>
                    <p
                      className={`text-sm leading-relaxed max-w-[70%] ${
                        line.role === "user"
                          ? "text-white/90 text-left"
                          : "text-white/90"
                      }`}
                    >
                      {line.text}
                    </p>
                  </div>
                ))}

                {userPartial && (
                  <div className="flex items-start gap-2 flex-row-reverse">
                    <span className="text-[10px] font-mono text-soft-gray/40 mt-1 w-8 shrink-0 text-right">
                      {formatCallTime(elapsed)}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0 mt-0.5 bg-electric-violet/20 text-electric-violet">
                      You
                    </span>
                    <p className="text-sm leading-relaxed text-white/60 italic max-w-[70%] text-left">
                      {userPartial}
                      <span className="inline-block w-1.5 h-3.5 bg-electric-violet/70 ml-0.5 align-middle animate-pulse" />
                    </p>
                  </div>
                )}

                {customerPartial && (
                  <div className="flex items-start gap-2">
                    <span className="text-[10px] font-mono text-soft-gray/40 mt-1 w-8 shrink-0 text-right">
                      {formatCallTime(elapsed)}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0 mt-0.5 bg-neon-purple/20 text-neon-purple">
                      Customer
                    </span>
                    <p className="text-sm leading-relaxed text-white/60 italic max-w-[70%]">
                      {customerPartial}
                      <span className="inline-block w-1.5 h-3.5 bg-neon-purple/70 ml-0.5 align-middle animate-pulse" />
                    </p>
                  </div>
                )}
                </div>
              )}

              {/* Customer speaking waveform */}
              {customerSpeaking && (
                <div className="flex items-center gap-2 text-neon-purple/80">
                  <VolumePulse />
                  <span className="text-xs">Customer speaking…</span>
                </div>
              )}

              {/* Banners */}
              {liveError && (
                <div className="w-full rounded-xl bg-rose-500/10 border border-rose-500/20 px-3 py-2.5 flex items-start gap-2 text-xs text-rose-200">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    We couldn't reach the customer ({liveError}). You can end the
                    call.
                  </span>
                </div>
              )}
              {micMissing && (
                <div className="w-full rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2.5 flex items-start gap-2 text-xs text-amber-200">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    No microphone detected — the customer can't hear you. Allow
                    mic access and try a new call.
                  </span>
                </div>
              )}
              {sttNote && !micMissing && (
                <p className="text-[10px] text-soft-gray/50">
                  Your side of the transcript isn't being captured right now.
                </p>
              )}

              {/* Explicit live-call state (per spec §23) */}
              <div className="w-full flex justify-center">
                <span
                  className="text-[10px] px-2.5 py-1 rounded-full bg-white/5 text-soft-gray/60 uppercase tracking-widest"
                  role="status"
                  aria-label={`Call state: ${liveState}`}
                >
                  {liveState.replace(/_/g, " ")}
                </span>
              </div>

              {/* Controls */}
              <div className="flex items-center justify-center gap-8 w-full pt-2">
                <div
                  className={`w-14 h-14 rounded-full glass flex items-center justify-center transition-shadow duration-300 ${
                    speakingLevel > 0.03 ? "neon-glow" : ""
                  }`}
                  aria-label={`Microphone ${speakingLevel > 0.03 ? "active" : "idle"}`}
                >
                  <Mic
                    className={`w-5 h-5 transition-colors ${
                      speakingLevel > 0.03 ? "text-neon-purple" : "text-soft-gray/50"
                    }`}
                  />
                </div>
                <button
                  onClick={onEnd}
                  aria-label="End call"
                  className="w-16 h-16 rounded-full bg-gradient-to-br from-rose-500 to-rose-600 flex items-center justify-center text-white shadow-lg shadow-rose-500/30 transition-all duration-200 hover:scale-105 active:scale-[0.94] cursor-pointer"
                >
                  <PhoneOff className="w-6 h-6" />
                </button>
              </div>

              <LevelBars level={speakingLevel} />
            </div>
          )}

          {/* Interrupted toast */}
          <AnimatePresence>
            {showInterrupted && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                className="absolute bottom-24 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full glass px-4 py-2 text-xs text-soft-gray"
                role="status"
              >
                They cut you off — hold your ground.
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {phase === "connecting" && liveStatus === "connecting" && (
        <p className="text-center text-xs text-soft-gray/50 mt-4 animate-pulse">
          Dialing {context.customerName}…
        </p>
      )}
    </motion.div>
  );
}

function VolumePulse() {
  return (
    <span className="flex items-end gap-[2px] h-3" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="w-[3px] rounded-full bg-neon-purple"
          animate={{ height: [4, 10, 4] }}
          transition={{ duration: 0.7, repeat: Infinity, delay: i * 0.18 }}
        />
      ))}
    </span>
  );
}
