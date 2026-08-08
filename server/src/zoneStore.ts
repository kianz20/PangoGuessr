import type { ZonePersistence } from './zonePersistence';
import { ZONES, type Zone } from './zones';

export type ZoneSource = 'default' | 'env' | 'admin' | 'stored';

export type ValidationResult = { ok: true; zones: Zone[] } | { ok: false; error: string };

/**
 * Holds the zone list the sampler draws from, and where it came from.
 *
 * Where zones come from, highest priority first:
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
  private zones: Zone[];
  private origin: ZoneSource;
  private listeners: (() => void)[] = [];
  private persistence: ZonePersistence | null = null;
  private lastSaveError: string | null = null;

  constructor(envJson = process.env.ZONES_JSON) {
    const fromEnv = envJson ? validateZones(safeParse(envJson)) : null;
    if (fromEnv?.ok) {
      this.zones = fromEnv.zones;
      this.origin = 'env';
      console.log(`[zones] loaded ${this.zones.length} zones from ZONES_JSON`);
    } else {
      if (fromEnv && !fromEnv.ok) {
        // Fall back rather than refuse to boot: a bad env var shouldn't take the game down.
        console.error(`[zones] ZONES_JSON ignored — ${fromEnv.error}`);
      }
      this.zones = ZONES.map((z) => ({ ...z }));
      this.origin = 'default';
    }
  }

  /**
   * Loads any saved zones before the server starts serving. A store that's down must not
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
      const result = validateZones(stored);
      if (!result.ok) {
        console.error(`[zones] stored zones ignored — ${result.error}`);
        return;
      }
      this.zones = result.zones;
      this.origin = 'stored';
      console.log(`[zones] loaded ${this.zones.length} zones from ${persistence.describe()}`);
    } catch (err) {
      console.error(`[zones] could not read ${persistence.describe()}:`, err);
    }
  }

  get(): readonly Zone[] {
    return this.zones;
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
    const result = validateZones(input);
    if (!result.ok) return result;

    this.zones = result.zones;
    this.origin = this.persistence ? 'stored' : 'admin';
    for (const listener of this.listeners) listener();

    if (!this.persistence) return { ...result, persisted: false };
    try {
      await this.persistence.save(result.zones);
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

  toJSON(): string {
    return JSON.stringify(this.zones, null, 2);
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Zones come from a browser form, so everything is checked: a bad bbox would otherwise
 * surface much later as a sampler that never finds coverage.
 */
export function validateZones(input: unknown): ValidationResult {
  if (!Array.isArray(input)) return { ok: false, error: 'expected an array of zones' };
  if (input.length === 0) return { ok: false, error: 'at least one zone is required' };

  const zones: Zone[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of input.entries()) {
    const where = `zone ${index + 1}`;
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: `${where}: not an object` };
    const candidate = raw as Record<string, unknown>;

    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (!/^[a-z0-9-]{1,24}$/.test(id)) {
      return { ok: false, error: `${where}: id must be 1–24 chars of a–z, 0–9 or -` };
    }
    if (seen.has(id)) return { ok: false, error: `duplicate zone id "${id}"` };
    seen.add(id);

    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    if (!name || name.length > 40) {
      return { ok: false, error: `${where}: name must be 1–40 characters` };
    }

    const weight = Number(candidate.weight);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) {
      return { ok: false, error: `${where}: weight must be between 0 and 100` };
    }

    const bbox = candidate.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((n) => Number.isFinite(Number(n)))) {
      return { ok: false, error: `${where}: bbox must be [south, west, north, east]` };
    }
    const [south, west, north, east] = bbox.map(Number) as [number, number, number, number];
    if (south >= north) return { ok: false, error: `${where}: south must be below north` };
    if (west >= east) return { ok: false, error: `${where}: west must be below east` };
    if (south < -85 || north > 85) return { ok: false, error: `${where}: latitude out of range` };
    if (west < -180 || east > 180) return { ok: false, error: `${where}: longitude out of range` };

    zones.push({ id, name, weight, bbox: [south, west, north, east] });
  }

  return { ok: true, zones };
}
