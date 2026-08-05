import { useMemo } from "react";

const GRAIN_COUNT = 120;

export default function Background() {
  const particles = useMemo(() => {
    return Array.from({ length: GRAIN_COUNT }, (_, i) => {
      const size = Math.random() * 3 + 1;
      const delay = Math.random() * 15;
      const duration = Math.random() * 20 + 15;
      const left = Math.random() * 100;
      const top = Math.random() * 100;
      const opacity = Math.random() * 0.15 + 0.02;

      return { size, delay, duration, left, top, opacity, i };
    });
  }, []);

  return (
    <div className="fixed inset-0 pointer-events-none z-0">
      {/* Base deep-space void */}
      <div className="absolute inset-0 bg-deep-space" />

      {/* Cloth gradient overlay */}
      <div className="absolute inset-0 bg-cloth-gradient opacity-90" />

      {/* Ambient AI Orb — organic breathing animation */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px]">
        <div
          className="w-full h-full rounded-full animate-orb-breathe"
          style={{
            background:
              "radial-gradient(circle at center, rgba(189,140,255,0.3) 0%, rgba(109,86,255,0.2) 30%, rgba(74,31,184,0.1) 60%, transparent 80%)",
          }}
        />
      </div>

      {/* Second smaller orb offset */}
      <div className="absolute top-1/3 left-2/3 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px]">
        <div
          className="w-full h-full rounded-full animate-float"
          style={{
            background:
              "radial-gradient(circle at center, rgba(174,114,255,0.15) 0%, rgba(109,86,255,0.08) 40%, transparent 70%)",
          }}
        />
      </div>

      {/* Floating grain particles */}
      {particles.map((p) => (
        <div
          key={p.i}
          className="grain-particle"
          style={{
            width: `${p.size}px`,
            height: `${p.size}px`,
            left: `${p.left}%`,
            top: `${p.top}%`,
            opacity: p.opacity,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
          }}
        />
      ))}
    </div>
  );
}