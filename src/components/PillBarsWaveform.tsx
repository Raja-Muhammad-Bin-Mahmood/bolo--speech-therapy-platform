import { useEffect, useRef } from "react";

interface PillBarsWaveformProps {
  /** Returns the live AnalyserNode (or null while the mic is inactive). */
  getAnalyser: () => AnalyserNode | null;
  isActive: boolean;
  className?: string;
}

/**
 * PillBarsWaveform — a calm, voice-reactive equalizer made of rounded
 * vertical bars for the practice screen.
 *
 * Not a random zig-zag and not a busy spectrum: the bars rest as faint
 * center stubs when silent, then swell smoothly with the real mic RMS.
 * Amplitude is exponentially smoothed (never snaps), a soft center-weighted
 * envelope keeps the middle slightly taller so it reads as a waveform, and
 * the per-bar drift is slow enough to feel calm. Rendered on a single
 * canvas rAF loop — no React re-renders, no dropped frames.
 */
export default function PillBarsWaveform({
  getAnalyser,
  isActive,
  className,
}: PillBarsWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  const smoothRef = useRef(0);
  const reducedRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedRef.current = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      reducedRef.current = e.matches;
    };
    mq.addEventListener?.("change", onChange);

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let w = 0;
    let h = 0;

    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let dataBuf: Float32Array | null = null;

    const draw = (now: number) => {
      rafRef.current = requestAnimationFrame(draw);
      if (w === 0 || h === 0) return;

      // 1. Read real-time RMS from the AnalyserNode
      let rms = 0;
      const analyser = getAnalyser();
      if (analyser && isActive) {
        if (!dataBuf || dataBuf.length !== analyser.fftSize) {
          dataBuf = new Float32Array(analyser.fftSize);
        }
        analyser.getFloatTimeDomainData(dataBuf as Float32Array<ArrayBuffer>);
        let sum = 0;
        for (let i = 0; i < dataBuf.length; i++) {
          sum += dataBuf[i] * dataBuf[i];
        }
        rms = Math.sqrt(sum / dataBuf.length);
      }

      // 2. Heavily smoothed amplitude → 0–1
      const target = Math.min(rms * 3.2, 1);
      smoothRef.current += (target - smoothRef.current) * 0.16;
      const amp = smoothRef.current;

      ctx.clearRect(0, 0, w, h);

      const bars = Math.max(16, Math.min(48, Math.round(w / 16)));
      const gap = Math.max(2, w * 0.012);
      const bw = (w - gap * (bars - 1)) / bars;
      const midY = h / 2;
      const minH = Math.max(2.5, h * 0.025);
      const maxH = h * 0.44;
      const reduced = reducedRef.current;

      // Faint center baseline — bars always rest here when silent
      ctx.fillStyle = "rgba(255,255,255,0.05)";
      ctx.fillRect(0, midY - 0.5, w, 1);

      const grad = ctx.createLinearGradient(0, midY - maxH, 0, midY + maxH);
      grad.addColorStop(0, "rgba(109,86,255,0.95)");
      grad.addColorStop(0.5, "#BD8CFF");
      grad.addColorStop(1, "rgba(109,86,255,0.95)");

      ctx.globalAlpha = 0.25 + amp * 0.75;
      ctx.shadowColor = `rgba(189,140,255,${0.12 + amp * 0.45})`;
      ctx.shadowBlur = reduced ? 0 : 8 + amp * 12;
      ctx.fillStyle = grad;

      // 3. Vertical pill bars — center-weighted, slow organic drift
      for (let i = 0; i < bars; i++) {
        const t = bars === 1 ? 0.5 : i / (bars - 1);
        const centerEnv = 0.5 + 0.5 * Math.sin(Math.PI * t);
        const wobble = reduced ? 0 : 0.055 * Math.sin(now * 0.0016 + i * 0.62);
        const factor = Math.max(0.12, centerEnv + wobble);
        const barH = minH + amp * maxH * factor;
        const x = i * (bw + gap);
        const y = midY - barH / 2;
        const radius = Math.min(bw / 2, 6);

        if (typeof (ctx as any).roundRect === "function") {
          ctx.beginPath();
          (ctx as any).roundRect(x, y, bw, barH, radius);
          ctx.fill();
        } else {
          ctx.fillRect(x, y, bw, barH);
        }
      }

      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      mq.removeEventListener?.("change", onChange);
    };
  }, [getAnalyser, isActive]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="Live microphone level"
      className={className ?? "w-full h-20"}
    />
  );
}
