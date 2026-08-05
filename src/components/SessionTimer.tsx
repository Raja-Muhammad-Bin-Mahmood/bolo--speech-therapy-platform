import { useState, useEffect, useRef } from "react";

interface SessionTimerProps {
  /** Duration in seconds */
  duration: number;
  onComplete: () => void;
  isRunning: boolean;
}

/**
 * Circular countdown backed by the WALL CLOCK — never skips values.
 *
 * Spec: remaining = duration - (Date.now() - startTime);
 *       render Math.ceil(remaining / 1000) so 1:00 → 0:59 → ... → 0:00
 *       is always exact even if the tab is throttled or the interval drifts.
 */
export default function SessionTimer({
  duration,
  onComplete,
  isRunning,
}: SessionTimerProps) {
  const [remaining, setRemaining] = useState(duration);
  const endAtRef = useRef(0);
  const doneRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!isRunning) {
      setRemaining(duration);
      doneRef.current = false;
      return;
    }
    endAtRef.current = Date.now() + duration * 1000;
    doneRef.current = false;
    setRemaining(duration);

    const interval = setInterval(() => {
      const remainingMs = endAtRef.current - Date.now();
      setRemaining(Math.max(0, Math.ceil(remainingMs / 1000)));
      if (remainingMs <= 0) {
        clearInterval(interval);
        if (!doneRef.current) {
          doneRef.current = true;
          onCompleteRef.current();
        }
      }
    }, 100);
    return () => clearInterval(interval);
  }, [isRunning, duration]);

  const progress = ((duration - remaining) / duration) * 100;

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  return (
    <div className="flex flex-col items-center gap-2">
      {/* Circular timer */}
      <div className="relative w-20 h-20">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 72 72">
          <circle
            cx="36"
            cy="36"
            r="30"
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth="4"
          />
          <circle
            cx="36"
            cy="36"
            r="30"
            fill="none"
            stroke="url(#timerGradient)"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * 30}`}
            strokeDashoffset={`${2 * Math.PI * 30 * (1 - progress / 100)}`}
            className="transition-all duration-100 ease-linear"
          />
          <defs>
            <linearGradient id="timerGradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#6D56FF" />
              <stop offset="100%" stopColor="#BD8CFF" />
            </linearGradient>
          </defs>
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-heading text-lg font-bold text-white tabular-nums">
            {`${minutes}:${seconds.toString().padStart(2, "0")}`}
          </span>
        </div>
      </div>
    </div>
  );
}