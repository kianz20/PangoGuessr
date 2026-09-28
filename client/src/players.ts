import { useRef } from 'react';
import { MAX_PLAYERS } from '@pangoguessr/shared';
import type { PublicPlayer } from '@pangoguessr/shared';

/**
 * One colour per player slot the server hands out (`PublicPlayer.color`). Ten hues in two
 * tones, ordered so the first few players in a room are as far apart as possible.
 *
 * Deliberately missing: amber, which marks "you" everywhere, and mint, which is the answer on
 * the reveal map. Initials do the real work of telling people apart; colour just makes a
 * crowded map quicker to read.
 */
const HUES = [210, 355, 95, 285, 28, 190, 315, 232, 12, 258];
const PALETTE = [
  ...HUES.map((h) => `hsl(${h} 80% 68%)`),
  ...HUES.map((h) => `hsl(${h} 62% 56%)`),
];
if (PALETTE.length < MAX_PLAYERS) throw new Error('Player palette is smaller than a full room');

export function paletteColor(slot: number): string {
  return PALETTE[((slot % PALETTE.length) + PALETTE.length) % PALETTE.length]!;
}

/** "Luka Cosic" → "LC", "Kian" → "Ki". Code points, not UTF-16 units, so emoji survive. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = Array.from(words[0] ?? '?');
  if (words.length >= 2) {
    const last = Array.from(words[words.length - 1]!);
    return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
  }
  return `${(first[0] ?? '?').toUpperCase()}${(first[1] ?? '').toLowerCase()}`;
}

/**
 * A colour lookup for everyone seen this game, including anyone who has since left — their
 * pin is still on the reveal, and it should keep the colour it had.
 */
export function usePlayerColors(players: readonly PublicPlayer[] | undefined) {
  const seen = useRef(new Map<string, number>());
  for (const p of players ?? []) seen.current.set(p.id, p.color);
  return (playerId: string): string => {
    const slot = seen.current.get(playerId);
    return slot === undefined ? fallbackColor(playerId) : paletteColor(slot);
  };
}

export type ColorOf = (playerId: string) => string;

function fallbackColor(playerId: string): string {
  let hash = 0;
  for (const ch of playerId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return paletteColor(Math.abs(hash));
}
