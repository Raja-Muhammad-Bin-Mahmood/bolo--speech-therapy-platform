import { useState, useEffect, useRef } from "react";

interface CountdownTimerProps {
  duration?: number;
  isRunning: boolean;
  onComplete: () => void;
}

/**
 * Wall-clock countdown displaying raw seconds (no modulo, no MM:SS).
 *
 * Per spec: start at `duration`, decrement every 1000 ms, stop at 0.
 * Uses Math.ceil so the display is always correct even under tab throttling.
 * No overflow-hidden boxes — the glow spreads organically.
 */
export default function CountdownTimer({
  duration = 60,
  isRunning,
  onComplete,
}: CountdownTimerProps) {
  const [timeLeft, setTimeLeft] = useState(duration);
  const endAtRef = useRef(0);
  const doneRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!isRunning) {
      setTimeLeft(duration);
      doneRef.current = false;
      return;
    }
    endAtRef.current = Date.now() + duration * 1000;
    doneRef.current = false;
    setTimeLeft(duration);

    const id = setInterval(() => {
      const remainingMs = endAtRef.current - Date.now();
      const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
      setTimeLeft(seconds);
      if (remainingMs <= 0) {
        clearInterval(id);
        if (!doneRef.current) {
          doneRef.current = true;
          onCompleteRef.current();
        }
      }
    }, 100);
    return () => clearInterval(id);
  }, [isRunning, duration]);

  const isUrgent = timeLeft <= 10 && isRunning;

  return (
    <div className="flex flex-col items-center gap-1">
      <span
        className="font-heading font-bold tabular-nums leading-none select-none transition-colors duration-500"
        style={{
          fontSize: "clamp(3rem, 12vw, 6rem)",
          color: isUrgent ? "#F87171" : "#fff",
          textShadow: isUrgent
            ? "0 0 20px rgba(248,113,113,0.5), 0 0 60px rgba(248,113,113,0.2)"
            : "0 0 16px rgba(189,140,255,0.5), 0 0 42px rgba(109,86,255,0.3), 0 0 90px rgba(109,86,255,0.15)",
        }}
      >
        {timeLeft}
        <span
          className="text-sm font-sans font-normal ml-1 align-baseline"
          style={{ color: isUrgent ? "rgba(248,113,113,0.6)" : "rgba(255,255,255,0.5)" }}
        >
          s
        </span>
      </span>
      <span className="text-[10px] text-soft-gray/40 uppercase tracking-wider">
        seconds remaining
      </span>
    </div>
  );
}