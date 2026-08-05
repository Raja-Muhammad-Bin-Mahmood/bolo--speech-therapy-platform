import { useRef, useEffect, useState } from "react";

interface ScriptWaveformProps {
  /** Whether the visualizer should be capturing audio and animating */
  active: boolean;
}

export default function ScriptWaveform({ active }: ScriptWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [micDenied, setMicDenied] = useState(false);

  // Resize canvas to container
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.scale(dpr, dpr);
    };

    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // Start / stop mic based on active prop
  useEffect(() => {
    setMicDenied(false);
    if (active) {
      startMic();
    } else {
      stopMic();
      drawStandby();
    }
    return () => stopMic();
  }, [active]);

  function startMic() {
    if (!canvasRef.current) return;
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true } })
      .then((stream) => {
        streamRef.current = stream;
        const audioCtx = new AudioContext();
        audioCtxRef.current = audioCtx;

        const source = audioCtx.createMediaStreamSource(stream);
        sourceRef.current = source;

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024; // Lower → less latency
        analyser.smoothingTimeConstant = 0.8; // Responsive but still smooth
        source.connect(analyser);
        analyserRef.current = analyser;

        draw();
      })
      .catch(() => {
        setMicDenied(true);
        drawStandby();
      });
  }

  function stopMic() {
    cancelAnimationFrame(animFrameRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    sourceRef.current = null;
  }

  function drawStandby() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.clearRect(0, 0, w, h);
    const centerY = h / 2;

    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "transparent");
    grad.addColorStop(0.15, "rgba(189, 140, 255, 0.08)");
    grad.addColorStop(0.5, "rgba(189, 140, 255, 0.15)");
    grad.addColorStop(0.85, "rgba(189, 140, 255, 0.08)");
    grad.addColorStop(1, "transparent");

    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(w, centerY);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function draw() {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;

    const ctx = canvas.getContext("2d")!;
    // No null check needed — ctx is non-null here because we checked canvas above.

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const AMPLITUDE = 0.38; // fraction of height for wave swing

    function render() {
      analyser!.getByteTimeDomainData(dataArray);

      ctx.clearRect(0, 0, w, h);

      // ─── Compute overall energy ──────────────────────────────────
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < bufferLength; i++) {
        const deviation = Math.abs(dataArray[i] - 128);
        sum += deviation;
        if (deviation > peak) peak = deviation;
      }
      const avgEnergy = sum / bufferLength / 128; // 0..1
      const energy = Math.min(1, avgEnergy * 3);

      // ─── Down-sample to ~150 evenly-spaced points ────────────────
      const step = Math.max(1, Math.floor(bufferLength / 150));
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < bufferLength; i += step) {
        const x = (i / bufferLength) * w;
        const norm = (dataArray[i] - 128) / 128; // -1..1
        const y = norm * (h * AMPLITUDE) + h / 2;
        pts.push({ x, y });
      }
      // Always include last point
      const lastIdx = bufferLength - 1;
      const lastNorm = (dataArray[lastIdx] - 128) / 128;
      pts.push({
        x: w,
        y: lastNorm * (h * AMPLITUDE) + h / 2,
      });

      const n = pts.length;
      if (n < 2) {
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      // Helper: smoothed control points (Catmull-Rom tension 0.5)
      const cp = (i: number) => {
        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[Math.min(n - 1, i + 1)];
        const p3 = pts[Math.min(n - 1, i + 2)];
        const cp1x = (p1.x + p2.x) / 2;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = (p1.x + p2.x) / 2;
        const cp2y = p2.y - (p3.y - p1.y) / 6;
        return { cp1x, cp1y, cp2x, cp2y, ex: p2.x, ey: p2.y };
      };

      // ─── 1. Outer glow — thick blurred stroke ──────────────────
      ctx.save();
      ctx.filter = `blur(${6 + energy * 10}px)`;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 0; i < n - 1; i++) {
        const { cp1x, cp1y, cp2x, cp2y, ex, ey } = cp(i);
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ex, ey);
      }
      ctx.strokeStyle = `rgba(130, 90, 255, ${0.1 + energy * 0.2})`;
      ctx.lineWidth = 12 + energy * 8;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();

      // ─── 2. Main smooth bezier waveform line ───────────────────
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 0; i < n - 1; i++) {
        const { cp1x, cp1y, cp2x, cp2y, ex, ey } = cp(i);
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ex, ey);
      }

      const lineGrad = ctx.createLinearGradient(0, 0, w, 0);
      lineGrad.addColorStop(0, "transparent");
      lineGrad.addColorStop(0.08, `rgba(189, 140, 255, 0.2)`);
      lineGrad.addColorStop(0.2, `rgba(189, 140, 255, ${0.5 + energy * 0.4})`);
      lineGrad.addColorStop(0.5, `rgba(160, 120, 255, ${0.7 + energy * 0.3})`);
      lineGrad.addColorStop(0.8, `rgba(189, 140, 255, ${0.5 + energy * 0.4})`);
      lineGrad.addColorStop(0.92, `rgba(189, 140, 255, 0.2)`);
      lineGrad.addColorStop(1, "transparent");

      ctx.strokeStyle = lineGrad;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();

      // ─── 3. Mirror fill beneath ────────────────────────────────
      if (energy > 0.02) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 0; i < n - 1; i++) {
          const { cp1x, cp1y, cp2x, cp2y, ex, ey } = cp(i);
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ex, ey);
        }
        ctx.lineTo(w, h / 2);
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.lineTo(0, h / 2);
        ctx.closePath();

        const fillGrad = ctx.createLinearGradient(0, h / 2, 0, h);
        fillGrad.addColorStop(0, `rgba(109, 86, 255, ${0.12 * energy})`);
        fillGrad.addColorStop(0.25, `rgba(109, 86, 255, ${0.05 * energy})`);
        fillGrad.addColorStop(1, "transparent");
        ctx.fillStyle = fillGrad;
        ctx.fill();
        ctx.restore();
      }

      // ─── 4. Energy-responsive particles at peaks ───────────────
      if (energy > 0.15) {
        ctx.save();
        for (let i = 1; i < pts.length - 1; i++) {
          const amp = Math.abs(pts[i].y - h / 2) / (h * AMPLITUDE);
          if (amp > 0.6 && pts[i].y < h / 2) {
            const alpha = (amp - 0.6) * 2 * energy;
            ctx.beginPath();
            ctx.arc(pts[i].x, pts[i].y - 2, 1 + amp * 2, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(189, 140, 255, ${Math.min(0.5, alpha)})`;
            ctx.fill();
          }
        }
        ctx.restore();
      }

      animFrameRef.current = requestAnimationFrame(render);
    }

    render();
  }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ width: "100%", height: "100%" }}
      />
      {micDenied && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[10px] text-red-400/50 bg-black/30 px-2 py-1 rounded-full">
            Mic access denied
          </span>
        </div>
      )}
    </div>
  );
}