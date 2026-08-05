import { useEffect, useRef } from "react";

interface ReactiveWaveformProps {
  /** Returns the live AnalyserNode (or null while the mic is inactive). */
  getAnalyser: () => AnalyserNode | null;
  isActive: boolean;
  className?: string;
}

/**
 * Live audio visualizer — draws a continuous horizontal line on a <canvas>,
 * fed by the Web Audio AnalyserNode. RMS is read each animation frame and
 * exponentially smoothed; the line's thickness and Y-axis curve height scale
 * with that amplitude, so it stretches while the user speaks and collapses
 * to a flat baseline when silent.
 */
export default function ReactiveWaveform({
  getAnalyser,
  isActive,
  className,
}: ReactiveWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const smoothRef = useRef(0);

  useEffect(() => {
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

    const draw = (time: number) => {
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

      // 2. Exponential smoothing → 0–1 amplitude
      smoothRef.current = smoothRef.current * 0.82 + rms * 0.18;
      const amp = Math.min(smoothRef.current * 2.6, 1);

      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Faint baseline — the line always rests here when silent
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(w, midY);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // 3. Wave path — curve height and thickness scale with amp
      const segments = 72;
      const waveAmp = h * 0.22 * amp;
      const thickness = 1 + amp * 5;
      const phase = time * 0.002;

      const waveY = (i: number) => {
        const t = (i / segments) * Math.PI * 2;
        return (
          midY +
          Math.sin(t + phase) * waveAmp * 0.55 +
          Math.sin(t * 2.3 + phase * 1.7) * waveAmp * 0.45
        );
      };

      ctx.beginPath();
      for (let i = 0; i <= segments; i++) {
        const x = (i / segments) * w;
        const y = waveY(i);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      const grad = ctx.createLinearGradient(
        0,
        midY - waveAmp - thickness,
        0,
        midY + waveAmp + thickness
      );
      grad.addColorStop(0, "rgba(109,86,255,0)");
      grad.addColorStop(0.5, "#BD8CFF");
      grad.addColorStop(1, "rgba(109,86,255,0)");

      ctx.strokeStyle = grad;
      ctx.lineWidth = thickness;
      ctx.shadowColor = `rgba(189,140,255,${0.25 + amp * 0.6})`;
      ctx.shadowBlur = 4 + amp * 18;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 4. Soft fill under the curve
      if (amp > 0.02) {
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
        ctx.fillStyle = `rgba(109,86,255,${0.05 + amp * 0.12})`;
        ctx.fill();
      }
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
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
