import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight, Sparkles } from "lucide-react";

// ─── Topic Pool ─────────────────────────────────────────────────────────

const TOPIC_POOL = [
  "Describe your ideal vacation destination and what you'd do there.",
  "Explain a skill you've learned recently and how it changed you.",
  "Tell a story about a memorable meal you've had.",
  "What does your perfect morning routine look like?",
  "If you could master any instrument overnight, which would you choose and why?",
  "Describe a place that makes you feel completely at peace.",
  "What's a movie or book that changed how you think?",
  "If you could have dinner with any three people, living or dead, who would they be?",
  "What does 'success' mean to you in your own words?",
  "Describe a time you had to advocate for yourself or someone else.",
  "If you could design your own dream home, what would it include?",
  "What's a tradition from your family or culture that you value?",
  "If you could instantly gain any one superpower, what would it be and why?",
  "What's the most interesting conversation you've had recently?",
  "Describe a challenge you overcame and what it taught you.",
  "If you could travel to any era in history, when and where would you go?",
  "What does your ideal weekend look like?",
  "Tell me about a person who has had a significant influence on your life.",
  "If you could eliminate one chore from your life forever, what would it be?",
  "What's a small thing that brings you joy every day?",
];

// ─── Audio helpers (Web Audio API for the pull-lever sounds) ────────────

function useAudioEngine() {
  const ctxRef = useRef<AudioContext | null>(null);

  const getCtx = useCallback(() => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
    }
    return ctxRef.current;
  }, []);

  const playClick = useCallback(() => {
    try {
      const ctx = getCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.12);
    } catch {}
  }, [getCtx]);

  const playSpin = useCallback(() => {
    try {
      const ctx = getCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(200, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + 0.6);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.7);
    } catch {}
  }, [getCtx]);

  const playLatch = useCallback(() => {
    try {
      const ctx = getCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(1200, ctx.currentTime);
      osc.frequency.setValueAtTime(600, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } catch {}
  }, [getCtx]);

  return { playClick, playSpin, playLatch };
}

// ─── Component ──────────────────────────────────────────────────────────

interface TopicDrumProps {
  onSelect: (topic: string) => void;
  onBack?: () => void;
}

export default function TopicDrum({ onSelect, onBack: _onBack }: TopicDrumProps) {
  const [visibleTopics, setVisibleTopics] = useState<string[]>(() =>
    TOPIC_POOL.slice(0, 5)
  );
  const [spinOffset, setSpinOffset] = useState(0);
  const [isSpinning, setIsSpinning] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { playClick, playSpin, playLatch } = useAudioEngine();

  // Build the visible window
  const allTopics = TOPIC_POOL;

  const spin = useCallback(() => {
    if (isSpinning) return;
    setIsSpinning(true);
    playSpin();

    // Rapid random ticks
    let ticks = 0;
    const totalTicks = 8 + Math.floor(Math.random() * 6);
    const interval = setInterval(() => {
      ticks++;
      setSpinOffset((prev) => (prev + 1) % allTopics.length);
      playClick();

      if (ticks >= totalTicks) {
        clearInterval(interval);
        // Land on final
        const finalOffset = Math.floor(Math.random() * allTopics.length);
        setSpinOffset(finalOffset);
        playLatch();
        setIsSpinning(false);
        setSelectedIndex(finalOffset);
      }
    }, 80 + ticks * 20);
  }, [isSpinning, allTopics.length, playSpin, playClick, playLatch]);

  // Update visible window based on offset
  useEffect(() => {
    const windowed: string[] = [];
    for (let i = 0; i < 5; i++) {
      windowed.push(allTopics[(spinOffset + i) % allTopics.length]);
    }
    setVisibleTopics(windowed);
  }, [spinOffset, allTopics]);

  const handleConfirm = () => {
    if (selectedIndex === null) return;
    onSelect(allTopics[selectedIndex]);
  };

  return (
    <div className="w-full max-w-xl mx-auto" ref={containerRef}>
      {/* Lever / Spin area */}
      <div className="glass-strong rounded-2xl p-6 relative overflow-hidden">
        {/* Subtle inner glow */}
        <div className="absolute -top-24 -left-24 w-48 h-48 rounded-full bg-neon-purple/5 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -right-24 w-48 h-48 rounded-full bg-vibrant-indigo/5 blur-3xl pointer-events-none" />

        <div className="relative z-10">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-heading text-lg font-semibold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-neon-purple" />
              Topic Wheel
            </h3>
            <span className="text-[10px] text-soft-gray/40 font-mono">
              {allTopics.length} topics
            </span>
          </div>

          {/* Drum / Wheel display */}
          <div className="flex gap-6">
            <div className="flex-1 space-y-1.5 mb-4">
              {visibleTopics.map((topic, idx) => {
                const isCenter = idx === 2;
                const isSelected = selectedIndex !== null &&
                  allTopics[(spinOffset + idx) % allTopics.length] === allTopics[selectedIndex];

                return (
                  <motion.div
                    key={`${spinOffset}-${idx}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{
                      opacity: isCenter ? 1 : 0.35,
                      x: 0,
                      scale: isCenter ? 1 : 0.92,
                    }}
                    transition={{ duration: 0.25 }}
                    className={`
                      px-4 py-2.5 rounded-xl text-sm transition-all duration-200
                      ${isCenter && isSelected
                        ? "bg-neon-purple/15 border border-neon-purple/30 text-white"
                        : isCenter
                        ? "bg-white/5 border border-white/10 text-white"
                        : "bg-transparent border border-transparent text-soft-gray/40"
                      }
                      ${isCenter ? "cursor-pointer" : "cursor-default"}
                    `}
                    onClick={() => {
                      if (isCenter && !isSpinning) {
                        setSelectedIndex((spinOffset + idx) % allTopics.length);
                      }
                    }}
                  >
                    <div className="flex items-center gap-2">
                      {isCenter && (
                        <div className="w-1.5 h-1.5 rounded-full bg-neon-purple/60 shrink-0" />
                      )}
                      <span className="line-clamp-1">{topic}</span>
                    </div>
                  </motion.div>
                );
              })}
            </div>

            {/* Physical Slot-Machine Lever */}
            <div className="relative flex flex-col items-center justify-end w-12 shrink-0 mb-3">
              {/* Metallic track */}
              <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-[6px] rounded-full bg-gradient-to-b from-white/10 via-white/5 to-white/10 shadow-[inset_0_2px_4px_rgba(0,0,0,0.4)]" />

              {/* Notches on the track */}
              <div className="absolute top-[15%] left-1/2 -translate-x-1/2 flex flex-col gap-3">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="w-3 h-[1px] bg-white/5 rounded-full" />
                ))}
              </div>

              {/* Lever container */}
              <motion.div
                className="relative z-10 cursor-pointer"
                onClick={spin}
                animate={isSpinning ? { rotateX: 45, y: 28 } : { rotateX: 0, y: 0 }}
                transition={{ type: "spring", stiffness: 200, damping: 15 }}
                style={{ transformStyle: "preserve-3d", transformOrigin: "bottom center" }}
              >
                {/* Metallic rod */}
                <div className="w-[6px] h-20 mx-auto bg-gradient-to-b from-soft-gray/60 via-neon-purple/60 to-soft-gray/30 rounded-full shadow-[0_0_8px_rgba(189,140,255,0.2)]" />

                {/* 3D Glowing neon-purple spherical handle */}
                <div className="relative -mt-1">
                  {/* Handle glow aura */}
                  <div className="absolute -inset-3 rounded-full bg-neon-purple/20 blur-xl animate-pulse" />
                  {/* Handle sphere */}
                  <div className="relative w-9 h-9 rounded-full bg-gradient-to-br from-neon-purple to-vibrant-indigo shadow-[0_0_20px_rgba(189,140,255,0.5),inset_0_2px_4px_rgba(255,255,255,0.3),inset_0_-2px_4px_rgba(0,0,0,0.3)] flex items-center justify-center">
                    <div className="w-5 h-5 rounded-full bg-gradient-to-br from-white/30 to-transparent" />
                  </div>
                  {/* Specular highlight */}
                  <div className="absolute top-1 left-2 w-2 h-2 rounded-full bg-white/30 blur-[1px]" />
                </div>
              </motion.div>

              {/* Label */}
              <span className="text-[8px] text-soft-gray/30 mt-2 font-mono tracking-wider select-none">
                {isSpinning ? "SPIN" : "PULL"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Confirm selected topic */}
      <AnimatePresence>
        {selectedIndex !== null && !isSpinning && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
            className="mt-4"
          >
            <div className="glass rounded-2xl p-4 border border-neon-purple/20">
              <p className="text-xs text-soft-gray/60 mb-2">Selected Topic</p>
              <p className="text-sm text-white leading-relaxed mb-3">
                {allTopics[selectedIndex]}
              </p>
              <div className="flex gap-3">
                <button
                  onClick={handleConfirm}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-primary hover:bg-primary-hover text-white text-sm font-medium py-2.5 rounded-xl transition-all duration-200 active:scale-[0.97] cursor-pointer"
                >
                  Start with This Topic
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setSelectedIndex(null)}
                  className="px-4 py-2.5 glass text-soft-gray hover:text-white text-sm rounded-xl transition-all duration-200 active:scale-[0.97] cursor-pointer"
                >
                  Spin Again
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}