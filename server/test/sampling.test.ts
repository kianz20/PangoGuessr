import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUNDS_PER_GAME } from '@pangoguessr/shared';
import { FixedLocationSource, PooledLocationSource } from '../src/locationSource';
import {
  googleMetadataFetcher,
  samplePanorama,
  type MetadataFetcher,
  type SampleStats,
} from '../src/streetview';
import { ZONE_GROUPS, allZones, pickGroup, pickZone, randomPointIn, type Zone, type ZoneGroup } from '../src/zones';

const stats = (): SampleStats => ({ metadataCalls: 0, misses: 0 });

/** Deterministic stand-in for Math.random, cycling through fixed values. */
function sequence(values: number[]) {
  let i = 0;
  return () => values[i++ % values.length]!;
}

test('every zone bbox is well formed and on the planet', () => {
  for (const zone of allZones(ZONE_GROUPS)) {
    const [south, west, north, east] = zone.bbox;
    assert.ok(south < north, `${zone.id}: south below north`);
    assert.ok(west < east, `${zone.id}: west below east`);
    assert.ok(south >= -90 && north <= 90, `${zone.id}: latitude in range`);
    assert.ok(west >= -180 && east <= 180, `${zone.id}: longitude in range`);
    assert.ok(zone.weight > 0, `${zone.id}: positive weight`);
  }
  const ids = allZones(ZONE_GROUPS).map((z) => z.id);
  assert.equal(new Set(ids).size, ids.length, 'zone ids are unique across all groups');
  const groupIds = ZONE_GROUPS.map((g) => g.id);
  assert.equal(new Set(groupIds).size, groupIds.length, 'group ids are unique');
  for (const group of ZONE_GROUPS) {
    assert.ok(group.zones.length > 0, `${group.id} has at least one zone`);
    assert.ok(group.weight > 0, `${group.id} has a positive weight`);
  }
});

test('a sampled point always lands inside its zone', () => {
  for (const zone of allZones(ZONE_GROUPS)) {
    for (let i = 0; i < 50; i++) {
      const point = randomPointIn(zone);
      const [south, west, north, east] = zone.bbox;
      assert.ok(point.lat >= south && point.lat <= north, `${zone.id} lat`);
      assert.ok(point.lng >= west && point.lng <= east, `${zone.id} lng`);
    }
  }
});

test('zone picking respects weights', () => {
  const zones: Zone[] = [
    { id: 'heavy', name: 'Heavy', weight: 9, bbox: [0, 0, 1, 1] },
    { id: 'light', name: 'Light', weight: 1, bbox: [0, 0, 1, 1] },
  ];
  let heavy = 0;
  for (let i = 0; i < 10_000; i++) if (pickZone(zones).id === 'heavy') heavy++;
  // 9:1 weighting, so ~90%. Wide bounds keep this from being flaky.
  assert.ok(heavy > 8_500 && heavy < 9_500, `heavy picked ${heavy}/10000`);
});

test('a group is picked by group weight, then a zone by its weight within the group', () => {
  const groups: ZoneGroup[] = [
    {
      id: 'nz',
      name: 'New Zealand',
      weight: 3,
      zones: [
        { id: 'nz-north', name: 'North', weight: 3, bbox: [-39, 174, -35, 176] },
        { id: 'nz-south', name: 'South', weight: 1, bbox: [-46, 167, -42, 171] },
      ],
    },
    {
      id: 'jp',
      name: 'Japan',
      weight: 1,
      zones: [{ id: 'jp-all', name: 'Japan', weight: 1, bbox: [31, 130, 45, 145] }],
    },
  ];

  const counts: Record<string, number> = { 'nz-north': 0, 'nz-south': 0, 'jp-all': 0 };
  const runs = 40_000;
  for (let i = 0; i < runs; i++) {
    const group = pickGroup(groups);
    counts[pickZone(group.zones).id]!++;
  }

  // Group odds are 3:1, so NZ takes 75% of rounds regardless of how many boxes it contains —
  // that's the whole point of grouping. Within NZ the 3:1 split gives 56.25% and 18.75%.
  const share = (id: string) => (counts[id]! / runs) * 100;
  assert.ok(Math.abs(share('nz-north') - 56.25) < 1.5, `north ${share('nz-north').toFixed(1)}%`);
  assert.ok(Math.abs(share('nz-south') - 18.75) < 1.5, `south ${share('nz-south').toFixed(1)}%`);
  assert.ok(Math.abs(share('jp-all') - 25) < 1.5, `japan ${share('jp-all').toFixed(1)}%`);
});

test('adding boxes to a group does not increase how often that group comes up', () => {
  const one: ZoneGroup[] = [
    { id: 'a', name: 'A', weight: 1, zones: [{ id: 'a1', name: 'a1', weight: 1, bbox: [0, 0, 1, 1] }] },
    { id: 'b', name: 'B', weight: 1, zones: [{ id: 'b1', name: 'b1', weight: 1, bbox: [0, 0, 1, 1] }] },
  ];
  const many: ZoneGroup[] = [
    {
      id: 'a',
      name: 'A',
      weight: 1,
      zones: [
        { id: 'a1', name: 'a1', weight: 1, bbox: [0, 0, 1, 1] },
        { id: 'a2', name: 'a2', weight: 1, bbox: [0, 0, 1, 1] },
        { id: 'a3', name: 'a3', weight: 1, bbox: [0, 0, 1, 1] },
        { id: 'a4', name: 'a4', weight: 1, bbox: [0, 0, 1, 1] },
        { id: 'a5', name: 'a5', weight: 1, bbox: [0, 0, 1, 1] },
      ],
    },
    { id: 'b', name: 'B', weight: 1, zones: [{ id: 'b1', name: 'b1', weight: 1, bbox: [0, 0, 1, 1] }] },
  ];

  const shareOfA = (groups: ZoneGroup[]) => {
    let a = 0;
    for (let i = 0; i < 20_000; i++) if (pickGroup(groups).id === 'a') a++;
    return (a / 20_000) * 100;
  };
  assert.ok(Math.abs(shareOfA(one) - 50) < 2);
  assert.ok(Math.abs(shareOfA(many) - 50) < 2, 'five boxes still means 50% of rounds');
});

test('a boundary ticket cannot fall through to the wrong zone', () => {
  const zones: Zone[] = [
    { id: 'a', name: 'A', weight: 1, bbox: [0, 0, 1, 1] },
    { id: 'b', name: 'B', weight: 1, bbox: [0, 0, 1, 1] },
  ];
  assert.equal(pickZone(zones, () => 0).id, 'a', 'ticket at 0');
  // 0.999… must still resolve, not run off the end of the list.
  assert.ok(['a', 'b'].includes(pickZone(zones, () => 0.999999).id));
});

test('sampling retries past misses and reports them', () => {
  const s = stats();
  let calls = 0;
  const fetcher: MetadataFetcher = async (point) => {
    calls++;
    // First three points are ocean, the fourth is a road.
    if (calls < 4) return null;
    return { panoId: 'PANO_XYZ', at: point };
  };

  return samplePanorama(ZONE_GROUPS, fetcher, s).then((hit) => {
    assert.ok(hit);
    assert.equal(hit.panoId, 'PANO_XYZ');
    assert.equal(s.misses, 3, 'three ocean hits counted as misses');
    assert.ok(hit.zoneId && hit.zoneName, 'the zone comes back for the reveal');
  });
});

test('sampling gives up after exhausting two zones rather than looping forever', async () => {
  const s = stats();
  let calls = 0;
  const allOcean: MetadataFetcher = async () => {
    calls++;
    return null;
  };

  const hit = await samplePanorama(ZONE_GROUPS, allOcean, s);
  assert.equal(hit, null);
  assert.equal(calls, 30, '15 misses per zone, two zones');
});

test('a denied key surfaces as an error instead of an endless retry', async () => {
  const s = stats();
  const denied: MetadataFetcher = async () => {
    throw new Error('Street View metadata status REQUEST_DENIED');
  };
  await assert.rejects(() => samplePanorama(ZONE_GROUPS, denied, s), /REQUEST_DENIED/);
});

test('the pool refuses to deal until it holds a full game', async () => {
  const s = stats();
  let n = 0;
  const fetcher: MetadataFetcher = async (point) => ({ panoId: `PANO_${n++}`, at: point });

  const pool = new PooledLocationSource(fetcher, s, () => ZONE_GROUPS, ROUNDS_PER_GAME);
  // Nothing pre-warmed yet: better an honest refusal than a hung Start button.
  assert.equal(pool.take(ROUNDS_PER_GAME), null);

  await pool.warm();
  assert.equal(pool.size, ROUNDS_PER_GAME);

  const deck = pool.take(ROUNDS_PER_GAME);
  assert.ok(deck);
  assert.equal(deck.length, ROUNDS_PER_GAME);
  assert.equal(new Set(deck.map((l) => l.panoId)).size, ROUNDS_PER_GAME, 'no repeats in a game');
  for (const location of deck) {
    assert.ok(location.panoId && !location.panoId.startsWith('dev:'), 'real panorama ids');
    assert.ok(location.name, 'a zone name for the reveal');
  }
});

test('deal waits for the pool to fill instead of refusing', async () => {
  let n = 0;
  const fetcher: MetadataFetcher = async (point) => ({ panoId: `PANO_${n++}`, at: point });
  const pool = new PooledLocationSource(fetcher, stats(), () => ZONE_GROUPS, 8);

  // Two rooms created on a cold pool at once: both get a full, distinct game.
  const [a, b] = await Promise.all([pool.deal(ROUNDS_PER_GAME), pool.deal(ROUNDS_PER_GAME)]);
  assert.equal(a?.length, ROUNDS_PER_GAME);
  assert.equal(b?.length, ROUNDS_PER_GAME);
  const ids = [...a!, ...b!].map((l) => l.panoId);
  assert.equal(new Set(ids).size, ids.length, 'no panorama dealt to two rooms');
});

test('deal gives up on a failing fetcher rather than waiting out the backoff', async () => {
  const broken: MetadataFetcher = async () => {
    throw new Error('boom');
  };
  const pool = new PooledLocationSource(broken, stats(), () => ZONE_GROUPS, 5);
  assert.equal(await pool.deal(5), null);
});

test('a failing fetcher backs off instead of hammering the API', async () => {
  const s = stats();
  let calls = 0;
  const broken: MetadataFetcher = async () => {
    calls++;
    throw new Error('boom');
  };

  const pool = new PooledLocationSource(broken, s, () => ZONE_GROUPS, 5);
  await pool.warm();
  const afterFirst = calls;
  assert.ok(afterFirst > 0, 'it tried');

  // Immediately asking again must not start another round of calls.
  assert.equal(pool.take(5), null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, afterFirst, 'backed off');
  assert.match(String(pool.stats().lastError), /boom/, 'and the reason is visible in /api/health');
});

/**
 * The one part that talks to Google, so it can't be exercised without a billing account —
 * stub fetch and check the request we'd actually send.
 */
test('the metadata request asks for the nearest panorama, outdoor only', async () => {
  const s = stats();
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: URL) => {
    seen.push(String(url));
    return {
      ok: true,
      json: async () => ({
        status: 'OK',
        pano_id: 'PANO_ABC',
        location: { lat: -41.1, lng: 174.9 },
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const fetcher = googleMetadataFetcher('TEST_KEY', s);
    const hit = await fetcher({ lat: -41, lng: 175 }, 5000);
    assert.deepEqual(hit, { panoId: 'PANO_ABC', at: { lat: -41.1, lng: 174.9 } });
    assert.equal(s.metadataCalls, 1, 'counted for /api/health');

    const url = new URL(seen[0]!);
    assert.equal(url.pathname, '/maps/api/streetview/metadata');
    // Without a radius a random point almost never lands on a road (§7).
    assert.equal(url.searchParams.get('radius'), '5000');
    // Official car coverage only — photospheres are often indoors and unguessable.
    assert.equal(url.searchParams.get('source'), 'outdoor');
    assert.equal(url.searchParams.get('location'), '-41,175');
    assert.equal(url.searchParams.get('key'), 'TEST_KEY');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('ZERO_RESULTS is a miss, but other statuses are errors', async () => {
  const s = stats();
  const realFetch = globalThis.fetch;
  let status = 'ZERO_RESULTS';
  globalThis.fetch = (async () =>
    ({ ok: true, json: async () => ({ status }) }) as Response) as typeof fetch;

  try {
    const fetcher = googleMetadataFetcher('TEST_KEY', s);
    assert.equal(await fetcher({ lat: 0, lng: 0 }, 5000), null, 'ocean is just a miss');

    // A misconfigured key or exhausted quota must not look like ocean, or the pool would
    // retry forever and the real problem would stay invisible.
    status = 'REQUEST_DENIED';
    await assert.rejects(() => fetcher({ lat: 0, lng: 0 }, 5000), /REQUEST_DENIED/);
    status = 'OVER_QUERY_LIMIT';
    await assert.rejects(() => fetcher({ lat: 0, lng: 0 }, 5000), /OVER_QUERY_LIMIT/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the fixed source works with no key at all', () => {
  const source = new FixedLocationSource();
  const deck = source.take(ROUNDS_PER_GAME);
  assert.equal(deck.length, ROUNDS_PER_GAME);
  assert.ok(deck.every((l) => l.panoId.startsWith('dev:')), 'placeholder tokens');
  assert.equal(source.stats().source, 'fixed');
});

test('sampling is deterministic given a deterministic random source', async () => {
  const fetcher: MetadataFetcher = async (point) => ({ panoId: 'P', at: point });
  const first = await samplePanorama(ZONE_GROUPS, fetcher, stats(), sequence([0.1, 0.2, 0.3]));
  const second = await samplePanorama(ZONE_GROUPS, fetcher, stats(), sequence([0.1, 0.2, 0.3]));
  assert.deepEqual(first, second);
});
