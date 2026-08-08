import type { Zone } from './zones';

/**
 * Somewhere zone edits can be written so they survive a restart.
 *
 * Render's free tier has an ephemeral filesystem — wiped on redeploy *and* on every
 * spin-down — so a local file is not an option (§7). Anything durable has to be off-box.
 */
export interface ZonePersistence {
  load(): Promise<unknown | null>;
  save(zones: readonly Zone[]): Promise<void>;
  describe(): string;
}

const KEY = 'pangoguessr:zones';

/**
 * Any Redis-compatible HTTP KV with an Upstash-style REST API: `GET {base}/get/{key}` and
 * `POST {base}/set/{key}` with the value as the body, both bearer-authenticated. Chosen
 * because it needs no persistent connection — which matters on a service that sleeps.
 */
class HttpKvPersistence implements ZonePersistence {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  describe(): string {
    return `http-kv (${new URL(this.base).host})`;
  }

  async load(): Promise<unknown | null> {
    const response = await fetch(`${this.base}/get/${encodeURIComponent(KEY)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`KV load failed: HTTP ${response.status}`);
    const body = (await response.json()) as { result?: string | null };
    if (!body.result) return null;
    return JSON.parse(body.result) as unknown;
  }

  async save(zones: readonly Zone[]): Promise<void> {
    const response = await fetch(`${this.base}/set/${encodeURIComponent(KEY)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify(zones),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`KV save failed: HTTP ${response.status}`);
  }
}

export function createZonePersistence(
  base = process.env.ZONES_KV_URL,
  token = process.env.ZONES_KV_TOKEN,
): ZonePersistence | null {
  if (!base || !token) return null;
  return new HttpKvPersistence(base.replace(/\/$/, ''), token);
}
