/** Values fixed by ARCHITECTURE.md §1, §4, §5, §8. Both sides must agree on these. */

export const ROUNDS_PER_GAME = 5;

/** Each player's own clock, started on their panorama render (§5). */
export const ROUND_MS = 40_000;

/** Load headroom on top of ROUND_MS before the room's authoritative backstop fires (§5). */
export const LOAD_HEADROOM_MS = 6_000;

/** The room-owned backstop: 46s. One slow phone can't stall everyone else. */
export const ROOM_BACKSTOP_MS = ROUND_MS + LOAD_HEADROOM_MS;

/**
 * How long past a player's own 40s the server still waits on them, counted from when it heard
 * their clock start (§5). Covers the trip their last-second guess takes to arrive; past it,
 * a phone that went quiet — screen locked, app switched — stops holding the round up.
 */
export const CLOCK_SLACK_MS = 1_500;

export const MAX_PLAYERS = 20;

export const MAX_NAME_LENGTH = 16;

/**
 * How long the host's socket may be gone before the room is dropped (§4).
 * A locked phone or a few seconds of lost WiFi must not nuke the game.
 */
export const HOST_GRACE_MS = 30_000;

/**
 * How long a dropped player still counts as playing for the early-end check (§5). A screen
 * lock or a WiFi-to-4G handoff closes the socket and reconnects within a second or two, and
 * that blip must not end the round under them. Not applied when the heartbeat gave up on a
 * silent socket: that phone has already been gone this long.
 */
export const RECONNECT_GRACE_MS = 5_000;

/**
 * WebSocket close code for "this player connected again somewhere else" — a second tab or
 * device on the same sessionId. The replaced tab must not auto-reconnect, or the two take the
 * slot back from each other forever (§8).
 */
export const CLOSE_REPLACED = 4001;

/** Reaper thresholds (§8). */
export const EMPTY_ROOM_TTL_MS = 10 * 60_000;
export const IDLE_ROOM_TTL_MS = 2 * 60 * 60_000;
