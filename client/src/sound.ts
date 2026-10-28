import { useSyncExternalStore } from 'react';

/**
 * Sound, off by default on every phone. Sixteen phones in one room all chiming the same reveal
 * is chaos, so it's opt-in per phone, and the lobby suggests turning it on for just one.
 *
 * Every cue is synthesised with WebAudio: nothing to fetch, nothing to fail to load, and
 * nothing to decode on a phone that's also holding five panoramas.
 */
export type Cue =
  | 'join'
  | 'roundStart'
  | 'tick'
  | 'tickFinal'
  | 'lock'
  | 'answer'
  | 'land'
  | 'step'
  | 'drumroll'
  | 'fanfare'
  | 'busted';

const KEY = 'pangoguessr.sound';
/** Quiet: a phone speaker at full volume in a small room is plenty. */
const MASTER_GAIN = 0.5;
/** A pentatonic run, so the reveal's pins climb without ever clashing. */
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

let on = readSetting();
let context: AudioContext | null = null;
let master: GainNode | null = null;
const listeners = new Set<() => void>();

export function useSoundOn(): boolean {
  return useSyncExternalStore(subscribe, () => on);
}

/** Call from a tap: that's the only moment a phone will let a page start making sound. */
export function setSoundOn(value: boolean): void {
  on = value;
  try {
    localStorage.setItem(KEY, value ? '1' : '0');
  } catch {
    // Private mode: the setting just won't survive a reload.
  }
  // A little pop to say it's working, once the phone has let the audio start.
  if (value) void unlock().then(() => play('lock'));
  listeners.forEach((listener) => listener());
}

/** `step` climbs the scale: the reveal's pins, the podium's steps. */
export function play(cue: Cue, { step = 0 }: { step?: number } = {}): void {
  if (!on) return;
  const ctx = audio();
  if (!ctx || !master || ctx.state !== 'running') return;
  const t = ctx.currentTime + 0.01;

  switch (cue) {
    case 'join':
      note(ctx, 660, t, 0.09, { type: 'sine', gain: 0.35 });
      note(ctx, 990, t + 0.08, 0.14, { type: 'sine', gain: 0.3 });
      return;
    case 'roundStart':
      [523.25, 659.25, 783.99].forEach((f, i) =>
        note(ctx, f, t + i * 0.09, 0.28, { type: 'triangle', gain: 0.32 }),
      );
      return;
    case 'tick':
      note(ctx, 1_050, t, 0.05, { type: 'square', gain: 0.08 });
      return;
    case 'tickFinal':
      note(ctx, 1_400, t, 0.07, { type: 'square', gain: 0.11 });
      return;
    case 'lock':
      note(ctx, 520, t, 0.1, { type: 'sine', gain: 0.4, slideTo: 820 });
      return;
    case 'answer':
      note(ctx, 190, t, 0.3, { type: 'sine', gain: 0.6, slideTo: 95 });
      return;
    case 'land':
      note(ctx, semitones(440, SCALE[Math.min(step, SCALE.length - 1)]!), t, 0.22, {
        type: 'triangle',
        gain: 0.3,
      });
      return;
    case 'step':
      note(ctx, semitones(392, step * 4), t, 0.4, { type: 'triangle', gain: 0.36 });
      return;
    case 'drumroll':
      // Quickening taps, getting louder, for the pause before first place.
      for (let i = 0, at = 0; at < 1.5; i++) {
        note(ctx, 180 + i * 6, t + at, 0.05, { type: 'square', gain: 0.03 + at * 0.06 });
        at += Math.max(0.035, 0.14 - i * 0.008);
      }
      return;
    case 'fanfare':
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        note(ctx, f, t + i * 0.11, 0.3, { type: 'triangle', gain: 0.34 }),
      );
      [523.25, 659.25, 783.99, 1046.5].forEach((f) =>
        note(ctx, f, t + 0.48, 0.9, { type: 'sine', gain: 0.18 }),
      );
      return;
    case 'busted':
      // A game-show "wrong answer": two sagging buzzes.
      note(ctx, 233, t, 0.32, { type: 'sawtooth', gain: 0.18, slideTo: 196 });
      note(ctx, 196, t + 0.36, 0.6, { type: 'sawtooth', gain: 0.18, slideTo: 131 });
      return;
  }
}

function note(
  ctx: AudioContext,
  frequency: number,
  at: number,
  duration: number,
  { type, gain, slideTo }: { type: OscillatorType; gain: number; slideTo?: number },
): void {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, at);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + duration);
  // A fast attack and an exponential tail: plucked, not beeped.
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(gain, at + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(env).connect(master!);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

function semitones(base: number, n: number): number {
  return base * 2 ** (n / 12);
}

function audio(): AudioContext | null {
  if (context) return context;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  context = new Ctor();
  master = context.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(context.destination);
  return context;
}

/** Phones keep a page's audio suspended until a tap, so every tap tries to wake it. */
function unlock(): Promise<void> {
  const ctx = audio();
  if (!ctx || ctx.state === 'running') return Promise.resolve();
  return ctx.resume().catch(() => {});
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readSetting(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

// Turned on in an earlier visit: the first tap anywhere brings the audio back.
if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    () => {
      if (on) void unlock();
    },
    { capture: true, passive: true },
  );
}
