import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Checked at the moment of animating, so changing the OS setting mid-game takes effect. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** Counts from `from` up to `to` once `delayMs` has passed, easing out. */
export function useCountUp(
  to: number,
  { from = 0, delayMs = 0, durationMs = 900 }: { from?: number; delayMs?: number; durationMs?: number } = {},
): number {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? to : from));

  useEffect(() => {
    if (prefersReducedMotion() || from === to) {
      setValue(to);
      return;
    }
    setValue(from);
    const startAt = performance.now() + delayMs;
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - startAt) / durationMs));
      setValue(Math.round(from + (to - from) * easeOutCubic(t)));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [to, from, delayMs, durationMs]);

  return value;
}

/** True once `delayMs` has passed since mount — immediately, with reduced motion. */
export function useAfter(delayMs: number): boolean {
  const [done, setDone] = useState(() => prefersReducedMotion() || delayMs <= 0);
  useEffect(() => {
    if (done) return;
    const timer = window.setTimeout(() => setDone(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, done]);
  return done;
}

/**
 * FLIP: when the children of `list` change order, each one slides from where it was to where
 * it now is, instead of jumping. Children are matched by `data-flip-id`.
 */
export function useFlip(list: RefObject<HTMLElement>, order: string): void {
  const positions = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const animate = !prefersReducedMotion();

    for (const child of Array.from(el.children) as HTMLElement[]) {
      const id = child.dataset.flipId;
      if (!id) continue;
      const top = child.offsetTop;
      const was = positions.current.get(id);
      positions.current.set(id, top);
      if (!animate || was === undefined || was === top) continue;

      child.style.transition = 'none';
      child.style.transform = `translateY(${was - top}px)`;
      // Commit the inverted position before transitioning away from it.
      void child.offsetHeight;
      child.style.transition = 'transform 400ms cubic-bezier(0.2, 0.8, 0.2, 1)';
      child.style.transform = '';
    }
  }, [list, order]);
}
