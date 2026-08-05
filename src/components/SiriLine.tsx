import { useEffect, useRef } from "react";

interface SiriLineProps {
  level: number; // 0–1 normalized RMS (computed from AnalyserNode raw PCM)
  isActive: boolean;
}

/**
 * A single, horizontal Siri-style reactive line drawn on a <canvas>.
 *
 * - Connected to the microphone via the RMS `level` prop (raw PCM time-domain
 *   data from an AnalyserNode).
 * - When silent: a thin (2px) flat baseline with a gentle idle breathing pulse.
 * - When speaking: the line stretches vertically and thickens, smoothed by an
 *   exponential moving average, in sync with the live mic input.
 */
export default function SiriLine({ level, isActive }: SiriLineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef(0);
  const smoothRef = useRef(0);
  const timeRef = useRef(0);
  const levelRef = useRef(0);
  const activeRef = useRef(false);

  // Keep latest props accessible inside the rAF loop
  levelRef.current = level;
  activeRef.current = isActive;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = () => {
      timeRef.current += 0.02;
      const t = timeRef.current;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const centerY = h / 2;

      // Smooth the incoming RMS (exponential moving average)
      const target = activeRef.current ? levelRef.current : 0;
      smoothRef.current += (target - smoothRef.current) * 0.18;
      const amp = smoothRef.current;

      // Envelope: baseline 2px when silent → up to ~70% of height when loud
      const maxAmp = h * 0.32;
      const envelope = Math.min(amp * 2.4, 1);
      const amplitude = envelope * maxAmp;

      // Line thickness: 2px baseline → ~14px at peak
      const thickness = 2 + envelope * 12;

      // Idle breathing even when silent (organic Siri feel)
      const idle = 0.6 + Math.sin(t * 1.1) * 0.4;

      ctx.clearRect(0, 0, w, h);

      // Glow
      ctx.shadowColor = "rgba(168,130,255,0.9)";
      ctx.shadowBlur = 14 + envelope * 22;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = `rgba(189,140,255,${0.55 + envelope * 0.45})`;
      ctx.lineWidth = thickness;

      // Single continuous Siri-style line: sum of harmonics, envelope-scaled
      const steps = Math.max(64, Math.floor(w / 3));
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * w;
        const p = (i / steps) * Math.PI * 2;

        // Base organic shape (harmonics)
        const shape =
          Math.sin(p * 1.0 + t * 1.4) * 0.5 +
          Math.sin(p * 2.3 - t * 1.1) * 0.3 +
          Math.sin(p * 3.7 + t * 0.7) * 0.2;

        // Micro-jitter reacts to real audio; idle breathing keeps it alive
        const jitter = activeRef.current ? (levelRef.current - smoothRef.current) * 6 : 0;
        const y = centerY + shape * amplitude * idle + jitter * 2;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-20 md:h-24"
      style={{ filter: "drop-shadow(0 0 8px rgba(189,140,255,0.15))" }}
      aria-hidden="true"
    />
  );
}
