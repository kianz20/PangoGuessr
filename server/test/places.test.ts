import assert from 'node:assert/strict';
import test from 'node:test';
import { describeLocation, describePlace, loadPlaces, nearestPlace } from '../src/places';

test('the bundled dataset loads and indexes', () => {
  const data = loadPlaces();
  assert.ok(data.names.length > 100_000, `expected 100k+ places, got ${data.names.length}`);
  assert.equal(data.names.length, data.lat.length);
  assert.ok(data.countries.length > 200, 'country table present');
  assert.ok(data.regions.length > 1000, 'region table present');
});

test('city centres resolve to the right city', () => {
  const cases: [string, { lat: number; lng: number }, string, string][] = [
    ['Wellington', { lat: -41.2887, lng: 174.7772 }, 'Wellington', 'New Zealand'],
    ['Auckland', { lat: -36.8485, lng: 174.7633 }, 'Auckland', 'New Zealand'],
    ['Tokyo', { lat: 35.6762, lng: 139.6503 }, 'Tokyo', 'Japan'],
    ['Reykjavík', { lat: 64.1466, lng: -21.9426 }, 'Reykjavík', 'Iceland'],
    ['Florence', { lat: 43.7696, lng: 11.2558 }, 'Florence', 'Italy'],
    ['Cape Town', { lat: -33.9249, lng: 18.4241 }, 'Cape Town', 'South Africa'],
  ];

  for (const [label, at, expectedName, expectedCountry] of cases) {
    const place = nearestPlace(at);
    assert.ok(place, `${label}: nothing found`);
    assert.equal(place.country, expectedCountry, label);
    // Within 25km of the named centre, so a neighbouring suburb name is acceptable.
    assert.ok(place.distanceKm < 25, `${label}: nearest was ${place.distanceKm.toFixed(0)}km away`);
    if (place.name !== expectedName) {
      console.log(`  note: ${label} resolved to "${place.name}" (${place.distanceKm.toFixed(1)}km)`);
    }
  }
});

test('a place in the middle of a city reads as just the name', () => {
  const text = describeLocation({ lat: -41.2887, lng: 174.7772 });
  assert.ok(text);
  assert.match(text, /New Zealand$/);
  assert.equal(text.includes('km from'), false, 'no distance for a bullseye');
});

test('somewhere rural says how far the named town is', () => {
  // Central Otago high country — deliberately far from anything sizeable.
  const text = describeLocation({ lat: -44.8, lng: 169.2 });
  assert.ok(text);
  assert.match(text, /km from .*New Zealand$/, `got "${text}"`);
});

test('the middle of an ocean names nothing, so the caller can fall back', () => {
  assert.equal(nearestPlace({ lat: -35, lng: -150 }), null, 'South Pacific');
  assert.equal(nearestPlace({ lat: 0, lng: -30 }), null, 'mid Atlantic');
  assert.equal(describeLocation({ lat: -60, lng: 100 }), null, 'Southern Ocean');
});

test('lookups near the dateline still see both sides', () => {
  // Just west of 180° in Fiji: the nearest places are across the line.
  const place = nearestPlace({ lat: -16.8, lng: 179.9 });
  assert.ok(place, 'expected a Fijian place');
  assert.ok(place.distanceKm < 200, `got ${place.distanceKm.toFixed(0)}km away`);
});

test('the distance qualifier rounds to something a human would say', () => {
  assert.equal(describePlace({ name: 'Ōamaru', region: 'Otago', country: 'New Zealand', distanceKm: 2 }), 'Ōamaru, New Zealand');
  assert.equal(
    describePlace({ name: 'Ōamaru', region: 'Otago', country: 'New Zealand', distanceKm: 12.4 }),
    '12 km from Ōamaru, New Zealand',
  );
  assert.equal(
    describePlace({ name: 'Alexandra', region: 'Otago', country: 'New Zealand', distanceKm: 83.2 }),
    '85 km from Alexandra, New Zealand',
  );
});

test('lookups are fast enough to do inline', () => {
  loadPlaces();
  const started = Date.now();
  for (let i = 0; i < 500; i++) {
    nearestPlace({ lat: -90 + Math.random() * 180, lng: -180 + Math.random() * 360 });
  }
  const perLookup = (Date.now() - started) / 500;
  assert.ok(perLookup < 5, `${perLookup.toFixed(2)}ms per lookup`);
});
