import type { ZonePersistence } from './zonePersistence';
import { ZONE_GROUPS, type Zone, type ZoneGroup } from './zones';

export type ZoneSource = 'default' | 'env' | 'admin' | 'stored';

export type ValidationResult = { ok: true; groups: ZoneGroup[] } | { ok: false; error: string };

/**
 * Holds the zone groups the sampler draws from, and where they came from.
 *
 * Where they come from, highest priority first:
 *
 *  - **stored** — saved from `/admin` to a KV store, if one is configured. Survives
 *    restarts, so an edit made once stays made.
 *  - **admin** — applied live from `/admin` with no store configured. Takes effect on the
 *    next game but is lost when the server restarts (on the free tier, every spin-down).
 *  - **env** — `ZONES_JSON` in the environment. Durable with no store at all; the admin
 *    screen produces the JSON to paste in.
 *  - **default** — the hand-written list in zones.ts, versioned with the code.
 */
export class ZoneStore {
  private groups: ZoneGroup[];
  private origin: ZoneSource;
  private listeners: (() => void)[] = [];
  private persistence: ZonePersistence | null = null;
  private lastSaveError: string | null = null;

  constructor(envJson = process.env.ZONES_JSON) {
    const fromEnv = envJson ? validateGroups(safeParse(envJson)) : null;
    if (fromEnv?.ok) {
      this.groups = fromEnv.groups;
      this.origin = 'env';
      console.log(`[zones] loaded ${this.groups.length} groups from ZONES_JSON`);
    } else {
      if (fromEnv && !fromEnv.ok) {
        // Fall back rather than refuse to boot: a bad env var shouldn't take the game down.
        console.error(`[zones] ZONES_JSON ignored — ${fromEnv.error}`);
      }
      this.groups = clone(ZONE_GROUPS);
      this.origin = 'default';
    }
  }

  /**
   * Loads any saved groups before the server starts serving. A store that's down must not
   * stop the game booting — it just means today's games use the built-in list.
   */
  async attach(persistence: ZonePersistence | null): Promise<void> {
    this.persistence = persistence;
    if (!persistence) return;
    try {
      const stored = await persistence.load();
      if (stored === null) {
        console.log(`[zones] ${persistence.describe()} has nothing saved yet`);
        return;
      }
      const result = validateGroups(stored);
      if (!result.ok) {
        console.error(`[zones] stored zones ignored — ${result.error}`);
        return;
      }
      this.groups = result.groups;
      this.origin = 'stored';
      console.log(`[zones] loaded ${this.groups.length} groups from ${persistence.describe()}`);
    } catch (err) {
      console.error(`[zones] could not read ${persistence.describe()}:`, err);
    }
  }

  get(): readonly ZoneGroup[] {
    return this.groups;
  }

  zoneCount(): number {
    return this.groups.reduce((sum, group) => sum + group.zones.length, 0);
  }

  source(): ZoneSource {
    return this.origin;
  }

  persistenceLabel(): string {
    return this.persistence?.describe() ?? 'none';
  }

  saveError(): string | null {
    return this.lastSaveError;
  }

  /**
   * Replaces the list wholesale. Callers get validation errors back, not exceptions.
   *
   * Applies in memory first and only then writes: an edit should take effect even if the
   * store is unreachable, with the failure reported rather than swallowed.
   */
  async set(input: unknown): Promise<ValidationResult & { persisted?: boolean }> {
    const result = validateGroups(input);
    if (!result.ok) return result;

    this.groups = result.groups;
    this.origin = this.persistence ? 'stored' : 'admin';
    for (const listener of this.listeners) listener();

    if (!this.persistence) return { ...result, persisted: false };
    try {
      await this.persistence.save(result.groups);
      this.lastSaveError = null;
      return { ...result, persisted: true };
    } catch (err) {
      this.lastSaveError = err instanceof Error ? err.message : String(err);
      console.error('[zones] save failed:', this.lastSaveError);
      this.origin = 'admin';
      return { ...result, persisted: false };
    }
  }

  /** So the location pool can drop panoramas sampled from zones that no longer exist. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }
}

function clone(groups: readonly ZoneGroup[]): ZoneGroup[] {
  return groups.map((group) => ({ ...group, zones: group.zones.map((zone) => ({ ...zone })) }));
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const ID_PATTERN = /^[a-z0-9-]{1,32}$/;

function validateId(value: unknown, where: string): string | { error: string } {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!ID_PATTERN.test(id)) {
    return { error: `${where}: id must be 1–32 chars of a–z, 0–9 or -` };
  }
  return id;
}

function validateWeight(value: unknown, where: string): number | { error: string } {
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100) {
    return { error: `${where}: weight must be between 0 and 100` };
  }
  return weight;
}

function validateZone(raw: unknown, where: string): Zone | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: `${where}: not an object` };
  const candidate = raw as Record<string, unknown>;

  const id = validateId(candidate.id, where);
  if (typeof id !== 'string') return id;

  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  if (!name || name.length > 40) return { error: `${where}: name must be 1–40 characters` };

  const weight = validateWeight(candidate.weight, where);
  if (typeof weight !== 'number') return weight;

  const bbox = candidate.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((n) => Number.isFinite(Number(n)))) {
    return { error: `${where}: bbox must be [south, west, north, east]` };
  }
  const [south, west, north, east] = bbox.map(Number) as [number, number, number, number];
  if (south >= north) return { error: `${where}: south must be below north` };
  if (west >= east) return { error: `${where}: west must be below east` };
  if (south < -85 || north > 85) return { error: `${where}: latitude out of range` };
  if (west < -180 || east > 180) return { error: `${where}: longitude out of range` };

  return { id, name, weight, bbox: [south, west, north, east] };
}

/**
 * Accepts either the current shape (groups of zones) or a bare list of zones, which is what
 * earlier saves and `ZONES_JSON` values contain — each becomes a group of one, preserving
 * the odds exactly.
 *
 * Everything is checked because it arrives from a browser form: a bad bbox would otherwise
 * surface much later as a sampler that never finds coverage.
 */
export function validateGroups(input: unknown): ValidationResult {
  if (!Array.isArray(input)) return { ok: false, error: 'expected an array' };
  if (input.length === 0) return { ok: false, error: 'at least one group is required' };

  const looksFlat = input.every(
    (item) => typeof item === 'object' && item !== null && 'bbox' in (item as object),
  );
  if (looksFlat) {
    const wrapped = input.map((zone) => {
      const candidate = zone as Record<string, unknown>;
      return {
        id: candidate.id,
        name: candidate.name,
        weight: candidate.weight,
        zones: [{ ...candidate, weight: 1 }],
      };
    });
    return validateGroups(wrapped);
  }

  const groups: ZoneGroup[] = [];
  const groupIds = new Set<string>();
  const zoneIds = new Set<string>();

  for (const [index, raw] of input.entries()) {
    const where = `group ${index + 1}`;
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: `${where}: not an object` };
    const candidate = raw as Record<string, unknown>;

    const id = validateId(candidate.id, where);
    if (typeof id !== 'string') return { ok: false, error: id.error };
    if (groupIds.has(id)) return { ok: false, error: `duplicate group id "${id}"` };
    groupIds.add(id);

    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    if (!name || name.length > 40) {
      return { ok: false, error: `${where}: name must be 1–40 characters` };
    }

    const weight = validateWeight(candidate.weight, where);
    if (typeof weight !== 'number') return { ok: false, error: weight.error };

    if (!Array.isArray(candidate.zones) || candidate.zones.length === 0) {
      return { ok: false, error: `${where} ("${name}"): needs at least one zone` };
    }

    const zones: Zone[] = [];
    for (const [zoneIndex, rawZone] of candidate.zones.entries()) {
      const zone = validateZone(rawZone, `${where} zone ${zoneIndex + 1}`);
      if ('error' in zone) return { ok: false, error: zone.error };
      // Zone ids must be unique across the whole list, not just within a group: the pool
      // keys locations by them.
      if (zoneIds.has(zone.id)) return { ok: false, error: `duplicate zone id "${zone.id}"` };
      zoneIds.add(zone.id);
      zones.push(zone);
    }

    groups.push({ id, name, weight, zones });
  }

  return { ok: true, groups };
}
