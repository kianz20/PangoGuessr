import { randomUUID } from 'node:crypto';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  EMPTY_ROOM_TTL_MS,
  HOST_GRACE_MS,
  IDLE_ROOM_TTL_MS,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  ROUNDS_PER_GAME,
  normalizeCode,
} from '@pangoguessr/shared';
import type {
  ErrorCode,
  Phase,
  PublicPlayer,
  RoomClosedReason,
  ServerMessage,
} from '@pangoguessr/shared';

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
};

export type Failure = { ok: false; code: ErrorCode; message: string };
export type Success = { ok: true; room: Room; player: Player };
export type Result = Success | Failure;

const fail = (code: ErrorCode, message: string): Failure => ({ ok: false, code, message });

export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  /** Reverse index so a socket closing can be resolved without scanning every room. */
  private readonly connIndex = new Map<Conn, { code: string; playerId: string }>();

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
      target.conn.send({ type: 'roomClosed', reason: 'reaped' });
    }
    this.touch(room, now);
    return { ok: true, room, player: host };
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

  broadcastState(room: Room): void {
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
      });
    }
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

function normalizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  return name;
}
