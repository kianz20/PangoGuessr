/** A single sampling box. Weights are relative *within its group*. */
export type Zone = {
  id: string;
  name: string;
  weight: number;
  bbox: [south: number, west: number, north: number, east: number];
};

/**
 * A named collection of boxes that share one weight. Rounds are drawn in two steps: pick a
 * group by group weight, then pick one of its zones by zone weight.
 *
 * This is what lets "New Zealand" be one entry worth 13% of rounds while still being made of
 * five tight boxes around different parts of the country — without those five boxes each
 * competing separately against every other country.
 */
export type ZoneGroup = {
  id: string;
  name: string;
  weight: number;
  zones: Zone[];
};

/**
 * Locations are NOT sampled uniformly from the world (§7). Coverage-weighted random lands
 * overwhelmingly on featureless roads in the US, Russia, Australia and Brazil, so most
 * rounds look alike with few clues to read.
 *
 * Chosen for **variety of visual cues** rather than even geographic coverage: mixed driving
 * sides, distinct road markings and sign shapes, vegetation from Icelandic tundra to Thai
 * jungle. Keep the boxes small and distinctive — "Europe" as one bbox reproduces the
 * original problem at smaller scale.
 */
export const ZONE_GROUPS: ZoneGroup[] = [
  // home advantage — everyone should recognise a few of these
  {
    id: 'nz',
    name: 'New Zealand',
    weight: 4,
    zones: [{ id: 'nz-all', name: 'New Zealand', weight: 1, bbox: [-46.7, 166.4, -34.4, 178.6] }],
  },
  {
    id: 'au',
    name: 'Australia',
    weight: 3,
    zones: [{ id: 'au-e', name: 'East coast', weight: 1, bbox: [-38.5, 141.0, -25.0, 153.6] }],
  },

  // distinctive signage / architecture / driving side
  {
    id: 'jp',
    name: 'Japan',
    weight: 3,
    zones: [{ id: 'jp-all', name: 'Japan', weight: 1, bbox: [31.0, 130.0, 45.5, 145.8] }],
  },
  {
    id: 'uk-ie',
    name: 'UK & Ireland',
    weight: 3,
    zones: [{ id: 'uk-ie-all', name: 'UK & Ireland', weight: 1, bbox: [50.0, -10.5, 58.7, 1.8] }],
  },
  {
    id: 'south-europe',
    name: 'Southern Europe',
    weight: 4,
    zones: [
      { id: 'it', name: 'Italy', weight: 2, bbox: [36.6, 6.6, 47.1, 18.5] },
      { id: 'es-pt', name: 'Iberia', weight: 2, bbox: [36.0, -9.5, 43.8, 3.3] },
    ],
  },
  {
    id: 'alps',
    name: 'Alps',
    weight: 2,
    zones: [{ id: 'alps-all', name: 'Alps', weight: 1, bbox: [45.8, 5.9, 49.0, 17.2] }],
  },
  {
    id: 'nordic',
    name: 'Nordics',
    weight: 3,
    zones: [
      { id: 'no-se', name: 'Norway & Sweden', weight: 2, bbox: [57.0, 4.5, 71.2, 31.0] },
      { id: 'is', name: 'Iceland', weight: 1, bbox: [63.2, -24.6, 66.6, -13.5] },
    ],
  },

  // wider world — keeps the map honest
  {
    id: 'us',
    name: 'US (west)',
    weight: 3,
    zones: [{ id: 'us-w', name: 'West', weight: 1, bbox: [32.5, -124.4, 49.0, -110.0] }],
  },
  {
    id: 'south-america',
    name: 'South America',
    weight: 3,
    zones: [
      { id: 'br-se', name: 'Brazil (SE)', weight: 2, bbox: [-25.5, -51.0, -19.5, -39.5] },
      { id: 'cl', name: 'Chile', weight: 1, bbox: [-42.0, -75.0, -30.0, -69.8] },
    ],
  },
  {
    id: 'za',
    name: 'South Africa',
    weight: 2,
    zones: [{ id: 'za-all', name: 'South Africa', weight: 1, bbox: [-34.9, 17.0, -22.1, 32.9] }],
  },
  {
    id: 'th',
    name: 'Thailand',
    weight: 2,
    zones: [{ id: 'th-all', name: 'Thailand', weight: 1, bbox: [5.6, 97.3, 20.5, 105.6] }],
  },
];

function weightedPick<T extends { weight: number }>(items: readonly T[], random: () => number): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let ticket = random() * total;
  for (const item of items) {
    ticket -= item.weight;
    if (ticket <= 0) return item;
  }
  return items[items.length - 1]!;
}

export function pickGroup(groups: readonly ZoneGroup[], random = Math.random): ZoneGroup {
  return weightedPick(groups, random);
}

export function pickZone(zones: readonly Zone[], random = Math.random): Zone {
  return weightedPick(zones, random);
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

/** Every zone across every group, for map rendering and whole-list checks. */
export function allZones(groups: readonly ZoneGroup[]): Zone[] {
  return groups.flatMap((group) => group.zones);
}
