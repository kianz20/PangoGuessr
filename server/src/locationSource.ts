import type { LatLng } from '@pangoguessr/shared';
import { FIXED_LOCATIONS, dealLocations } from './locations';
import { describeLocation } from './places';
import { googleMetadataFetcher, samplePanorama, type MetadataFetcher, type SampleStats } from './streetview';
import { ZONE_GROUPS, type ZoneGroup } from './zones';

export type RoundLocation = {
  id: string;
  /** Shown on the reveal only — the nearest settlement, or the zone if there isn't one. */
  name: string;
  at: LatLng;
  panoId: string;
};

export interface LocationSource {
  /** Sync on purpose: the room's phase transitions stay synchronous and testable. */
  take(count: number): RoundLocation[] | null;
  /**
   * Waits for `count` locations instead of refusing. A room deals its deck this way as soon
   * as it's created — the earliest moment we know sampling is worth doing, with a lobby's
   * worth of time before anyone presses Start — so phones can preload the panoramas (§7).
   * Resolves null if sampling is failing; the room then falls back to `take` at Start.
   */
  deal?(count: number): Promise<RoundLocation[] | null>;
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
/** The country it came from stays with the pool, so a deck can avoid repeating one. */
type PooledLocation = RoundLocation & { groupId: string };

/** How long to wait after a refill failure before trying again, so a bad key doesn't spin. */
const BACKOFF_MS = 30_000;

/**
 * A pool of pre-validated panoramas, refilled in the background (§7). Metadata retries take
 * real time — a handful of round-trips before a hit is normal — and doing that at
 * `startRound` would mean players staring at a blank screen. Metadata calls are free, so
 * over-fetching costs nothing but time the server has spare.
 */
export class PooledLocationSource implements LocationSource {
  private readonly pool: PooledLocation[] = [];
  /**
   * The in-flight refill, not a boolean: callers must be able to *await* a refill that is
   * already running. A boolean made `warm()` return while the pool was still nearly empty.
   */
  private inFlight: Promise<void> | null = null;
  private pausedUntil = 0;
  private lastError: string | null = null;
  /** Zones that searched to exhaustion without coverage; forgotten when the zones change. */
  private readonly deadZones = new Set<string>();
  /** Bumped by `clear()`, so a refill still running for the old zones can't land its results. */
  private generation = 0;

  constructor(
    private readonly fetcher: MetadataFetcher,
    /** Shared with the fetcher, so /api/health reports the calls actually made. */
    private readonly sampleStats: SampleStats = { metadataCalls: 0, misses: 0 },
    /** A provider, not a fixed array: the admin screen can change zones at runtime. */
    private readonly zonesOf: () => readonly ZoneGroup[] = () => ZONE_GROUPS,
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
    this.deadZones.clear();
    this.generation++;
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
    const taken = this.takeDistinct(count);
    void this.refill();
    return taken;
  }

  async deal(count: number): Promise<RoundLocation[] | null> {
    // Bounded, because several rooms can be waiting on one refill: whoever resumes first
    // takes a deck, and the rest find the pool short again and wait for the next one.
    for (let attempt = 0; attempt < 5; attempt++) {
      const taken = this.take(count);
      if (taken) return taken;
      await this.refill();
      // A refill that failed is backing off. Waiting that out would leave the lobby with no
      // deck and no word why; Start reports it instead.
      if (this.pool.length < count && this.lastError) return null;
    }
    return null;
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

  /**
   * Oldest first, but skipping a country already in the deck while another is available.
   * Drawing rounds independently by weight repeats a country in most games, which is what
   * makes a run of five feel anything but random.
   */
  private takeDistinct(count: number): RoundLocation[] {
    const picked: number[] = [];
    const groups = new Set<string>();
    for (let i = 0; i < this.pool.length && picked.length < count; i++) {
      if (groups.has(this.pool[i]!.groupId)) continue;
      groups.add(this.pool[i]!.groupId);
      picked.push(i);
    }
    // Not enough countries to go round: make up the numbers in pool order.
    for (let i = 0; i < this.pool.length && picked.length < count; i++) {
      if (!picked.includes(i)) picked.push(i);
    }
    const taken = picked.map((i) => {
      const { groupId: _groupId, ...location } = this.pool[i]!;
      return location;
    });
    for (const i of [...picked].sort((a, b) => b - a)) this.pool.splice(i, 1);
    return taken;
  }

  /**
   * Every missing slot is searched at once. Done one after another, a cold pool took a
   * round-trip chain per slot — the lobby's "finding locations" wait — for no reason.
   */
  private async runRefill(): Promise<void> {
    const generation = this.generation;
    let failed = false;
    const cancelled = () => failed || generation !== this.generation;
    /** Countries other slots are searching right now, so they don't all land on one. */
    const searching: string[] = [];

    const fillSlot = async (): Promise<void> => {
      while (!cancelled() && this.pool.length < this.target) {
        // Countries already held or being searched, so the next deck can be five different ones.
        const avoidGroups = new Set([...this.pool.map((location) => location.groupId), ...searching]);
        let drawn: string | null = null;
        const hit = await samplePanorama(this.zonesOf(), this.fetcher, this.sampleStats, Math.random, {
          avoidGroups,
          deadZones: this.deadZones,
          cancelled,
          onDraw: (groupId) => {
            if (drawn !== null) searching.splice(searching.indexOf(drawn), 1);
            searching.push((drawn = groupId));
          },
        }).finally(() => {
          if (drawn !== null) searching.splice(searching.indexOf(drawn), 1);
        });
        if (cancelled()) return;
        if (!hit) {
          failed = true;
          this.lastError = 'sampling found no coverage';
          this.pausedUntil = Date.now() + BACKOFF_MS;
          return;
        }
        // Two slots searching one zone can land on the same panorama; search again.
        if (this.pool.some((location) => location.panoId === hit.panoId)) continue;
        this.pool.push({
          // Panorama IDs are stable, so this doubles as a dedupe key within the pool.
          id: hit.panoId,
          // The nearest settlement is far more satisfying on the reveal than the zone it was
          // drawn from, but somewhere genuinely remote has no useful name — hence the fallback.
          name: describeLocation(hit.at) ?? hit.zoneName,
          at: hit.at,
          panoId: hit.panoId,
          groupId: hit.groupId,
        });
        this.lastError = null;
        return;
      }
    };

    try {
      const missing = Math.max(this.target - this.pool.length, 0);
      await Promise.all(Array.from({ length: missing }, fillSlot));
    } catch (err) {
      // A denied key or exhausted quota must not turn into a hot retry loop.
      failed = true;
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
  zonesOf: () => readonly ZoneGroup[] = () => ZONE_GROUPS,
): LocationSource {
  if (!serverKey) {
    console.log('[locations] no GOOGLE_MAPS_SERVER_KEY — using the fixed list and placeholder viewer');
    return new FixedLocationSource();
  }
  const stats: SampleStats = { metadataCalls: 0, misses: 0 };
  const pool = new PooledLocationSource(googleMetadataFetcher(serverKey, stats), stats, zonesOf);
  // Deliberately NOT warmed at boot. The free tier wakes on any request — including health
  // checks and idle pings — and sampling on every wake burns daily quota for games nobody
  // is playing. The pool fills when a room is created and deals its first deck instead.
  console.log(`[locations] Street View sampling active, pool fills when a room is created`);
  return pool;
}
