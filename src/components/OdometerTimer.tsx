import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";

interface OdometerTimerProps {
  duration?: number;
  isRunning: boolean;
  onComplete: () => void;
}

/**
 * Wall-clock countdown (never skips values).
 *
 * Spec: remaining = duration - (Date.now() - startTime);
 *       render Math.ceil(remaining / 1000);
 *       must display 1:00 → 0:59 → ... → 0:00 without skipping.
 */
export default function OdometerTimer({
  duration = 60,
  isRunning,
  onComplete,
}: OdometerTimerProps) {
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
    // Deadline from wall clock
    endAtRef.current = Date.now() + duration * 1000;
    doneRef.current = false;
    setTimeLeft(duration);

    const id = setInterval(() => {
      const remainingMs = endAtRef.current - Date.now();
      const seconds = Math.ceil(remainingMs / 1000);
      setTimeLeft(Math.max(0, seconds));
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

  const mins = Math.floor(timeLeft / 60)
    .toString()
    .padStart(2, "0");
  const secs = (timeLeft % 60).toString().padStart(2, "0");

  return (
    <div
      className="flex items-center text-7xl md:text-9xl font-bold font-mono tracking-tighter text-white"
      style={{ textShadow: "0 0 30px rgba(189,140,255,0.9)" }}
    >
      <DigitReel digit={mins[0]} />
      <DigitReel digit={mins[1]} />
      <span className="mx-2 pb-2 leading-none text-[#bd8cff] opacity-80">
        :
      </span>
      <DigitReel digit={secs[0]} />
      <DigitReel digit={secs[1]} />
    </div>
  );
}

function DigitReel({ digit }: { digit: string }) {
  const num = parseInt(digit, 10);
  return (
    <span
      className="relative flex items-center justify-center overflow-hidden leading-none"
      style={{ width: "1ch", height: "1em" }}
    >
      <motion.div
        className="absolute inset-x-0 top-0 flex flex-col"
        initial={false}
        animate={{ y: `-${num * 100}%` }}
        transition={{ type: "tween", duration: 0.3, ease: "easeOut" }}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
          <span
            key={d}
            className="flex items-center justify-center text-center leading-none"
            style={{ width: "1ch", height: "1em" }}
          >
            {d}
          </span>
        ))}
      </motion.div>
    </span>
  );
}