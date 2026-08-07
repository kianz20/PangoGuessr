/** Values fixed by ARCHITECTURE.md §1, §4, §5, §8. Both sides must agree on these. */

export const ROUNDS_PER_GAME = 5;

/** Each player's own clock, started on their panorama render (§5). */
export const ROUND_MS = 40_000;

/** Load headroom on top of ROUND_MS before the room's authoritative backstop fires (§5). */
export const LOAD_HEADROOM_MS = 6_000;

/** The room-owned backstop: 46s. One slow phone can't stall everyone else. */
export const ROOM_BACKSTOP_MS = ROUND_MS + LOAD_HEADROOM_MS;

export const MAX_PLAYERS = 20;

export const MAX_NAME_LENGTH = 16;

/**
 * How long the host's socket may be gone before the room is dropped (§4).
 * A locked phone or a few seconds of lost WiFi must not nuke the game.
 */
export const HOST_GRACE_MS = 30_000;

/** Reaper thresholds (§8). */
export const EMPTY_ROOM_TTL_MS = 10 * 60_000;
export const IDLE_ROOM_TTL_MS = 2 * 60 * 60_000;
