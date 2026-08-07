import type { LatLng } from '@pangoguessr/shared';

export type FixedLocation = {
  id: string;
  /** Shown only on the reveal, never before (§3). */
  name: string;
  at: LatLng;
};

/**
 * Step 2 of the build order (§10): a hand-picked list, so the round loop can be built and
 * played before any imagery or random sampling exists. Step 3 replaces this with weighted
 * zone sampling and real metadata validation (§7).
 *
 * Chosen to mirror the zone weights — NZ-heavy, then a spread of visually distinctive
 * places — so the spacing of scores while tuning resembles the real game.
 */
export const FIXED_LOCATIONS: FixedLocation[] = [
  { id: 'wellington', name: 'Wellington, New Zealand', at: { lat: -41.2887, lng: 174.7772 } },
  { id: 'auckland', name: 'Auckland, New Zealand', at: { lat: -36.8485, lng: 174.7633 } },
  { id: 'queenstown', name: 'Queenstown, New Zealand', at: { lat: -45.0312, lng: 168.6626 } },
  { id: 'napier', name: 'Napier, New Zealand', at: { lat: -39.4928, lng: 176.912 } },
  { id: 'sydney', name: 'Sydney, Australia', at: { lat: -33.8688, lng: 151.2093 } },
  { id: 'melbourne', name: 'Melbourne, Australia', at: { lat: -37.8136, lng: 144.9631 } },
  { id: 'kyoto', name: 'Kyoto, Japan', at: { lat: 35.0116, lng: 135.7681 } },
  { id: 'tokyo', name: 'Tokyo, Japan', at: { lat: 35.6762, lng: 139.6503 } },
  { id: 'edinburgh', name: 'Edinburgh, Scotland', at: { lat: 55.9533, lng: -3.1883 } },
  { id: 'dublin', name: 'Dublin, Ireland', at: { lat: 53.3498, lng: -6.2603 } },
  { id: 'florence', name: 'Florence, Italy', at: { lat: 43.7696, lng: 11.2558 } },
  { id: 'lisbon', name: 'Lisbon, Portugal', at: { lat: 38.7223, lng: -9.1393 } },
  { id: 'interlaken', name: 'Interlaken, Switzerland', at: { lat: 46.6863, lng: 7.8632 } },
  { id: 'bergen', name: 'Bergen, Norway', at: { lat: 60.3913, lng: 5.3221 } },
  { id: 'reykjavik', name: 'Reykjavík, Iceland', at: { lat: 64.1466, lng: -21.9426 } },
  { id: 'portland', name: 'Portland, Oregon, USA', at: { lat: 45.5152, lng: -122.6784 } },
  { id: 'sanfrancisco', name: 'San Francisco, USA', at: { lat: 37.7749, lng: -122.4194 } },
  { id: 'riodejaneiro', name: 'Rio de Janeiro, Brazil', at: { lat: -22.9068, lng: -43.1729 } },
  { id: 'capetown', name: 'Cape Town, South Africa', at: { lat: -33.9249, lng: 18.4241 } },
  { id: 'chiangmai', name: 'Chiang Mai, Thailand', at: { lat: 18.7883, lng: 98.9853 } },
];

/**
 * Fisher-Yates over the indices, then take the first N. Drawing without replacement is the
 * point: the same location twice in one game is instantly noticeable.
 */
export function dealLocations(count: number, random = Math.random): FixedLocation[] {
  const pool = [...FIXED_LOCATIONS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, Math.min(count, pool.length));
}
