import type { LatLng } from '@pangoguessr/shared';
import { pickZone, randomPointIn, type Zone } from './zones';

/**
 * Asks for the nearest panorama within 5km rather than an exact hit, which raises the
 * success rate enormously — a random point almost never lands exactly on a road (§7).
 */
const SEARCH_RADIUS_M = 5000;

/** Misses within one zone before giving up and trying a different one (§7). */
const MAX_MISSES_PER_ZONE = 15;

const METADATA_URL = 'https://maps.googleapis.com/maps/api/streetview/metadata';

export type PanoramaHit = {
  panoId: string;
  at: LatLng;
  zoneId: string;
  zoneName: string;
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
    // Official car coverage only. User photospheres are wildly inconsistent in quality and
    // often indoors, which makes for unguessable rounds.
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

/**
 * Weighted-random zone, uniform point inside it, metadata lookup, retry on miss, fall back
 * to a different zone after too many misses (§7).
 */
export async function samplePanorama(
  zones: readonly Zone[],
  fetcher: MetadataFetcher,
  stats: SampleStats,
  random = Math.random,
): Promise<PanoramaHit | null> {
  // Two zone attempts: if a zone is that ocean-heavy it should be tightened, not retried
  // indefinitely.
  for (let zoneAttempt = 0; zoneAttempt < 2; zoneAttempt++) {
    const zone = pickZone(zones, random);
    for (let miss = 0; miss < MAX_MISSES_PER_ZONE; miss++) {
      const hit = await fetcher(randomPointIn(zone, random), SEARCH_RADIUS_M);
      if (hit) {
        return { panoId: hit.panoId, at: hit.at, zoneId: zone.id, zoneName: zone.name };
      }
      stats.misses++;
    }
  }
  return null;
}
