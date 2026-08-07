export type Zone = {
  id: string;
  name: string;
  /** Relative pick frequency. Tune by taste after playing a few games (§7). */
  weight: number;
  bbox: [south: number, west: number, north: number, east: number];
};

/**
 * Locations are NOT sampled uniformly from the world (§7). Coverage-weighted random lands
 * overwhelmingly on featureless roads in the US, Russia, Australia and Brazil, so most
 * rounds look alike with few clues to read.
 *
 * These 14 are chosen for **variety of visual cues** rather than even geographic coverage:
 * mixed driving sides, distinct road markings and sign shapes, vegetation from Icelandic
 * tundra to Thai jungle. Keep them small and distinctive — "Europe" as one bbox reproduces
 * the original problem at smaller scale.
 */
export const ZONES: Zone[] = [
  // home advantage — everyone should recognise a few of these
  { id: 'nz', name: 'New Zealand', weight: 4, bbox: [-46.7, 166.4, -34.4, 178.6] },
  { id: 'au-e', name: 'Australia (east)', weight: 3, bbox: [-38.5, 141.0, -25.0, 153.6] },

  // distinctive signage / architecture / driving side
  { id: 'jp', name: 'Japan', weight: 3, bbox: [31.0, 130.0, 45.5, 145.8] },
  { id: 'uk-ie', name: 'UK & Ireland', weight: 3, bbox: [50.0, -10.5, 58.7, 1.8] },
  { id: 'it', name: 'Italy', weight: 2, bbox: [36.6, 6.6, 47.1, 18.5] },
  { id: 'es-pt', name: 'Iberia', weight: 2, bbox: [36.0, -9.5, 43.8, 3.3] },
  { id: 'alps', name: 'Alps', weight: 2, bbox: [45.8, 5.9, 49.0, 17.2] },
  { id: 'nordic', name: 'Norway & Sweden', weight: 2, bbox: [57.0, 4.5, 71.2, 31.0] },
  { id: 'is', name: 'Iceland', weight: 1, bbox: [63.2, -24.6, 66.6, -13.5] },

  // wider world — keeps the map honest
  { id: 'us-w', name: 'US (west)', weight: 3, bbox: [32.5, -124.4, 49.0, -110.0] },
  { id: 'br-se', name: 'Brazil (SE)', weight: 2, bbox: [-25.5, -51.0, -19.5, -39.5] },
  { id: 'za', name: 'South Africa', weight: 2, bbox: [-34.9, 17.0, -22.1, 32.9] },
  { id: 'th', name: 'Thailand', weight: 2, bbox: [5.6, 97.3, 20.5, 105.6] },
  { id: 'cl', name: 'Chile', weight: 1, bbox: [-42.0, -75.0, -30.0, -69.8] },
];

export function pickZone(zones: readonly Zone[], random = Math.random): Zone {
  const total = zones.reduce((sum, zone) => sum + zone.weight, 0);
  let ticket = random() * total;
  for (const zone of zones) {
    ticket -= zone.weight;
    if (ticket <= 0) return zone;
  }
  return zones[zones.length - 1]!;
}

/**
 * Uniform-random point inside the bbox. Rectangles over New Zealand include a lot of ocean;
 * ocean simply fails the metadata check and retries, and metadata calls are free, so
 * retrying is cheaper than maintaining country border geometry (§7).
 */
export function randomPointIn(zone: Zone, random = Math.random): { lat: number; lng: number } {
  const [south, west, north, east] = zone.bbox;
  return {
    lat: south + random() * (north - south),
    lng: west + random() * (east - west),
  };
}
