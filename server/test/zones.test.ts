import assert from 'node:assert/strict';
import test from 'node:test';
import type { ZonePersistence } from '../src/zonePersistence';
import { ZoneStore, validateGroups } from '../src/zoneStore';
import type { Zone, ZoneGroup } from '../src/zones';

const zone: Zone = { id: 'nz-all', name: 'New Zealand', weight: 1, bbox: [-46.7, 166.4, -34.4, 178.6] };
const good: ZoneGroup[] = [{ id: 'nz', name: 'New Zealand', weight: 4, zones: [zone] }];

class MemoryPersistence implements ZonePersistence {
  saved: readonly ZoneGroup[] | null = null;
  failNext = false;
  constructor(private initial: unknown = null) {}
  describe() {
    return 'memory';
  }
  async load() {
    return this.initial;
  }
  async save(groups: readonly ZoneGroup[]) {
    if (this.failNext) throw new Error('store unavailable');
    this.saved = groups;
    this.initial = groups;
  }
}

test('validation rejects the shapes a form can produce', () => {
  const badZone = (patch: Partial<Zone>) => [{ ...good[0]!, zones: [{ ...zone, ...patch }] }];
  const cases: [string, unknown][] = [
    ['not an array', { id: 'nz' }],
    ['empty', []],
    ['bad group id', [{ ...good[0], id: 'New Zealand!' }]],
    ['missing group name', [{ ...good[0], name: '' }]],
    ['zero group weight', [{ ...good[0], weight: 0 }]],
    ['group with no zones', [{ ...good[0], zones: [] }]],
    ['bad zone id', badZone({ id: 'Nope!' })],
    ['zero zone weight', badZone({ weight: 0 })],
    ['short bbox', badZone({ bbox: [1, 2, 3] as unknown as Zone['bbox'] })],
    ['inverted lat', badZone({ bbox: [10, 0, -10, 20] })],
    ['inverted lng', badZone({ bbox: [-10, 20, 10, 0] })],
    ['lat out of range', badZone({ bbox: [-95, 0, 10, 20] })],
    ['lng out of range', badZone({ bbox: [-10, -200, 10, 20] })],
    ['duplicate group ids', [good[0], good[0]]],
    [
      'duplicate zone ids across groups',
      [good[0], { id: 'other', name: 'Other', weight: 1, zones: [zone] }],
    ],
  ];
  for (const [label, input] of cases) {
    const result = validateGroups(input);
    assert.equal(result.ok, false, `${label} should be rejected`);
  }

  const ok = validateGroups(good);
  assert.ok(ok.ok);
  assert.deepEqual(ok.groups, good);
});

test('a flat list of zones still loads, as one group each', () => {
  // The shape earlier saves and ZONES_JSON values use.
  const flat = [
    { id: 'nz', name: 'New Zealand', weight: 4, bbox: [-46.7, 166.4, -34.4, 178.6] },
    { id: 'jp', name: 'Japan', weight: 3, bbox: [31, 130, 45.5, 145.8] },
  ];
  const result = validateGroups(flat);
  assert.ok(result.ok);
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0]!.weight, 4, 'group keeps the old weight, so odds are unchanged');
  assert.equal(result.groups[0]!.zones.length, 1);
  assert.deepEqual(result.groups[0]!.zones[0]!.bbox, [-46.7, 166.4, -34.4, 178.6]);
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
  const result = await store.set([
    { id: 'bad', name: 'Bad', weight: 1, zones: [{ ...zone, bbox: [10, 0, -10, 5] }] },
  ]);
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
