import { prefersReducedMotion } from './motion';

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  spin: number;
  angle: number;
  /** Drives the flutter: each piece turns over as it falls, so it flashes thin and wide. */
  wobble: number;
  wobbleSpeed: number;
  round: boolean;
};

export type Burst = {
  /** Where it comes from, as fractions of the viewport. */
  x: number;
  y: number;
  count: number;
  /** Degrees from straight up; 0 fires straight up. */
  angle?: number;
  spread?: number;
  speed?: number;
};

const COLORS = ['#35d39a', '#f0b542', '#ef6b6b', '#5aa9f0', '#c58af5', '#eef4fa'];
/**
 * px/s², and air resistance per second: together they cap the fall at 250px/s, so pieces hang in
 * the air and drift down rather than dropping like stones.
 */
const GRAVITY = 600;
const DRAG = 2.4;

/**
 * Fires confetti over the whole page from one or more bursts, then tidies itself away. A single
 * canvas on top of everything, ignoring touches. Nothing at all with reduced motion.
 */
export function confetti(bursts: Burst[], { durationMs = 3_200 }: { durationMs?: number } = {}): () => void {
  if (prefersReducedMotion()) return () => {};

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:950';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return () => {};
  }

  // Capped at 2x: a 3x phone would be pushing 9x the pixels for no visible gain.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.scale(dpr, dpr);

  const particles: Particle[] = bursts.flatMap((burst) =>
    Array.from({ length: burst.count }, () => {
      const spread = burst.spread ?? 70;
      const direction = (((burst.angle ?? 0) + (Math.random() - 0.5) * spread) * Math.PI) / 180;
      const speed = (burst.speed ?? 900) * (0.55 + Math.random() * 0.6);
      return {
        x: burst.x * width,
        y: burst.y * height,
        vx: Math.sin(direction) * speed,
        vy: -Math.cos(direction) * speed,
        size: 6 + Math.random() * 6,
        color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
        spin: (Math.random() - 0.5) * 12,
        angle: Math.random() * Math.PI,
        wobble: Math.random() * Math.PI * 2,
        wobbleSpeed: 6 + Math.random() * 8,
        round: Math.random() < 0.25,
      };
    }),
  );

  let frame = 0;
  let last = performance.now();
  const began = last;
  const stop = () => {
    cancelAnimationFrame(frame);
    canvas.remove();
  };

  const draw = (now: number) => {
    // Clamped so a throttled background tab doesn't teleport everything off screen at once.
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const age = now - began;
    const fade = Math.min(1, Math.max(0, (durationMs - age) / 600));

    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = fade;
    let alive = 0;
    for (const p of particles) {
      p.vx -= p.vx * DRAG * dt;
      p.vy += GRAVITY * dt - p.vy * DRAG * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.angle += p.spin * dt;
      p.wobble += p.wobbleSpeed * dt;
      if (p.y > height + 20) continue;
      alive++;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.scale(1, Math.cos(p.wobble));
      ctx.fillStyle = p.color;
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2.6, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      }
      ctx.restore();
    }

    if (alive === 0 || age >= durationMs) stop();
    else frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);

  return stop;
}
