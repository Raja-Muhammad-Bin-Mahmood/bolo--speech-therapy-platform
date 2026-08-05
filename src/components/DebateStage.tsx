import { useRef, useEffect, useCallback } from "react";

// ─── Types ───────────────────────────────────────────────────────────────

interface DebateStageProps {
  isSpeaking: boolean;
  isAIResponding: boolean;
  turn: number;
}

// ─── Constants ───────────────────────────────────────────────────────────

const AUDIENCE_COLORS = [
  "#6D56FF",
  "#BD8CFF",
  "#AE72FF",
  "#4A1FB8",
  "#9B6BFF",
  "#7A6B9B",
];

const CAMERA_FLASH_INTERVAL_MS = 3000;
const CAMERA_FLASH_DURATION_MS = 120;
const IDLE_SWAY_AMPLITUDE = 6;
const IDLE_SWAY_SPEED = 0.06;

// ─── Component ──────────────────────────────────────────────────────────

export default function DebateStage({
  isSpeaking,
  isAIResponding,
  turn,
}: DebateStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);
  const timeRef = useRef(0);
  const lastFlashRef = useRef(0);
  const pressFlashesRef = useRef<{ x: number; y: number; timer: number }[]>(
    []
  );

  // ─── Resize handler ────────────────────────────────────────────────

  const resize = useCallback(() => {
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
  }, []);

  useEffect(() => {
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  // ─── Main render loop ──────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;

    function render(timestamp: number) {
      if (!running) return;
      if (!canvas || !ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const w = canvas!.width / dpr;
      const h = canvas!.height / dpr;
      const dt = timeRef.current > 0 ? (timestamp - timeRef.current) / 1000 : 0.016;
      timeRef.current = timestamp;

      ctx.clearRect(0, 0, w, h);

      // ─── Idle camera sway (subtle sine wave) ──────────────────
      const swayX = Math.sin(timestamp * IDLE_SWAY_SPEED * 0.001) * IDLE_SWAY_AMPLITUDE;
      const swayY = Math.sin(timestamp * IDLE_SWAY_SPEED * 0.001 * 0.7) * IDLE_SWAY_AMPLITUDE * 0.4;
      const swayRot = Math.sin(timestamp * IDLE_SWAY_SPEED * 0.001 * 0.5) * 0.002;

      ctx.save();
      ctx.translate(swayX + w / 2, swayY + h / 2);
      ctx.rotate(swayRot);
      ctx.translate(-w / 2, -h / 2);

      // ─── Background (deep space) ─────────────────────────────
      const bgGrad = ctx.createRadialGradient(w * 0.5, h * 0.3, 0, w * 0.5, h * 0.3, Math.max(w, h) * 0.7);
      bgGrad.addColorStop(0, "#121026");
      bgGrad.addColorStop(0.4, "#0B0A1F");
      bgGrad.addColorStop(1, "#060515");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(-w, -h, w * 3, h * 3);

      // ─── Stage floor (perspective trapezoid) ─────────────────
      ctx.beginPath();
      ctx.moveTo(w * 0.1, h * 0.72);
      ctx.lineTo(w * 0.9, h * 0.72);
      ctx.lineTo(w * 0.75, h);
      ctx.lineTo(w * 0.25, h);
      ctx.closePath();
      const floorGrad = ctx.createLinearGradient(0, h * 0.72, 0, h);
      floorGrad.addColorStop(0, "rgba(109, 86, 255, 0.06)");
      floorGrad.addColorStop(0.5, "rgba(18, 16, 38, 0.3)");
      floorGrad.addColorStop(1, "rgba(6, 5, 21, 0.6)");
      ctx.fillStyle = floorGrad;
      ctx.fill();
      ctx.strokeStyle = "rgba(189, 140, 255, 0.08)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Stage floor grid lines
      ctx.strokeStyle = "rgba(189, 140, 255, 0.04)";
      ctx.lineWidth = 0.5;
      for (let i = 0; i < 10; i++) {
        const t = i / 10;
        const x1 = w * 0.1 + t * (w * 0.8);
        const x2 = w * 0.25 + t * (w * 0.5);
        const y1 = h * 0.72;
        const y2 = h;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      // ─── Left: Audience / press gallery (20% view) ───────────
      drawAudience(ctx, w, h, timestamp);

      // ─── Camera flashes from press ───────────────────────────
      if (timestamp - lastFlashRef.current > CAMERA_FLASH_INTERVAL_MS + Math.random() * 2000) {
        lastFlashRef.current = timestamp;
        pressFlashesRef.current.push({
          x: w * 0.05 + Math.random() * w * 0.15,
          y: h * 0.35 + Math.random() * h * 0.15,
          timer: 0,
        });
      }

      pressFlashesRef.current = pressFlashesRef.current.filter((f) => {
        f.timer += dt * 1000;
        const progress = f.timer / CAMERA_FLASH_DURATION_MS;
        if (progress >= 1) return false;

        const alpha = progress < 0.3 ? progress / 0.3 : 1 - (progress - 0.3) / 0.7;
        const radius = 4 + progress * 30;

        // Flash burst
        const flashGrad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, radius);
        flashGrad.addColorStop(0, `rgba(255, 255, 255, ${alpha * 0.9})`);
        flashGrad.addColorStop(0.3, `rgba(255, 255, 255, ${alpha * 0.3})`);
        flashGrad.addColorStop(1, `rgba(255, 255, 255, 0)`);
        ctx.fillStyle = flashGrad;
        ctx.beginPath();
        ctx.arc(f.x, f.y, radius, 0, Math.PI * 2);
        ctx.fill();

        // Hard light flash on the scene
        if (progress < 0.3) {
          ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.06})`;
          ctx.fillRect(0, 0, w, h);
        }

        return true;
      });

      // ─── Central stage area ──────────────────────────────────
      drawCentralStage(ctx, w, h, timestamp);

      // ─── AI Debater (80% view — right side) ──────────────────
      drawAIDebater(ctx, w, h, timestamp, isAIResponding);

      // ─── User podium (bottom center, translucent glass) ──────
      drawUserPodium(ctx, w, h, timestamp, isSpeaking);

      // ─── A vibe glow beneath everything ──────────────────────
      const ambientGrad = ctx.createRadialGradient(w * 0.6, h * 0.3, 0, w * 0.6, h * 0.3, w * 0.6);
      ambientGrad.addColorStop(0, "rgba(189, 140, 255, 0.03)");
      ambientGrad.addColorStop(0.5, "rgba(109, 86, 255, 0.02)");
      ambientGrad.addColorStop(1, "transparent");
      ctx.fillStyle = ambientGrad;
      ctx.fillRect(0, 0, w, h);

      ctx.restore();

      animFrameRef.current = requestAnimationFrame(render);
    }

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      running = false;
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [isSpeaking, isAIResponding, turn]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full overflow-hidden"
      style={{ perspective: "1200px" }}
    >
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ transform: "rotateX(2deg)", transformOrigin: "bottom center" }}
      />
    </div>
  );
}

// ─── Drawing Functions ───────────────────────────────────────────────────

function drawAudience(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  timestamp: number
) {
  const seatCount = 14;
  const rows = 4;

  for (let row = 0; row < rows; row++) {
    const seatsInRow = seatCount - row * 2;
    const rowY = h * 0.22 + row * (h * 0.065);
    const rowWidth = w * 0.18 - row * (w * 0.01);
    const startX = w * 0.01 + row * (w * 0.005);
    const seatW = rowWidth / Math.max(seatsInRow - 1, 1);

    for (let s = 0; s < seatsInRow; s++) {
      const seatX = startX + s * seatW;
      const seatY =
        rowY + Math.sin(timestamp * 0.001 * 0.5 + s * 1.3 + row * 0.7) * 2;

      // Egg-like body
      const eggW = 6 + (1 - row / rows) * 4;
      const eggH = 8 + (1 - row / rows) * 5;

      ctx.save();
      ctx.translate(seatX, seatY);
      ctx.scale(eggW / 6, eggH / 8);

      // Body (egg shape)
      ctx.beginPath();
      ctx.ellipse(0, 1, 6, 8, 0, 0, Math.PI * 2);

      const colorIdx = (s + row * 3) % AUDIENCE_COLORS.length;
      const baseColor = AUDIENCE_COLORS[colorIdx];
      ctx.fillStyle = baseColor;
      ctx.globalAlpha = 0.15 + row * 0.03;
      ctx.fill();

      // Glow ring
      ctx.strokeStyle = baseColor;
      ctx.globalAlpha = 0.1 + row * 0.02;
      ctx.lineWidth = 0.8;
      ctx.stroke();

      // Eye highlight
      ctx.beginPath();
      ctx.arc(-1.5, -1, 0.8, 0, Math.PI * 2);
      ctx.arc(1.5, -1, 0.8, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
      ctx.fill();

      ctx.restore();
    }
  }
}

function drawCentralStage(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  _timestamp: number
) {
  // Central stage marker/glow
  const cx = w * 0.55;
  const cy = h * 0.52;

  const stageGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.3);
  stageGrad.addColorStop(0, "rgba(189, 140, 255, 0.04)");
  stageGrad.addColorStop(0.5, "rgba(109, 86, 255, 0.02)");
  stageGrad.addColorStop(1, "transparent");
  ctx.fillStyle = stageGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, w * 0.3, 0, Math.PI * 2);
  ctx.fill();
}

function drawAIDebater(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  timestamp: number,
  isAIResponding: boolean
) {
  // AI podium position (right side, facing left toward user)
  const podiumX = w * 0.72;
  const podiumY = h * 0.58;

  // ─── AI's glass podium ─────────────────────────────────────
  const podiumW = w * 0.12;
  const podiumH = h * 0.14;

  // Main body
  ctx.beginPath();
  ctx.roundRect(podiumX - podiumW / 2, podiumY - podiumH / 2, podiumW, podiumH * 0.6, 3);
  ctx.fillStyle = "rgba(189, 140, 255, 0.06)";
  ctx.fill();
  ctx.strokeStyle = "rgba(189, 140, 255, 0.15)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Podium top surface
  ctx.beginPath();
  ctx.roundRect(podiumX - podiumW / 2 - 3, podiumY - podiumH / 2 - 2, podiumW + 6, 6, 2);
  ctx.fillStyle = "rgba(189, 140, 255, 0.08)";
  ctx.fill();
  ctx.strokeStyle = "rgba(189, 140, 255, 0.2)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // ─── Suited body ───────────────────────────────────────────
  const bodyX = podiumX;
  const bodyTop = podiumY - podiumH / 2 - h * 0.2 + 8;
  const bodyBottom = podiumY - podiumH / 2 + 4;
  const bodyW = podiumW * 0.65;

  // Torso
  ctx.beginPath();
  ctx.moveTo(bodyX - bodyW / 2, bodyBottom);
  ctx.quadraticCurveTo(bodyX - bodyW / 2 - 4, bodyTop + (bodyBottom - bodyTop) * 0.3, bodyX - bodyW * 0.35, bodyTop);
  ctx.quadraticCurveTo(bodyX, bodyTop - 4, bodyX + bodyW * 0.35, bodyTop);
  ctx.quadraticCurveTo(bodyX + bodyW / 2 + 4, bodyTop + (bodyBottom - bodyTop) * 0.3, bodyX + bodyW / 2, bodyBottom);
  ctx.closePath();
  ctx.fillStyle = "rgba(15, 12, 30, 0.9)";
  ctx.fill();
  ctx.strokeStyle = "rgba(189, 140, 255, 0.08)";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Shoulders
  ctx.beginPath();
  ctx.moveTo(bodyX - bodyW * 0.8, bodyTop + (bodyBottom - bodyTop) * 0.15);
  ctx.quadraticCurveTo(bodyX - bodyW * 0.5, bodyTop - 2, bodyX, bodyTop - 2);
  ctx.quadraticCurveTo(bodyX + bodyW * 0.5, bodyTop - 2, bodyX + bodyW * 0.8, bodyTop + (bodyBottom - bodyTop) * 0.15);
  ctx.strokeStyle = "rgba(30, 26, 50, 0.9)";
  ctx.lineWidth = 6;
  ctx.stroke();

  // ─── AI Orb head (voice-reactive) ──────────────────────────
  const orbX = bodyX;
  const orbY = bodyTop - h * 0.01;

  // Glow aura (expands when speaking)
  const pulseBase = isAIResponding ? 1 : 0.7;
  const pulse = pulseBase + Math.sin(timestamp * 0.004) * 0.08 * (isAIResponding ? 1 : 0.4);
  const orbRadius = (h * 0.045) * pulse;

  // Outer glow layers
  for (let i = 3; i >= 0; i--) {
    const r = orbRadius * (1 + i * 0.4);
    const alpha = isAIResponding ? 0.08 - i * 0.015 : 0.04 - i * 0.008;
    if (alpha <= 0) continue;
    const glowGrad = ctx.createRadialGradient(orbX, orbY, 0, orbX, orbY, r);
    glowGrad.addColorStop(0, `rgba(189, 140, 255, ${alpha * 2})`);
    glowGrad.addColorStop(0.5, `rgba(109, 86, 255, ${alpha})`);
    glowGrad.addColorStop(1, "transparent");
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(orbX, orbY, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Main orb body
  const orbGrad = ctx.createRadialGradient(
    orbX - orbRadius * 0.25,
    orbY - orbRadius * 0.25,
    0,
    orbX,
    orbY,
    orbRadius
  );
  orbGrad.addColorStop(0, "#D4BFFF");
  orbGrad.addColorStop(0.3, "#BD8CFF");
  orbGrad.addColorStop(0.7, "#6D56FF");
  orbGrad.addColorStop(1, "#4A1FB8");
  ctx.fillStyle = orbGrad;
  ctx.beginPath();
  ctx.arc(orbX, orbY, orbRadius, 0, Math.PI * 2);
  ctx.fill();

  // Inner brightness distortion (simulating dynamic energy)
  const distortionRadius = orbRadius * (0.4 + Math.sin(timestamp * 0.006) * 0.15);
  const innerGrad = ctx.createRadialGradient(
    orbX - orbRadius * 0.1,
    orbY - orbRadius * 0.15,
    0,
    orbX,
    orbY,
    distortionRadius
  );
  innerGrad.addColorStop(0, "rgba(255, 255, 255, 0.5)");
  innerGrad.addColorStop(0.5, "rgba(212, 191, 255, 0.2)");
  innerGrad.addColorStop(1, "transparent");
  ctx.fillStyle = innerGrad;
  ctx.beginPath();
  ctx.arc(orbX, orbY, distortionRadius, 0, Math.PI * 2);
  ctx.fill();

  // Orb rim light
  ctx.beginPath();
  ctx.arc(orbX, orbY, orbRadius, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(189, 140, 255, ${isAIResponding ? 0.6 : 0.25})`;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawUserPodium(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  timestamp: number,
  isSpeaking: boolean
) {
  // Positioned at bottom center, in front of the camera
  const px = w * 0.4;
  const py = h * 0.82;
  const pw = w * 0.14;
  const ph = h * 0.1;

  // Glass podium body
  ctx.beginPath();
  ctx.roundRect(px - pw / 2, py - ph / 2, pw, ph, 4);
  ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
  ctx.fill();

  // Chrome border
  ctx.strokeStyle = "rgba(189, 140, 255, 0.15)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Top surface highlight
  ctx.beginPath();
  ctx.roundRect(px - pw / 2 - 2, py - ph / 2 - 2, pw + 4, 5, 2);
  ctx.fillStyle = "rgba(189, 140, 255, 0.06)";
  ctx.fill();
  ctx.strokeStyle = "rgba(189, 140, 255, 0.2)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Mic glow indicator (top of podium)
  if (isSpeaking) {
    const micPulse = 0.5 + Math.sin(timestamp * 0.005) * 0.3;
    const micGrad = ctx.createRadialGradient(px, py - ph / 2 - 4, 0, px, py - ph / 2 - 4, 8 + micPulse * 6);
    micGrad.addColorStop(0, `rgba(189, 140, 255, ${0.3 * micPulse})`);
    micGrad.addColorStop(1, "transparent");
    ctx.fillStyle = micGrad;
    ctx.beginPath();
    ctx.arc(px, py - ph / 2 - 4, 8 + micPulse * 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Subtle reflection on podium surface
  ctx.beginPath();
  ctx.roundRect(px - pw / 2 + 6, py - ph / 2 + 5, pw * 0.3, ph * 0.3, 2);
  ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
  ctx.fill();
}