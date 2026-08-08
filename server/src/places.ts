import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { haversineKm } from '@pangoguessr/shared';
import type { LatLng } from '@pangoguessr/shared';

/**
 * Names a coordinate from a bundled GeoNames extract — no API, no key, no quota, no latency,
 * and it works while the network is down. Rebuild the data with
 * `node server/scripts/build-cities.mjs`.
 *
 * Data © GeoNames, CC BY 4.0.
 */

/** Beyond this the nearest settlement tells you nothing useful, so don't claim one. */
const MAX_USEFUL_KM = 400;
/** Within this, just name the place; further out, say how far away it is. */
const EXACT_KM = 5;

/**
 * Inside this radius the *biggest* nearby place wins rather than the closest one.
 *
 * The dataset lists suburbs as places in their own right, so nearest-wins named central Tokyo
 * "Eifuku" and Reykjavík "Seltjarnarnes" — technically correct and useless to a player. Anyone
 * describing where they are says the city, not the suburb.
 */
const PROMINENCE_KM = 30;

/** One degree per cell. Coarse, but it turns 170k comparisons into a few dozen. */
const CELL = 1;

export type Place = {
  name: string;
  region: string;
  country: string;
  distanceKm: number;
};

type Table = {
  names: string[];
  lat: Float64Array;
  lng: Float64Array;
  countryId: Int16Array;
  regionId: Int16Array;
  population: Float64Array;
  countries: string[];
  regions: string[];
  /** cell key -> indices of the places inside it. */
  grid: Map<number, number[]>;
};

let table: Table | null = null;

function cellKey(lat: number, lng: number): number {
  // +90/+180 keeps both positive, so the key stays a small integer.
  return (Math.floor((lat + 90) / CELL) << 10) | Math.floor((lng + 180) / CELL);
}

function dataPath(): string {
  // Resolved from this module, which sits one level below server/ both as source (src/) and as
  // the built bundle (dist/), so the same relative path works either way.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/places.tsv.gz');
}

export function loadPlaces(file = dataPath()): Table {
  if (table) return table;

  const text = gunzipSync(readFileSync(file)).toString('utf8');
  const newline = text.indexOf('\n');
  const header = JSON.parse(text.slice(0, newline)) as { countries: string[]; regions: string[] };

  const lines = text.slice(newline + 1).split('\n');
  const count = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;

  const names: string[] = new Array(count);
  const lat = new Float64Array(count);
  const lng = new Float64Array(count);
  const countryId = new Int16Array(count);
  const regionId = new Int16Array(count);
  const population = new Float64Array(count);
  const grid = new Map<number, number[]>();

  for (let i = 0; i < count; i++) {
    const cols = lines[i]!.split('\t');
    names[i] = cols[0]!;
    lat[i] = Number(cols[1]);
    lng[i] = Number(cols[2]);
    countryId[i] = Number(cols[3]);
    regionId[i] = Number(cols[4]);
    population[i] = Number(cols[5]) || 0;

    const key = cellKey(lat[i]!, lng[i]!);
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

  table = {
    names,
    lat,
    lng,
    countryId,
    regionId,
    population,
    countries: header.countries,
    regions: header.regions,
    grid,
  };
  return table;
}

/**
 * The place a person would name for this point, or null if everything is implausibly far away
 * — mid-ocean roads and remote highways, where the caller falls back to the zone name.
 *
 * Within PROMINENCE_KM the most populous candidate wins; outside it, the closest. Searches the
 * containing grid cell and widens a ring at a time.
 */
export function nearestPlace(at: LatLng, data = loadPlaces()): Place | null {
  const latCell = Math.floor((at.lat + 90) / CELL);
  const lngCell = Math.floor((at.lng + 180) / CELL);

  let bestIndex = -1;
  let bestKm = Infinity;
  // Tracked separately: the most prominent place close enough to be what you'd call this spot.
  let prominentIndex = -1;
  let prominentPopulation = -1;
  let prominentKm = Infinity;

  for (let ring = 0; ring <= MAX_USEFUL_KM / 111 + 1; ring++) {
    for (let dLat = -ring; dLat <= ring; dLat++) {
      for (let dLng = -ring; dLng <= ring; dLng++) {
        // Only the newly added edge of the ring; the inside was covered by earlier rings.
        if (ring > 0 && Math.abs(dLat) !== ring && Math.abs(dLng) !== ring) continue;
        // Longitude wraps, so a point near the dateline still sees its neighbours.
        const key = ((latCell + dLat) << 10) | (((lngCell + dLng) % 360) + 360) % 360;
        const bucket = data.grid.get(key);
        if (!bucket) continue;
        for (const i of bucket) {
          const km = haversineKm(at, { lat: data.lat[i]!, lng: data.lng[i]! });
          if (km < bestKm) {
            bestKm = km;
            bestIndex = i;
          }
          if (km <= PROMINENCE_KM && data.population[i]! > prominentPopulation) {
            prominentPopulation = data.population[i]!;
            prominentIndex = i;
            prominentKm = km;
          }
        }
      }
    }
    // Nothing closer, and nothing more prominent, can hide beyond a ring already further away
    // than what we have. The prominence radius sets the floor for how early we can stop.
    if (bestIndex >= 0 && bestKm <= ring * 111 && ring * 111 >= PROMINENCE_KM) break;
  }

  const chosen = prominentIndex >= 0 ? prominentIndex : bestIndex;
  const distanceKm = prominentIndex >= 0 ? prominentKm : bestKm;
  if (chosen < 0 || distanceKm > MAX_USEFUL_KM) return null;

  const regionId = data.regionId[chosen]!;
  return {
    name: data.names[chosen]!,
    region: regionId >= 0 ? (data.regions[regionId] ?? '') : '',
    country: data.countries[data.countryId[chosen]!] ?? '',
    distanceKm,
  };
}

/**
 * What the reveal shows. Naming a town 80km away as if it were the location would be wrong,
 * so past a few kilometres the distance is stated instead of hidden.
 */
export function describePlace(place: Place): string {
  const where = [place.name, place.country].filter(Boolean).join(', ');
  if (place.distanceKm <= EXACT_KM) return where;
  const km = place.distanceKm < 20 ? place.distanceKm.toFixed(0) : Math.round(place.distanceKm / 5) * 5;
  return `${km} km from ${where}`;
}

/** Convenience for callers that want a name or nothing. */
export function describeLocation(at: LatLng): string | null {
  const place = nearestPlace(at);
  return place ? describePlace(place) : null;
}
