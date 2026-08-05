import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

interface NeonTimerProps {
  /** Countdown duration in seconds */
  duration: number;
  onComplete: () => void;
  isRunning: boolean;
  className?: string;
}

/**
 * RollingDigit — one clock digit that rolls DOWN like an Apple clock /
 * odometer when its value changes: the new digit drops in from the top while
 * the old one slides out through the bottom. Each digit lives in a fixed-width,
 * overflow-hidden slot with absolutely-positioned children, so columns never
 * shift horizontally and there is no layout glitch mid-roll.
 */
function RollingDigit({ digit }: { digit: string }) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return (
      <span
        aria-hidden="true"
        className="relative inline-block overflow-hidden"
        style={{ width: "0.62em", height: "1.05em" }}
      >
        <span className="absolute inset-0 flex items-center justify-center">{digit}</span>
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className="relative inline-block overflow-hidden"
      style={{ width: "0.62em", height: "1.05em" }}
    >
      <AnimatePresence initial={false}>
        <motion.span
          key={digit}
          className="absolute inset-0 flex items-center justify-center"
          initial={{ y: "-115%" }}
          animate={{ y: 0 }}
          exit={{ y: "115%" }}
          transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
        >
          {digit}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * NeonTimer — the big unboxed countdown for the Unprompted session.
 *
 * Styled like the BOLO hero logo (Clash Display, white, soft purple glow) with
 * NO ring, card or border around it. Wall-clock backed so 1:00 → 0:59 → 0:00
 * is exact even if the tab is throttled. Seconds and minutes roll down as they
 * tick, just like an Apple clock face.
 */
export default function NeonTimer({
  duration,
  onComplete,
  isRunning,
  className,
}: NeonTimerProps) {
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

  const minutes = String(Math.floor(remaining / 60));
  const seconds = String(remaining % 60).padStart(2, "0");

  return (
    <div
      role="timer"
      aria-label={`${minutes} minutes and ${seconds} seconds remaining`}
      className={`select-none ${className ?? ""}`}
    >
      <span className="sr-only">{`${minutes}:${seconds}`}</span>
      <div
        className="flex items-center font-display font-bold text-white text-glow leading-none"
        style={{ fontSize: "clamp(4rem, 12vw, 7.5rem)" }}
      >
        <RollingDigit digit={minutes} />
        <span
          className="inline-block text-center animate-pulse"
          style={{ width: "0.3em", color: "rgba(189,140,255,0.9)" }}
        >
          :
        </span>
        <RollingDigit digit={seconds[0]} />
        <RollingDigit digit={seconds[1]} />
      </div>
    </div>
  );
}
