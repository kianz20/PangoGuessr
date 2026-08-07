import { ROUND_MS } from './constants';

/** Accuracy floors at zero here — roughly antipodal (§6). */
const MAX_KM = 20_000;
/** Below this, treat as a bullseye. Lower rewards precision more. */
const NEAR_KM = 0.5;

const DECAY_DIVISOR = Math.log10(1 + MAX_KM / NEAR_KM);

/** How much of its accuracy a guess at the buzzer keeps: 1 - SPEED_WEIGHT. */
const SPEED_WEIGHT = 0.4;

/**
 * Log distance, not GeoGuessr's exponential (§6). Every halving of the error is worth the
 * same, so finding the street beats finding the city instead of tying with it.
 */
export function accuracyScore(distanceKm: number): number {
  const d = Math.max(distanceKm, 0);
  const decay = Math.log10(1 + d / NEAR_KM) / DECAY_DIVISOR;
  return 5000 * Math.max(0, 1 - decay);
}

/**
 * Server-only in anger — the client lacks the actual coordinates to pass in, and may
 * import this to *preview* a score but never to decide one (§6).
 *
 * `elapsedMs` is client-reported (§5) and clamped here, so the clamp can't be bypassed
 * by any caller.
 */
export function scoreGuess(distanceKm: number, elapsedMs: number): number {
  const t = Math.min(Math.max(elapsedMs, 0) / ROUND_MS, 1);
  return Math.round(accuracyScore(distanceKm) * (1 - SPEED_WEIGHT * t));
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle, not driving distance (§12). */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
