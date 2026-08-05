import { useEffect, useRef } from "react";

interface ReactiveWaveformProps {
  /** Returns the live AnalyserNode (or null while the mic is inactive). */
  getAnalyser: () => AnalyserNode | null;
  isActive: boolean;
  className?: string;
}

/**
 * Subtle live audio visualizer — a single smooth line on a <canvas>.
 *
 * Not a random zig-zag and not a busy spectrum: the curve rests on a faint
 * baseline when silent, then rises into a gentle, slowly-breathing wave whose
 * height tracks the real mic RMS. Amplitude is exponentially smoothed so it
 * never snaps, and the phase drift is slow enough to feel calm.
 */
export default function ReactiveWaveform({
  getAnalyser,
  isActive,
  className,
}: ReactiveWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const smoothRef = useRef(0);
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      reducedMotionRef.current = e.matches;
    };
    mq.addEventListener?.("change", onChange);

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let dataBuf: Float32Array | null = null;

    const draw = (now: number) => {
      rafRef.current = requestAnimationFrame(draw);

      const w = canvas.width;
      const h = canvas.height;
      const midY = h / 2;

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
      const target = Math.min(rms * 3.4, 1);
      smoothRef.current += (target - smoothRef.current) * 0.14;
      const amp = smoothRef.current;

      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Faint baseline — the line always rests here when silent
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(w, midY);
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Silent → nothing but the baseline (no fake motion)
      if (amp < 0.004) return;

      // 3. One smooth wave — height scales with voice, drift is slow and gentle
      const reduced = reducedMotionRef.current;
      const drift = reduced ? 0 : now * 0.00028;
      const maxAmp = h * 0.16 * amp;
      const segments = 128;
      const envelope = (t: number) =>
        Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t))), 0.75);

      const waveY = (i: number) => {
        const t = i / segments;
        const base =
          Math.sin(t * Math.PI * 2 * 1.5 + drift) * 0.55 +
          Math.sin(t * Math.PI * 4 + drift * 1.4) * 0.25 +
          Math.sin(t * Math.PI * 6 + drift * 2.1) * 0.2;
        return midY + base * maxAmp * envelope(t);
      };

      ctx.beginPath();
      for (let i = 0; i <= segments; i++) {
        const x = (i / segments) * w;
        const y = waveY(i);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      const grad = ctx.createLinearGradient(0, midY - maxAmp, 0, midY + maxAmp);
      grad.addColorStop(0, "rgba(109,86,255,0)");
      grad.addColorStop(0.5, "#BD8CFF");
      grad.addColorStop(1, "rgba(109,86,255,0)");

      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5 + amp * 2;
      ctx.shadowColor = `rgba(189,140,255,${0.12 + amp * 0.4})`;
      ctx.shadowBlur = 6 + amp * 10;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 4. Whisper-soft fill under the curve
      ctx.beginPath();
      for (let i = 0; i <= segments; i++) {
        const x = (i / segments) * w;
        const y = waveY(i);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineTo(w, midY);
      ctx.lineTo(0, midY);
      ctx.closePath();
      ctx.fillStyle = `rgba(109,86,255,${0.03 + amp * 0.05})`;
      ctx.fill();
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
      className={className ?? "w-full h-24"}
    />
  );
}
