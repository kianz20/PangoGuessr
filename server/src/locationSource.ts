import type { LatLng } from '@pangoguessr/shared';
import { FIXED_LOCATIONS, dealLocations } from './locations';
import { googleMetadataFetcher, samplePanorama, type MetadataFetcher, type SampleStats } from './streetview';
import { ZONES, type Zone } from './zones';

export type RoundLocation = {
  id: string;
  /** Shown on the reveal only. With real sampling this is the zone, not a street address. */
  name: string;
  at: LatLng;
  panoId: string;
};

export interface LocationSource {
  /** Sync on purpose: the room's phase transitions stay synchronous and testable. */
  take(count: number): RoundLocation[] | null;
  /**
   * "Someone is about to play." Called when a room is created, which is the earliest
   * moment we know sampling is worth doing — and there's a lobby's worth of time before
   * anyone presses Start.
   */
  prewarm?(): void;
  stats(): Record<string, number | string>;
}

/**
 * No API key configured: the hand-picked list from step 2, with placeholder panorama tokens
 * the client renders as a stand-in. Keeps the whole game runnable — and testable — without
 * a billing account.
 */
export class FixedLocationSource implements LocationSource {
  take(count: number): RoundLocation[] {
    return dealLocations(count).map((location) => ({
      id: location.id,
      name: location.name,
      at: location.at,
      panoId: `dev:${location.id}`,
    }));
  }

  stats() {
    return { source: 'fixed', available: FIXED_LOCATIONS.length };
  }
}

/**
 * A game needs 5. Holding 8 covers a game plus the start of a replay while the background
 * refill catches up.
 *
 * Deliberately not 20: metadata is free of *charge* but still consumes daily API quota, and
 * on Render's free tier the server spins down after ~15 minutes idle — so every wake would
 * re-sample the whole pool from scratch. A big target turns idle time into quota burn.
 */
const POOL_TARGET = 8;
/** How long to wait after a refill failure before trying again, so a bad key doesn't spin. */
const BACKOFF_MS = 30_000;

/**
 * A pool of pre-validated panoramas, refilled in the background (§7). Metadata retries take
 * real time — a handful of round-trips before a hit is normal — and doing that at
 * `startRound` would mean players staring at a blank screen. Metadata calls are free, so
 * over-fetching costs nothing but time the server has spare.
 */
export class PooledLocationSource implements LocationSource {
  private readonly pool: RoundLocation[] = [];
  /**
   * The in-flight refill, not a boolean: callers must be able to *await* a refill that is
   * already running. A boolean made `warm()` return while the pool was still nearly empty.
   */
  private inFlight: Promise<void> | null = null;
  private pausedUntil = 0;
  private lastError: string | null = null;

  constructor(
    private readonly fetcher: MetadataFetcher,
    /** Shared with the fetcher, so /api/health reports the calls actually made. */
    private readonly sampleStats: SampleStats = { metadataCalls: 0, misses: 0 },
    /** A provider, not a fixed array: the admin screen can change zones at runtime. */
    private readonly zonesOf: () => readonly Zone[] = () => ZONES,
    private readonly target = POOL_TARGET,
  ) {}

  /**
   * Drops everything currently held. Called when the zone list changes, so panoramas
   * sampled from a zone that no longer exists don't turn up in the next game.
   */
  clear(): void {
    this.pool.length = 0;
    this.pausedUntil = 0;
    this.lastError = null;
  }

  get size(): number {
    return this.pool.length;
  }

  take(count: number): RoundLocation[] | null {
    // Refuse rather than block: the caller turns this into "still finding locations, try
    // again in a moment" instead of a hung Start button.
    if (this.pool.length < count) {
      void this.refill();
      return null;
    }
    const taken = this.pool.splice(0, count);
    void this.refill();
    return taken;
  }

  /** Fire-and-forget top-up, triggered by a room being created. */
  prewarm(): void {
    void this.refill();
  }

  /** Awaitable version, for the checker script and tests. */
  async warm(): Promise<void> {
    await this.refill();
  }

  private refill(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (Date.now() < this.pausedUntil) return Promise.resolve();
    this.inFlight = this.runRefill().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runRefill(): Promise<void> {
    try {
      while (this.pool.length < this.target) {
        const hit = await samplePanorama(this.zonesOf(), this.fetcher, this.sampleStats);
        if (!hit) {
          this.lastError = 'sampling found no coverage';
          this.pausedUntil = Date.now() + BACKOFF_MS;
          return;
        }
        this.pool.push({
          // Panorama IDs are stable, so this doubles as a dedupe key within the pool.
          id: hit.panoId,
          name: hit.zoneName,
          at: hit.at,
          panoId: hit.panoId,
        });
        this.lastError = null;
      }
    } catch (err) {
      // A denied key or exhausted quota must not turn into a hot retry loop.
      this.lastError = err instanceof Error ? err.message : String(err);
      this.pausedUntil = Date.now() + BACKOFF_MS;
      console.error('[pool] refill failed:', this.lastError);
    }
  }

  stats() {
    return {
      source: 'streetview',
      poolSize: this.pool.length,
      target: this.target,
      metadataCalls: this.sampleStats.metadataCalls,
      misses: this.sampleStats.misses,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}

export function createLocationSource(
  serverKey: string | undefined,
  zonesOf: () => readonly Zone[] = () => ZONES,
): LocationSource {
  if (!serverKey) {
    console.log('[locations] no GOOGLE_MAPS_SERVER_KEY — using the fixed list and placeholder viewer');
    return new FixedLocationSource();
  }
  const stats: SampleStats = { metadataCalls: 0, misses: 0 };
  const pool = new PooledLocationSource(googleMetadataFetcher(serverKey, stats), stats, zonesOf);
  // Deliberately NOT warmed at boot. The free tier wakes on any request — including health
  // checks and idle pings — and sampling on every wake burns daily quota for games nobody
  // is playing. The pool fills when a room is created instead.
  console.log(`[locations] Street View sampling active, pool fills when a room is created`);
  return pool;
}
