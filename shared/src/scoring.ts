/** Distance at which the curve has decayed to essentially nothing. */
const WORLD_KM = 14_916;

const MAX_POINTS = 5000;

/**
 * GeoGuessr's world scoring curve. A perfect guess scores 5000 and the score decays
 * exponentially with distance, so being on the right continent is worth real points and
 * being on the wrong side of the planet is worth none.
 *
 * Runs on the server only: the client has no access to the actual coordinates.
 */
export function scoreGuess(distanceKm: number): number {
  const d = Math.max(distanceKm, 0);
  return Math.round(MAX_POINTS * Math.exp((-10 * d) / WORLD_KM));
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
