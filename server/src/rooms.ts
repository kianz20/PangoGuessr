import { randomUUID } from 'node:crypto';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  EMPTY_ROOM_TTL_MS,
  HOST_GRACE_MS,
  IDLE_ROOM_TTL_MS,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  ROOM_BACKSTOP_MS,
  ROUND_MS,
  ROUNDS_PER_GAME,
  haversineKm,
  normalizeCode,
  rankByScore,
  scoreGuess,
} from '@pangoguessr/shared';
import type {
  ErrorCode,
  GuessResult,
  LatLng,
  LeaderboardRow,
  Phase,
  PublicPlayer,
  RoomClosedReason,
  RoundSnapshot,
  ServerMessage,
} from '@pangoguessr/shared';
import { dealLocations, type FixedLocation } from './locations';

/**
 * The transport, narrowed to what the store needs. Keeps `ws` out of the game logic so
 * rooms can be tested with fake connections.
 */
export interface Conn {
  send(msg: ServerMessage): void;
  close(): void;
}

export type Player = {
  id: string;
  /** Secret — never broadcast (§8). Bearer of identity across reconnects. */
  sessionId: string;
  name: string;
  isHost: boolean;
  conn: Conn | null;
  disconnectedAt: number | null;
  score: number;
};

export type Guess = {
  at: LatLng;
  /** Already clamped to 0–ROUND_MS: the clamp lives at the edge, not at scoring time (§5). */
  elapsedMs: number;
};

export type ActiveRound = {
  index: number;
  location: FixedLocation;
  /**
   * What the client renders. A placeholder token until step 3 resolves real Street View
   * panorama IDs — the answer coordinates never travel with it either way (§3).
   */
  panoId: string;
  startedAt: number;
  /** Handle for the room's authoritative 46s backstop. */
  backstop: unknown;
  guesses: Map<string, Guess>;
};

export type Room = {
  code: string;
  players: Map<string, Player>;
  bySession: Map<string, string>;
  phase: Phase;
  roundIndex: number;
  createdAt: number;
  lastActivityAt: number;
  /** When the room last had zero connected players, for the 10-minute reap (§8). */
  emptySince: number | null;
  /** Locations for this game, dealt at startRound so a game never repeats one. */
  deck: FixedLocation[];
  round: ActiveRound | null;
  /** Kept so a player reconnecting into ROUND_RESULTS or GAME_OVER sees the screen (§4). */
  lastMessage: ServerMessage | null;
};

/**
 * Injectable so tests can fire the 46s backstop instantly instead of waiting for it.
 */
export type Scheduler = {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
};

const realScheduler: Scheduler = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type Failure = { ok: false; code: ErrorCode; message: string };
export type Success = { ok: true; room: Room; player: Player };
export type Result = Success | Failure;

const fail = (code: ErrorCode, message: string): Failure => ({ ok: false, code, message });

export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  /** Reverse index so a socket closing can be resolved without scanning every room. */
  private readonly connIndex = new Map<Conn, { code: string; playerId: string }>();

  constructor(private readonly scheduler: Scheduler = realScheduler) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(normalizeCode(code));
  }

  /** Development-only view for /api/health — cheap way to see what the server thinks. */
  describe(now = Date.now()) {
    return [...this.rooms.values()].map((room) => ({
      code: room.code,
      phase: room.phase,
      players: [...room.players.values()].map((p) => ({
        name: p.name,
        isHost: p.isHost,
        connected: p.conn !== null,
        score: p.score,
      })),
      idleSeconds: Math.round((now - room.lastActivityAt) / 1000),
    }));
  }

  create(conn: Conn, displayName: string, sessionId: string, now = Date.now()): Result {
    const name = normalizeName(displayName);
    if (!name) return fail('NAME_INVALID', `Pick a name of 1–${MAX_NAME_LENGTH} characters.`);

    const room: Room = {
      code: this.generateCode(),
      players: new Map(),
      bySession: new Map(),
      phase: 'LOBBY',
      roundIndex: 0,
      createdAt: now,
      lastActivityAt: now,
      emptySince: null,
      deck: [],
      round: null,
      lastMessage: null,
    };
    this.rooms.set(room.code, room);

    const player = this.addPlayer(room, conn, name, sessionId, true);
    return { ok: true, room, player };
  }

  join(conn: Conn, code: string, displayName: string, sessionId: string, now = Date.now()): Result {
    const room = this.get(code);
    if (!room) return fail('ROOM_NOT_FOUND', "No room with that code. Check the code and try again.");

    const name = normalizeName(displayName);
    if (!name) return fail('NAME_INVALID', `Pick a name of 1–${MAX_NAME_LENGTH} characters.`);

    const existingId = room.bySession.get(sessionId);
    const existing = existingId ? room.players.get(existingId) : undefined;

    // A known sessionId is a reconnect, not a join: it bypasses the room lock (§4) and the
    // player cap, because it restores a slot rather than taking a new one.
    if (existing) {
      if (isNameTaken(room, name, existing.id)) {
        return fail('NAME_TAKEN', 'Someone in the room is already using that name.');
      }
      // Two tabs on one sessionId: the newest socket wins, the old one is dropped.
      if (existing.conn && existing.conn !== conn) {
        this.connIndex.delete(existing.conn);
        existing.conn.close();
      }
      existing.name = name;
      existing.conn = conn;
      existing.disconnectedAt = null;
      this.connIndex.set(conn, { code: room.code, playerId: existing.id });
      this.touch(room, now);
      return { ok: true, room, player: existing };
    }

    if (room.phase !== 'LOBBY') {
      return fail('ROOM_LOCKED', 'A game is in progress. You’ll join when this one finishes.');
    }
    if (room.players.size >= MAX_PLAYERS) {
      return fail('ROOM_FULL', `This room is full (${MAX_PLAYERS} players).`);
    }
    if (isNameTaken(room, name, null)) {
      return fail('NAME_TAKEN', 'Someone in the room is already using that name.');
    }

    const player = this.addPlayer(room, conn, name, sessionId, false);
    this.touch(room, now);
    return { ok: true, room, player };
  }

  /** Explicit leave — removes the player outright, unlike a disconnect. */
  leave(conn: Conn, now = Date.now()): Room | undefined {
    const located = this.locate(conn);
    if (!located) return undefined;
    const { room, player } = located;

    this.connIndex.delete(conn);

    if (player.isHost) {
      this.closeRoom(room, 'hostLeft');
      return undefined;
    }

    room.players.delete(player.id);
    room.bySession.delete(player.sessionId);
    this.touch(room, now);
    // They may have been the last player the round was waiting on.
    this.maybeEndRound(room, now);
    return room;
  }

  kick(conn: Conn, playerId: string, now = Date.now()): Result {
    const located = this.locate(conn);
    if (!located) return fail('BAD_MESSAGE', 'You are not in a room.');
    const { room, player: host } = located;
    if (!host.isHost) return fail('NOT_HOST', 'Only the host can remove players.');
    if (playerId === host.id) return fail('BAD_MESSAGE', 'The host cannot kick themselves.');

    const target = room.players.get(playerId);
    if (!target) return fail('BAD_MESSAGE', 'That player is no longer here.');

    room.players.delete(target.id);
    room.bySession.delete(target.sessionId);
    if (target.conn) {
      this.connIndex.delete(target.conn);
      target.conn.send({ type: 'roomClosed', reason: 'kicked' });
    }
    this.touch(room, now);
    this.maybeEndRound(room, now);
    return { ok: true, room, player: host };
  }

  // ---------------------------------------------------------------------------------------
  // The round loop
  // ---------------------------------------------------------------------------------------

  /** Host only. Locks the room (§4), deals the game's locations, and begins round 0. */
  startRound(conn: Conn, now = Date.now()): Result {
    const located = this.locate(conn);
    if (!located) return fail('BAD_MESSAGE', 'You are not in a room.');
    const { room, player } = located;
    if (!player.isHost) return fail('NOT_HOST', 'Only the host can start the game.');
    if (room.phase !== 'LOBBY') return fail('WRONG_PHASE', 'The game has already started.');

    room.deck = dealLocations(ROUNDS_PER_GAME);
    for (const p of room.players.values()) p.score = 0;
    this.beginRound(room, 0, now);
    return { ok: true, room, player };
  }

  /**
   * Guesses are accepted until the room timer fires, and `elapsedMs` is clamped here so no
   * caller can bypass it (§5, §6).
   */
  submitGuess(conn: Conn, lat: number, lng: number, elapsedMs: number, now = Date.now()): Result {
    const located = this.locate(conn);
    if (!located) return fail('BAD_MESSAGE', 'You are not in a room.');
    const { room, player } = located;
    if (room.phase !== 'ROUND_ACTIVE' || !room.round) {
      return fail('WRONG_PHASE', 'There is no round running.');
    }
    if (!isFiniteLatLng(lat, lng)) return fail('BAD_MESSAGE', 'That guess is not a coordinate.');

    // A double-tap must not corrupt the guessed-count the early-end check depends on (§5).
    if (room.round.guesses.has(player.id)) return { ok: true, room, player };

    room.round.guesses.set(player.id, {
      at: { lat, lng },
      // Missing or absurd values are treated as the worst case rather than rejected (§5).
      elapsedMs: Number.isFinite(elapsedMs) ? clamp(elapsedMs, 0, ROUND_MS) : ROUND_MS,
    });
    player.conn?.send({ type: 'guessAck', received: true });
    this.touch(room, now);

    this.maybeEndRound(room, now);
    return { ok: true, room, player };
  }

  /** Host only. Leaves ROUND_RESULTS for the next round, or the podium for a new lobby. */
  advance(conn: Conn, now = Date.now()): Result {
    const located = this.locate(conn);
    if (!located) return fail('BAD_MESSAGE', 'You are not in a room.');
    const { room, player } = located;
    // Never trust a hidden button as an authorisation mechanism (§4).
    if (!player.isHost) return fail('NOT_HOST', 'Only the host can move the game on.');

    if (room.phase === 'ROUND_RESULTS') {
      const nextIndex = room.roundIndex + 1;
      if (nextIndex >= ROUNDS_PER_GAME) {
        room.phase = 'GAME_OVER';
        room.round = null;
        const message: ServerMessage = { type: 'gameEnd', leaderboard: this.leaderboard(room) };
        room.lastMessage = message;
        this.broadcast(room, message);
      } else {
        this.beginRound(room, nextIndex, now);
      }
      this.touch(room, now);
      return { ok: true, room, player };
    }

    if (room.phase === 'GAME_OVER') {
      // Same code, same players, scores reset, so a group can immediately play again (§4).
      room.phase = 'LOBBY';
      room.roundIndex = 0;
      room.deck = [];
      room.round = null;
      room.lastMessage = null;
      for (const p of room.players.values()) p.score = 0;
      this.touch(room, now);
      return { ok: true, room, player };
    }

    return fail('WRONG_PHASE', 'Nothing to advance from right now.');
  }

  private beginRound(room: Room, index: number, now: number): void {
    const location = room.deck[index];
    if (!location) throw new Error(`No location dealt for round ${index}`);

    if (room.round) this.scheduler.cancel(room.round.backstop);

    room.phase = 'ROUND_ACTIVE';
    room.roundIndex = index;
    room.lastMessage = null;
    room.round = {
      index,
      location,
      panoId: `dev:${location.id}`,
      startedAt: now,
      // One authoritative timer for the room, so a player who never finishes loading can't
      // stall everyone else (§5).
      backstop: this.scheduler.schedule(() => this.endRound(room), ROOM_BACKSTOP_MS),
      guesses: new Map(),
    };

    this.broadcast(room, {
      type: 'roundStart',
      roundIndex: index,
      panoId: room.round.panoId,
      durationMs: ROUND_MS,
    });
    this.broadcastState(room);
    this.touch(room, now);
  }

  /**
   * The round ends the moment every active player has guessed — the room does not sit on a
   * dead timer (§5). "Active" excludes disconnected players, who must not be able to hold
   * the room hostage for the full 46s.
   *
   * Getting this predicate wrong is the likeliest cause of a round that mysteriously
   * refuses to end, which is why it's isolated here and unit tested.
   */
  maybeEndRound(room: Room, now = Date.now()): boolean {
    if (room.phase !== 'ROUND_ACTIVE' || !room.round) return false;

    const active = [...room.players.values()].filter((p) => p.conn !== null);
    // Everyone left mid-round: end it rather than waiting out the backstop on an empty room.
    if (active.length === 0) {
      this.endRound(room, now);
      return true;
    }
    if (active.every((p) => room.round!.guesses.has(p.id))) {
      this.endRound(room, now);
      return true;
    }
    return false;
  }

  private endRound(room: Room, now = Date.now()): void {
    const round = room.round;
    if (!round || room.phase !== 'ROUND_ACTIVE') return;

    this.scheduler.cancel(round.backstop);
    room.phase = 'ROUND_RESULTS';

    const actual = round.location.at;
    const results: GuessResult[] = [...room.players.values()].map((player) => {
      const guess = round.guesses.get(player.id);
      if (!guess) {
        // No guess scores 0 for the round, but they stay on the board (§5).
        return {
          playerId: player.id,
          name: player.name,
          guess: null,
          distanceKm: null,
          points: 0,
          elapsedMs: null,
        };
      }
      const distanceKm = haversineKm(guess.at, actual);
      const points = scoreGuess(distanceKm, guess.elapsedMs);
      player.score += points;
      return {
        playerId: player.id,
        name: player.name,
        guess: guess.at,
        distanceKm,
        points,
        elapsedMs: guess.elapsedMs,
      };
    });

    results.sort((a, b) => b.points - a.points);

    const message: ServerMessage = {
      type: 'roundEnd',
      roundIndex: round.index,
      actual,
      locationName: round.location.name,
      results,
      leaderboard: this.leaderboard(room),
      isFinalRound: round.index >= ROUNDS_PER_GAME - 1,
    };
    room.round = null;
    room.lastMessage = message;
    this.broadcast(room, message);
    this.broadcastState(room);
    this.touch(room, now);
  }

  leaderboard(room: Room): LeaderboardRow[] {
    return rankByScore([...room.players.values()], (p) => p.score).map(({ rank, entry }) => ({
      rank,
      playerId: entry.id,
      name: entry.name,
      score: entry.score,
    }));
  }

  /**
   * A dropped socket does NOT remove the player — their slot and score are held for a
   * reconnect (§8). It only marks them disconnected and starts the clock.
   */
  disconnect(conn: Conn, now = Date.now()): Room | undefined {
    const located = this.locate(conn);
    if (!located) return undefined;
    const { room, player } = located;

    this.connIndex.delete(conn);
    // Stale close event from a socket this player has already replaced.
    if (player.conn !== conn) return undefined;

    player.conn = null;
    player.disconnectedAt = now;

    if (connectedCount(room) === 0) room.emptySince = now;
    // A phone that dropped mid-round must not hold the room for the full 46s — the others
    // may now be the whole active set (§5).
    this.maybeEndRound(room, now);
    return room;
  }

  /**
   * Room lifecycle (§4, §8), swept rather than timed per-room. Returns the rooms it closed
   * so the caller can log them.
   */
  sweep(now = Date.now()): { code: string; reason: RoomClosedReason }[] {
    const closed: { code: string; reason: RoomClosedReason }[] = [];

    for (const room of [...this.rooms.values()]) {
      const host = findHost(room);

      // No host promotion: if the host's socket has been gone past the grace period, the
      // room dies (§4). A missing host record at all is the same situation.
      if (!host || (host.disconnectedAt !== null && now - host.disconnectedAt >= HOST_GRACE_MS)) {
        this.closeRoom(room, 'hostLeft');
        closed.push({ code: room.code, reason: 'hostLeft' });
        continue;
      }

      const emptyFor = room.emptySince !== null && connectedCount(room) === 0
        ? now - room.emptySince
        : 0;
      if (emptyFor >= EMPTY_ROOM_TTL_MS || now - room.lastActivityAt >= IDLE_ROOM_TTL_MS) {
        this.closeRoom(room, 'reaped');
        closed.push({ code: room.code, reason: 'reaped' });
      }
    }

    return closed;
  }

  locate(conn: Conn): { room: Room; player: Player } | undefined {
    const ref = this.connIndex.get(conn);
    if (!ref) return undefined;
    const room = this.rooms.get(ref.code);
    const player = room?.players.get(ref.playerId);
    if (!room || !player) return undefined;
    return { room, player };
  }

  touch(room: Room, now = Date.now()): void {
    room.lastActivityAt = now;
    if (connectedCount(room) > 0) room.emptySince = null;
  }

  broadcastState(room: Room, now = Date.now()): void {
    const players = publicPlayers(room);
    for (const player of room.players.values()) {
      player.conn?.send({
        type: 'roomState',
        code: room.code,
        players,
        phase: room.phase,
        roundIndex: room.roundIndex,
        totalRounds: ROUNDS_PER_GAME,
        youId: player.id,
        ...(room.round ? { round: this.roundSnapshot(room, player, now) } : {}),
      });
    }
  }

  private broadcast(room: Room, message: ServerMessage): void {
    for (const player of room.players.values()) player.conn?.send(message);
  }

  private roundSnapshot(room: Room, player: Player, now: number): RoundSnapshot {
    const round = room.round!;
    return {
      index: round.index,
      panoId: round.panoId,
      remainingMs: Math.max(0, ROOM_BACKSTOP_MS - (now - round.startedAt)),
      youGuessed: round.guesses.has(player.id),
    };
  }

  /**
   * A reconnecting player is dropped straight into the current phase (§4). Mid-round that
   * falls out of `roomState`; on a results or podium screen it needs the payload again.
   */
  replayPhase(room: Room, player: Player): void {
    if (room.lastMessage) player.conn?.send(room.lastMessage);
  }

  private closeRoom(room: Room, reason: RoomClosedReason): void {
    for (const player of room.players.values()) {
      if (!player.conn) continue;
      player.conn.send({ type: 'roomClosed', reason });
      this.connIndex.delete(player.conn);
    }
    this.rooms.delete(room.code);
  }

  private addPlayer(
    room: Room,
    conn: Conn,
    name: string,
    sessionId: string,
    isHost: boolean,
  ): Player {
    const player: Player = {
      id: randomUUID(),
      sessionId,
      name,
      isHost,
      conn,
      disconnectedAt: null,
      score: 0,
    };
    room.players.set(player.id, player);
    room.bySession.set(sessionId, player.id);
    this.connIndex.set(conn, { code: room.code, playerId: player.id });
    return player;
  }

  private generateCode(): string {
    // ~800k combinations against a handful of live rooms, but check anyway (§8).
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Could not allocate an unused room code');
  }
}

export function publicPlayers(room: Room): PublicPlayer[] {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    isHost: p.isHost,
    connected: p.conn !== null,
    score: p.score,
  }));
}

export function connectedCount(room: Room): number {
  let n = 0;
  for (const p of room.players.values()) if (p.conn) n++;
  return n;
}

function findHost(room: Room): Player | undefined {
  for (const p of room.players.values()) if (p.isHost) return p;
  return undefined;
}

/** Must exempt the player's own record, or every reconnect fails as NAME_TAKEN (§8). */
function isNameTaken(room: Room, name: string, exceptPlayerId: string | null): boolean {
  const wanted = name.toLowerCase();
  for (const p of room.players.values()) {
    if (p.id === exceptPlayerId) continue;
    if (p.name.toLowerCase() === wanted) return true;
  }
  return false;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isFiniteLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

function normalizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  return name;
}
