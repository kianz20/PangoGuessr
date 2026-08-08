import assert from 'node:assert/strict';
import test from 'node:test';
import { haversineKm } from '@pangoguessr/shared';

/** Published great-circle distances, to within 1%. */
const KNOWN: [string, { lat: number; lng: number }, { lat: number; lng: number }, number][] = [
  ['London → New York', { lat: 51.5074, lng: -0.1278 }, { lat: 40.7128, lng: -74.006 }, 5570],
  ['Auckland → Los Angeles', { lat: -36.8485, lng: 174.7633 }, { lat: 33.9416, lng: -118.4085 }, 10490],
  ['Wellington → London', { lat: -41.2887, lng: 174.7772 }, { lat: 51.5074, lng: -0.1278 }, 18814],
  ['Sydney → Santiago', { lat: -33.8688, lng: 151.2093 }, { lat: -33.4489, lng: -70.6693 }, 11350],
];

test('distances match published great-circle figures', () => {
  for (const [label, a, b, expected] of KNOWN) {
    const actual = haversineKm(a, b);
    const errorPct = (Math.abs(actual - expected) / expected) * 100;
    assert.ok(errorPct < 1, `${label}: got ${actual.toFixed(0)}km, expected ~${expected}km`);
  }
});

test('the shortest way round is taken, including across the dateline', () => {
  // 2 degrees apart on the equator, but 358 degrees apart if you only subtract longitudes.
  const acrossDateline = haversineKm({ lat: 0, lng: 179 }, { lat: 0, lng: -179 });
  assert.ok(Math.abs(acrossDateline - 222.6) < 3, `expected ~222km, got ${acrossDateline.toFixed(0)}`);

  // The same for a realistic pairing: New Zealand and Fiji sit either side of 180°.
  const nzToFiji = haversineKm({ lat: -36.85, lng: 174.76 }, { lat: -18.14, lng: 178.44 });
  assert.ok(nzToFiji < 2600, `NZ → Fiji should be ~2150km, got ${nzToFiji.toFixed(0)}`);

  // A guess just west of the dateline against an answer just east of it must not be scored
  // as if it were most of the way round the planet.
  const nearMiss = haversineKm({ lat: -41, lng: 179.9 }, { lat: -41, lng: -179.9 });
  assert.ok(nearMiss < 20, `expected a few km, got ${nearMiss.toFixed(0)}`);
});

test('distance is symmetric', () => {
  for (const [label, a, b] of KNOWN) {
    assert.equal(haversineKm(a, b), haversineKm(b, a), `${label} must be the same both ways`);
  }
  assert.equal(
    haversineKm({ lat: 0, lng: 179 }, { lat: 0, lng: -179 }),
    haversineKm({ lat: 0, lng: -179 }, { lat: 0, lng: 179 }),
  );
});

test('the extremes behave', () => {
  const half = Math.PI * 6371; // half the circumference
  assert.equal(haversineKm({ lat: 5, lng: 5 }, { lat: 5, lng: 5 }), 0, 'identical points');
  const antipodal = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
  assert.ok(Math.abs(antipodal - half) < 5, `antipodal should be ~${half.toFixed(0)}km`);
  const poles = haversineKm({ lat: 90, lng: 0 }, { lat: -90, lng: 0 });
  assert.ok(Math.abs(poles - half) < 5, 'pole to pole is half the circumference');
  // Floating point can push the argument of asin just past 1 for antipodal points.
  assert.ok(Number.isFinite(haversineKm({ lat: 90, lng: 0 }, { lat: -90, lng: 180 })));
});
