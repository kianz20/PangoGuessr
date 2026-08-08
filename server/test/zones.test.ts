import assert from 'node:assert/strict';
import test from 'node:test';
import type { ZonePersistence } from '../src/zonePersistence';
import { ZoneStore, validateZones } from '../src/zoneStore';
import type { Zone } from '../src/zones';

const good: Zone[] = [{ id: 'nz', name: 'New Zealand', weight: 4, bbox: [-46.7, 166.4, -34.4, 178.6] }];

class MemoryPersistence implements ZonePersistence {
  saved: readonly Zone[] | null = null;
  failNext = false;
  constructor(private initial: unknown = null) {}
  describe() {
    return 'memory';
  }
  async load() {
    return this.initial;
  }
  async save(zones: readonly Zone[]) {
    if (this.failNext) throw new Error('store unavailable');
    this.saved = zones;
    this.initial = zones;
  }
}

test('validation rejects the shapes a form can produce', () => {
  const cases: [string, unknown][] = [
    ['not an array', { id: 'nz' }],
    ['empty', []],
    ['bad id', [{ ...good[0], id: 'New Zealand!' }]],
    ['missing name', [{ ...good[0], name: '' }]],
    ['zero weight', [{ ...good[0], weight: 0 }]],
    ['short bbox', [{ ...good[0], bbox: [1, 2, 3] }]],
    ['inverted lat', [{ ...good[0], bbox: [10, 0, -10, 20] }]],
    ['inverted lng', [{ ...good[0], bbox: [-10, 20, 10, 0] }]],
    ['lat out of range', [{ ...good[0], bbox: [-95, 0, 10, 20] }]],
    ['lng out of range', [{ ...good[0], bbox: [-10, -200, 10, 20] }]],
    ['duplicate ids', [good[0], good[0]]],
  ];
  for (const [label, input] of cases) {
    const result = validateZones(input);
    assert.equal(result.ok, false, `${label} should be rejected`);
  }

  const ok = validateZones(good);
  assert.ok(ok.ok);
  assert.deepEqual(ok.zones, good);
});

test('a bad ZONES_JSON is ignored rather than taking the game down', () => {
  const store = new ZoneStore('{ not json');
  assert.equal(store.source(), 'default');
  assert.ok(store.get().length > 0);

  const invalid = new ZoneStore(JSON.stringify([{ id: 'x' }]));
  assert.equal(invalid.source(), 'default');
});

test('ZONES_JSON overrides the built-in list', () => {
  const store = new ZoneStore(JSON.stringify(good));
  assert.equal(store.source(), 'env');
  assert.deepEqual(store.get(), good);
});

test('saved zones are loaded at boot and survive a restart', async () => {
  const persistence = new MemoryPersistence(good);
  const store = new ZoneStore(undefined);
  await store.attach(persistence);
  assert.equal(store.source(), 'stored');
  assert.deepEqual(store.get(), good);

  // A "restart": a brand new store reading the same place.
  const afterRestart = new ZoneStore(undefined);
  await afterRestart.attach(persistence);
  assert.deepEqual(afterRestart.get(), good, 'edits outlive the process');
});

test('an edit is applied even when the store is unreachable, and reported', async () => {
  const persistence = new MemoryPersistence(null);
  const store = new ZoneStore(undefined);
  await store.attach(persistence);

  persistence.failNext = true;
  const result = await store.set(good);
  assert.ok(result.ok);
  assert.equal(result.persisted, false, 'the caller learns it was not saved');
  assert.deepEqual(store.get(), good, 'but the change still took effect');
  assert.equal(store.source(), 'admin', 'not claimed as stored');
  assert.match(String(store.saveError()), /unavailable/);
});

test('a rejected edit changes nothing', async () => {
  const store = new ZoneStore(undefined);
  const before = [...store.get()];
  const result = await store.set([{ id: 'bad', name: 'Bad', weight: 1, bbox: [10, 0, -10, 5] }]);
  assert.equal(result.ok, false);
  assert.deepEqual(store.get(), before);
});

test('changing zones notifies listeners so the pool can be cleared', async () => {
  const store = new ZoneStore(undefined);
  let notified = 0;
  store.onChange(() => notified++);
  await store.set(good);
  assert.equal(notified, 1);
});
