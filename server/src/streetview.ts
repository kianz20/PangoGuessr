import type { LatLng } from '@pangoguessr/shared';
import { largestPlacesIn } from './places';
import { pickGroup, pickZone, randomPointIn, type Zone, type ZoneGroup } from './zones';

/**
 * Asks for the nearest panorama within 5km rather than an exact hit, which raises the
 * success rate enormously — a random point almost never lands exactly on a road (§7).
 */
const SEARCH_RADIUS_M = 5000;

/**
 * Points tried at once. Metadata round-trips are the whole cost of sampling, so firing a
 * small batch together and taking the first hit cuts the wall-clock time several-fold, at
 * the price of a couple of wasted calls per hit — quota, not money.
 */
const POINTS_PER_BATCH = 3;

/**
 * Misses within one zone before it is written off as having no coverage (§7). Generous on
 * purpose: giving up is what made ocean-heavy countries quietly come up less often than
 * their weight, because every abandoned draw went to some other country instead.
 */
const MAX_MISSES_PER_ZONE = 60;

/**
 * After the box itself comes up empty, this many more tries go to tight boxes around the
 * zone's biggest towns before it's written off. A badly drawn box — mostly sea, or one
 * covering a country whose roads are all near its cities — still gets its rounds.
 */
const MAX_CITY_MISSES = 60;
/** The towns to aim for. Ten keeps a fallback round from always being the capital. */
const FALLBACK_CITIES = 10;
/** Half-width of the box around a town, in degrees — about 15km, plus the 5km search radius. */
const CITY_SPREAD_DEG = 0.15;

const METADATA_URL = 'https://maps.googleapis.com/maps/api/streetview/metadata';

export type PanoramaHit = {
  panoId: string;
  at: LatLng;
  zoneId: string;
  /** The group's name — that's the human-meaningful geography for the reveal (§4). */
  zoneName: string;
  groupId: string;
};

/** Injectable so sampling can be tested without touching the network or a billing account. */
export type MetadataFetcher = (
  point: LatLng,
  radiusM: number,
) => Promise<{ panoId: string; at: LatLng } | null>;

export type SampleStats = {
  metadataCalls: number;
  misses: number;
};

/**
 * Metadata requests are **free**, which is what makes this retry loop acceptable — only the
 * panorama *load* in the browser bills (§7).
 */
export function googleMetadataFetcher(apiKey: string, stats: SampleStats): MetadataFetcher {
  return async (point, radiusM) => {
    const url = new URL(METADATA_URL);
    url.searchParams.set('location', `${point.lat},${point.lng}`);
    url.searchParams.set('radius', String(radiusM));
    // Excludes indoor collections, but still returns user-contributed outdoor photospheres —
    // deliberately: they're the only imagery in places like China, Egypt and the Pacific.
    url.searchParams.set('source', 'outdoor');
    url.searchParams.set('key', apiKey);

    stats.metadataCalls++;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Street View metadata HTTP ${response.status}`);

    const body = (await response.json()) as {
      status: string;
      pano_id?: string;
      location?: { lat: number; lng: number };
    };

    if (body.status === 'ZERO_RESULTS') return null;
    if (body.status !== 'OK' || !body.pano_id || !body.location) {
      // OVER_QUERY_LIMIT / REQUEST_DENIED are configuration problems, not misses — surface
      // them rather than silently retrying forever.
      throw new Error(`Street View metadata status ${body.status}`);
    }
    return { panoId: body.pano_id, at: { lat: body.location.lat, lng: body.location.lng } };
  };
}

export type SampleOptions = {
  /**
   * Groups to avoid if anything else is left — the ones already in the pool, so one game
   * doesn't show the same country twice. Ignored once every live group is excluded.
   */
  avoidGroups?: ReadonlySet<string>;
  /**
   * Zones that exhausted their misses without a single panorama. Shared across draws and
   * added to here, so a dud box is only searched once rather than on every refill.
   */
  deadZones?: Set<string>;
  /** Checked between batches, so a failed refill stops its other searches too. */
  cancelled?: () => boolean;
  /** Fallback targets for a zone; defaults to the biggest towns in its box from GeoNames. */
  citiesIn?: (zone: Zone) => readonly LatLng[];
  /** Told the group as soon as it's drawn — before any search — so parallel draws can spread out. */
  onDraw?: (groupId: string) => void;
};

/**
 * Weighted-random **group**, then a weighted-random zone inside it, then uniform points in
 * that zone's box, a few at a time, until one has a panorama (§7).
 *
 * Once a group is drawn it is kept: misses mean "try more points", not "try another
 * country". If the box itself keeps missing, the search narrows to its biggest towns. Only a
 * zone that finds nothing either way is written off — and then excluded from every later
 * draw, so the odds are spread over the zones that actually have coverage.
 *
 * The two levels are what let a country be one entry in the odds while being made of several
 * tight boxes, instead of each box competing separately against every other country.
 */
export async function samplePanorama(
  groups: readonly ZoneGroup[],
  fetcher: MetadataFetcher,
  stats: SampleStats,
  random = Math.random,
  options: SampleOptions = {},
): Promise<PanoramaHit | null> {
  const dead = options.deadZones ?? new Set<string>();
  const avoid = options.avoidGroups ?? new Set<string>();

  for (;;) {
    const live = groups
      .map((group) => ({ ...group, zones: group.zones.filter((zone) => !dead.has(zone.id)) }))
      .filter((group) => group.zones.length > 0);
    if (live.length === 0) return null;
    const fresh = live.filter((group) => !avoid.has(group.id));

    const group = pickGroup(fresh.length > 0 ? fresh : live, random);
    const zone = pickZone(group.zones, random);
    options.onDraw?.(group.id);
    const hit =
      (await searchZone(() => randomPointIn(zone, random), MAX_MISSES_PER_ZONE, fetcher, stats, options.cancelled)) ??
      (await searchNearCities(zone, fetcher, stats, random, options));
    if (hit) {
      return { panoId: hit.panoId, at: hit.at, zoneId: zone.id, zoneName: group.name, groupId: group.id };
    }
    if (options.cancelled?.()) return null;
    dead.add(zone.id);
  }
}

/** Points are drawn before any await, so a seeded `random` still gives the same result. */
async function searchZone(
  nextPoint: () => LatLng,
  maxTries: number,
  fetcher: MetadataFetcher,
  stats: SampleStats,
  cancelled?: () => boolean,
): Promise<{ panoId: string; at: LatLng } | null> {
  for (let tried = 0; tried < maxTries; tried += POINTS_PER_BATCH) {
    if (cancelled?.()) return null;
    const points = Array.from({ length: POINTS_PER_BATCH }, nextPoint);
    const results = await Promise.all(points.map((point) => fetcher(point, SEARCH_RADIUS_M)));
    const hit = results.find((result) => result !== null);
    stats.misses += results.filter((result) => result === null).length;
    if (hit) return hit;
  }
  return null;
}

/** Cached by box: the scan covers the whole extract, and a zone's towns don't change. */
const cityCache = new Map<string, readonly LatLng[]>();

function defaultCitiesIn(zone: Zone): readonly LatLng[] {
  const key = zone.bbox.join(',');
  let cities = cityCache.get(key);
  if (!cities) {
    cities = largestPlacesIn(zone.bbox, FALLBACK_CITIES);
    cityCache.set(key, cities);
  }
  return cities;
}

/** The second chance: a uniform-random town from the zone's biggest, then a point close to it. */
async function searchNearCities(
  zone: Zone,
  fetcher: MetadataFetcher,
  stats: SampleStats,
  random: () => number,
  options: SampleOptions,
): Promise<{ panoId: string; at: LatLng } | null> {
  if (options.cancelled?.()) return null;
  const cities = (options.citiesIn ?? defaultCitiesIn)(zone);
  if (cities.length === 0) return null;
  const nearCity = (): LatLng => {
    const city = cities[Math.floor(random() * cities.length)]!;
    return {
      lat: city.lat + (random() * 2 - 1) * CITY_SPREAD_DEG,
      lng: city.lng + (random() * 2 - 1) * CITY_SPREAD_DEG,
    };
  };
  return searchZone(nearCity, MAX_CITY_MISSES, fetcher, stats, options.cancelled);
}
