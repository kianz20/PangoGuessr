import { randomUUID } from 'node:crypto';
import {
  CLOCK_SLACK_MS,
  CLOSE_REPLACED,
  CODE_ALPHABET,
  CODE_LENGTH,
  EMPTY_ROOM_TTL_MS,
  HOST_GRACE_MS,
  IDLE_ROOM_TTL_MS,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  RECONNECT_GRACE_MS,
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
  GuessProgress,
  GuessResult,
  LatLng,
  LeaderboardRow,
  Phase,
  PublicPlayer,
  RoomClosedReason,
  RoundSnapshot,
  RoundSummary,
  ServerMessage,
} from '@pangoguessr/shared';
import {
  FixedLocationSource,
  type LocationSource,
  type RoundLocation,
} from './locationSource';

/**
 * The transport, narrowed to what the store needs. Keeps `ws` out of the game logic so
 * rooms can be tested with fake connections.
 */
export interface Conn {
  send(msg: ServerMessage): void;
  close(code?: number, reason?: string): void;
}

/**
 * Why a socket went away. A `timeout` is the heartbeat giving up on a socket that has been
 * silent for ~10s; anything else closed on its own and may well be back in a second.
 */
export type DropCause = 'closed' | 'timeout';

export type Player = {
  id: string;
  /** Secret — never broadcast (§8). Bearer of identity across reconnects. */
  sessionId: string;
  name: string;
  isHost: boolean;
  conn: Conn | null;
  disconnectedAt: number | null;
  /**
   * Until when a dropped player still counts as playing for the early-end check (§5), so a
   * blip doesn't end the round under them. Null when connected, or when there's no grace.
   */
  graceUntil: number | null;
  score: number;
  /** Palette slot, unique among the room's current players and kept across reconnects. */
  color: number;
  /**
   * The first round's panorama, once this phone has said it's loaded — the lobby's ready tick.
   * Checked against the deck, so a new deal leaves everyone unready without clearing it here.
   */
  preloaded: string | null;
};

export type Guess = {
  at: LatLng;
  /** Clamped to 0–ROUND_MS. Shown on the reveal; it does not affect the score. */
  elapsedMs: number;
};

export type ActiveRound = {
  index: number;
  location: RoundLocation;
  /**
   * What the client renders. The server resolves this before broadcasting, so all players
   * are guaranteed the same panorama — no per-client coordinate resolution, no drift where
   * two people see different images of the same "location" (§7). The answer coordinates
   * never travel with it (§3).
   */
  panoId: string;
  startedAt: number;
  /** Handle for the room's authoritative 46s backstop. */
  backstop: unknown;
  /**
   * Re-runs the early-end check when the next thing it depends on runs out — a dropped
   * player's grace, or a player's own clock.
   */
  graceCheck: unknown;
  guesses: Map<string, Guess>;
  /**
   * When each player stops holding the round up: their own 40s from when we heard it start,
   * plus the slack for their last guess to arrive (§5). Missing until their clock starts.
   */
  clockEnds: Map<string, number>;
  /** Ran out of time with no pin down, by their own report. Scored 0, like no guess at all. */
  timedOut: Set<string>;
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
  /**
   * Locations for the next (or current) game, dealt without replacement so a game never
   * repeats one. Dealt in the lobby rather than at Start, so every phone can preload the
   * panoramas before its round comes up (§7).
   */
  deck: RoundLocation[];
  /** A deal is waiting on the pool to refill. */
  dealing: boolean;
  round: ActiveRound | null;
  /** This game's finished rounds, for the podium's recap. Cleared when a game starts or ends. */
  history: RoundSummary[];
  /** Kept so a player reconnecting into ROUND_RESULTS or GAME_OVER sees the screen (§4). */
  lastMessage: ServerMessage | null;
  /** Counts the `roomState`s sent, so a phone can tell from a `pong` that it missed one (§3). */
  rev: number;
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

  constructor(
    private readonly scheduler: Scheduler = realScheduler,
    private readonly locations: LocationSource = new FixedLocationSource(),
    /** Hook for usage instrumentation — every round begun bills one load per player (§7). */
    private readonly onRoundBegan?: (room: Room, playerCount: number) => void,
  ) {}

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
      dealing: false,
      round: null,
      history: [],
      lastMessage: null,
      rev: 0,
    };
    this.rooms.set(room.code, room);

    const player = this.addPlayer(room, conn, name, sessionId, true);
    // Someone is about to play: deal now, during the lobby, so Start is instant and every
    // phone that joins has the whole game's panoramas to preload.
    this.dealDeck(room);
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
      // Two tabs on one sessionId: the newest socket wins, the old one is dropped. The close
      // code tells the old tab why, so it stops rather than reconnecting and taking the slot
      // straight back — which is how two tabs used to kick each other every few seconds.
      if (existing.conn && existing.conn !== conn) {
        this.connIndex.delete(existing.conn);
        existing.conn.close(CLOSE_REPLACED, 'replaced');
      }
      existing.name = name;
      existing.conn = conn;
      existing.disconnectedAt = null;
      existing.graceUntil = null;
      // The page may have reloaded and lost its preloaded panorama. A phone that still has it
      // says so again as soon as it sees itself unready.
      existing.preloaded = null;
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

    // Normally dealt in the lobby. If that deal hasn't landed — a cold pool, or sampling
    // failing — try once more rather than hang.
    if (room.deck.length === 0) {
      const deck = this.locations.take(ROUNDS_PER_GAME);
      if (!deck) {
        // Better an honest "try again in a moment" than a Start button that hangs while
        // metadata round-trips happen (§7).
        return fail('LOCATIONS_NOT_READY', 'Still finding locations — try again in a few seconds.');
      }
      room.deck = deck;
    }

    for (const p of room.players.values()) p.score = 0;
    room.history = [];
    this.beginRound(room, 0, now);
    return { ok: true, room, player };
  }

  /**
   * Guesses are accepted until the room timer fires, and `elapsedMs` is clamped here so no
   * caller can bypass it (§5, §6).
   *
   * Clients resend an unacknowledged guess after a reconnect, so `roundIndex` pins it to the
   * round it was made in. A resend that turns up after that round has closed is dropped
   * quietly — never scored against the next round, and not worth an error either.
   */
  submitGuess(
    conn: Conn,
    lat: number,
    lng: number,
    elapsedMs: number,
    roundIndex?: number,
    now = Date.now(),
  ): Result {
    const located = this.locate(conn);
    if (!located) return fail('BAD_MESSAGE', 'You are not in a room.');
    const { room, player } = located;
    if (Number.isInteger(roundIndex) && roundIndex !== room.round?.index) {
      return { ok: true, room, player };
    }
    if (room.phase !== 'ROUND_ACTIVE' || !room.round) {
      return fail('WRONG_PHASE', 'There is no round running.');
    }
    if (!isFiniteLatLng(lat, lng)) return fail('BAD_MESSAGE', 'That guess is not a coordinate.');

    const ack: ServerMessage = { type: 'guessAck', received: true, roundIndex: room.round.index };

    // A double-tap must not corrupt the guessed-count the early-end check depends on (§5).
    // Still acknowledged: a resend after a reconnect has to hear back to stop resending.
    if (room.round.guesses.has(player.id)) {
      player.conn?.send(ack);
      return { ok: true, room, player };
    }

    room.round.guesses.set(player.id, {
      at: { lat, lng },
      // Missing or absurd values are treated as the worst case rather than rejected (§5).
      elapsedMs: Number.isFinite(elapsedMs) ? clamp(elapsedMs, 0, ROUND_MS) : ROUND_MS,
    });
    player.conn?.send(ack);
    this.touch(room, now);

    if (!this.maybeEndRound(room, now)) this.broadcastProgress(room, now);
    return { ok: true, room, player };
  }

  /**
   * The player's own clock has started, so the server knows when they'll be out of time (§5).
   * The first report stands: a reload mid-round must not buy them a fresh 40 seconds.
   */
  clockStarted(conn: Conn, roundIndex: unknown, now = Date.now()): void {
    const located = this.locate(conn);
    const round = located?.room.round;
    if (!located || !round || round.index !== roundIndex) return;
    if (round.clockEnds.has(located.player.id)) return;
    round.clockEnds.set(located.player.id, now + ROUND_MS + CLOCK_SLACK_MS);
    this.armGraceCheck(located.room, now);
  }

  /**
   * Their clock ran out with no pin down. Without this the room kept waiting on them — their
   * screen at 0s, everyone else's too — until the backstop, several seconds later.
   */
  timeUp(conn: Conn, roundIndex: unknown, now = Date.now()): void {
    const located = this.locate(conn);
    if (!located) return;
    const { room, player } = located;
    const round = room.round;
    if (room.phase !== 'ROUND_ACTIVE' || !round || round.index !== roundIndex) return;
    if (round.guesses.has(player.id) || round.timedOut.has(player.id)) return;
    round.timedOut.add(player.id);
    this.touch(room, now);
    if (!this.maybeEndRound(room, now)) this.broadcastProgress(room, now);
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
        const message: ServerMessage = {
          type: 'gameEnd',
          leaderboard: this.leaderboard(room),
          rounds: room.history,
        };
        room.lastMessage = message;
        this.broadcast(room, message);
        // Without the phase change, every phone sat on the results phase with no results to
        // draw — "Scoring the round" — until its 1.5s resync asked again.
        this.broadcastState(room, now);
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
      room.history = [];
      room.lastMessage = null;
      for (const p of room.players.values()) p.score = 0;
      this.dealDeck(room);
      this.touch(room, now);
      return { ok: true, room, player };
    }

    return fail('WRONG_PHASE', 'Nothing to advance from right now.');
  }

  /**
   * Host only. Abandons the game and returns everyone to the lobby — the escape hatch for a
   * game started by mistake, with the wrong people, or that nobody wants to finish.
   *
   * Scores are cleared and the room unlocks, so anyone held out by the lock (§4) can join
   * for the next one.
   */
  cancelGame(conn: Conn, now = Date.now()): Result {
    const located = this.locate(conn);
    if (!located) return fail('BAD_MESSAGE', 'You are not in a room.');
    const { room, player } = located;
    if (!player.isHost) return fail('NOT_HOST', 'Only the host can cancel the game.');
    if (room.phase === 'LOBBY') return fail('WRONG_PHASE', 'There is no game to cancel.');

    // Leaving these armed would fire into an idle lobby and try to end a round that no
    // longer exists.
    if (room.round) this.stopRoundTimers(room.round);

    room.phase = 'LOBBY';
    room.roundIndex = 0;
    // A fresh deck: the abandoned game's panoramas have been sent to every phone, and some
    // of them seen, so replaying them would hand the room answers it already knows.
    room.deck = [];
    room.round = null;
    room.history = [];
    room.lastMessage = null;
    for (const p of room.players.values()) p.score = 0;
    this.dealDeck(room);

    this.touch(room, now);
    this.broadcastState(room, now);
    return { ok: true, room, player };
  }

  /**
   * A phone saying it has the game's first panorama loaded, for the lobby's ready ticks (§7).
   * Anything but the first round's panorama is ignored, so nothing a client sends is stored.
   * Returns the room when this changed what everyone sees, so the caller knows to broadcast.
   */
  markPreloaded(conn: Conn, panoId: unknown): Room | undefined {
    const located = this.locate(conn);
    if (!located) return undefined;
    const { room, player } = located;
    const first = room.deck[0]?.panoId;
    if (first === undefined || panoId !== first || player.preloaded === first) return undefined;
    player.preloaded = first;
    return room;
  }

  /**
   * Deals the next game's locations while the room is in the lobby, so every phone can load
   * the panoramas before its round rather than during it (§7).
   *
   * Synchronous when the pool already holds a game, and then the caller's broadcast carries
   * it. Otherwise — the first room after a cold start — it waits for the refill and
   * broadcasts the deck itself when it lands.
   */
  private dealDeck(room: Room): void {
    if (room.deck.length > 0 || room.dealing) return;

    const deck = this.locations.take(ROUNDS_PER_GAME);
    if (deck) {
      room.deck = deck;
      return;
    }
    if (!this.locations.deal) return;

    room.dealing = true;
    void this.locations
      .deal(ROUNDS_PER_GAME)
      .catch(() => null)
      .then((dealt) => {
        room.dealing = false;
        // While we waited the room may have closed, or Start may have dealt for itself.
        const stillWanted =
          this.rooms.get(room.code) === room && room.phase === 'LOBBY' && room.deck.length === 0;
        if (!dealt || !stillWanted) return;
        room.deck = dealt;
        this.broadcastState(room);
      });
  }

  private beginRound(room: Room, index: number, now: number): void {
    const location = room.deck[index];
    if (!location) throw new Error(`No location dealt for round ${index}`);

    if (room.round) this.stopRoundTimers(room.round);

    room.phase = 'ROUND_ACTIVE';
    room.roundIndex = index;
    room.lastMessage = null;
    room.round = {
      index,
      location,
      panoId: location.panoId,
      startedAt: now,
      // One authoritative timer for the room, so a player who never finishes loading can't
      // stall everyone else (§5).
      backstop: this.scheduler.schedule(() => this.endRound(room), ROOM_BACKSTOP_MS),
      graceCheck: null,
      guesses: new Map(),
      clockEnds: new Map(),
      timedOut: new Set(),
    };

    this.broadcast(room, {
      type: 'roundStart',
      roundIndex: index,
      panoId: room.round.panoId,
      durationMs: ROUND_MS,
    });
    this.broadcastState(room);
    this.touch(room, now);
    this.onRoundBegan?.(room, connectedCount(room));
  }

  /**
   * The round ends the moment nobody is left to wait on — the room does not sit on a dead
   * timer (§5). A player stops being waited on once they've guessed or run out of their own
   * time. Disconnected players aren't waited on either, so they can't hold the room hostage
   * for the full 46s — except for the few seconds of grace after a drop, so a phone that
   * blinked doesn't come back to find the round closed on it.
   *
   * Getting this predicate wrong is the likeliest cause of a round that mysteriously
   * refuses to end, which is why it's isolated here and unit tested.
   */
  maybeEndRound(room: Room, now = Date.now()): boolean {
    if (room.phase !== 'ROUND_ACTIVE' || !room.round) return false;

    const round = room.round;
    // Everyone guessed, ran out of time, or left: end it rather than wait out the backstop.
    if (![...room.players.values()].some((p) => isWaitingOn(round, p, now))) {
      this.endRound(room, now);
      return true;
    }
    return false;
  }

  /**
   * Checks again when the next dropped player's grace, or the next player's own clock, runs
   * out, since nothing else happens at that moment to prompt it. Only players the round is
   * actually waiting on count — one who already guessed can't hold anything up.
   */
  private armGraceCheck(room: Room, now: number): void {
    const round = room.round;
    if (!round || room.phase !== 'ROUND_ACTIVE') return;
    if (round.graceCheck !== null) this.scheduler.cancel(round.graceCheck);
    round.graceCheck = null;

    let due = Infinity;
    for (const p of room.players.values()) {
      if (!isWaitingOn(round, p, now)) continue;
      if (p.conn === null && p.graceUntil !== null) due = Math.min(due, p.graceUntil);
      const clockEnd = round.clockEnds.get(p.id);
      if (clockEnd !== undefined) due = Math.min(due, clockEnd);
    }
    if (due === Infinity) return;

    round.graceCheck = this.scheduler.schedule(() => {
      round.graceCheck = null;
      if (room.round !== round) return;
      // Never earlier than `due`, even when a test fires the timer without waiting for it.
      const at = Math.max(Date.now(), due);
      if (this.maybeEndRound(room, at)) return;
      // Someone's grace or time ran out, so the room is waiting on one fewer.
      this.broadcastProgress(room, at);
      this.armGraceCheck(room, at);
    }, due - now);
  }

  private stopRoundTimers(round: ActiveRound): void {
    this.scheduler.cancel(round.backstop);
    if (round.graceCheck !== null) this.scheduler.cancel(round.graceCheck);
    round.graceCheck = null;
  }

  private endRound(room: Room, now = Date.now()): void {
    const round = room.round;
    if (!round || room.phase !== 'ROUND_ACTIVE') return;

    this.stopRoundTimers(round);
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
      const points = scoreGuess(distanceKm);
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
    room.history.push({
      roundIndex: round.index,
      locationName: round.location.name,
      actual,
      results,
    });

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
  disconnect(conn: Conn, now = Date.now(), cause: DropCause = 'closed'): Room | undefined {
    const located = this.locate(conn);
    if (!located) return undefined;
    const { room, player } = located;

    this.connIndex.delete(conn);
    // Stale close event from a socket this player has already replaced.
    if (player.conn !== conn) return undefined;

    player.conn = null;
    player.disconnectedAt = now;
    // A socket that closed is usually a phone about to reconnect. One the heartbeat gave up
    // on has already been silent for longer than the grace would give it.
    player.graceUntil = cause === 'timeout' ? null : now + RECONNECT_GRACE_MS;

    if (connectedCount(room) === 0) room.emptySince = now;
    // A phone that dropped mid-round must not hold the room for the full 46s — the others
    // may now be the whole active set once its grace runs out (§5).
    if (!this.maybeEndRound(room, now)) this.armGraceCheck(room, now);
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
    room.rev++;
    const players = publicPlayers(room);
    for (const player of room.players.values()) {
      player.conn?.send(this.stateFor(room, player, players, now));
    }
  }

  /**
   * A phone whose `pong` showed it was behind: the room as it is now, to that player alone,
   * plus the phase's payload as on a rejoin. Nothing changes, so nobody else hears about it.
   * Ignored from a socket that isn't the player's live one — the `pong` told that phone to
   * rejoin instead.
   */
  sync(conn: Conn, now = Date.now()): boolean {
    const located = this.locate(conn);
    if (!located || located.player.conn !== conn) return false;
    const { room, player } = located;
    conn.send(this.stateFor(room, player, publicPlayers(room), now));
    this.replayPhase(room, player);
    return true;
  }

  /**
   * What a `pong` reports: the room's latest `roomState.rev`, or null when this socket isn't
   * the player's live connection — which a phone can't otherwise tell, since the socket
   * itself still answers its heartbeat.
   */
  revFor(conn: Conn): number | null {
    const located = this.locate(conn);
    return located && located.player.conn === conn ? located.room.rev : null;
  }

  private stateFor(
    room: Room,
    player: Player,
    players: PublicPlayer[],
    now: number,
  ): ServerMessage {
    return {
      type: 'roomState',
      code: room.code,
      players,
      phase: room.phase,
      roundIndex: room.roundIndex,
      totalRounds: ROUNDS_PER_GAME,
      youId: player.id,
      // Panorama IDs only. The rest of each RoundLocation is the answer (§3).
      panoIds: room.deck.map((location) => location.panoId),
      ...(room.round ? { round: this.roundSnapshot(room, player, now) } : {}),
      rev: room.rev,
    };
  }

  private broadcast(room: Room, message: ServerMessage): void {
    for (const player of room.players.values()) player.conn?.send(message);
  }

  private roundSnapshot(room: Room, player: Player, now: number): RoundSnapshot {
    const round = room.round!;
    const backstop = round.startedAt + ROOM_BACKSTOP_MS;
    const until = Math.min(backstop, round.clockEnds.get(player.id) ?? backstop);
    return {
      index: round.index,
      panoId: round.panoId,
      remainingMs: Math.max(0, until - now),
      youGuessed: round.guesses.has(player.id),
      progress: this.progress(room, now),
    };
  }

  /**
   * "5 of 8 guessed". Counted against the same predicate the early-end check uses (§5), so
   * the count reaching its total is exactly the moment the round closes. Someone who ran out
   * of time is no longer counted: the room isn't waiting on them.
   */
  private progress(room: Room, now: number): GuessProgress {
    const round = room.round;
    let guessed = 0;
    let total = 0;
    for (const p of room.players.values()) {
      const hasGuessed = round?.guesses.has(p.id) ?? false;
      if (hasGuessed) guessed++;
      if (hasGuessed || (round && isWaitingOn(round, p, now))) total++;
    }
    return { guessed, total };
  }

  /** A count, never who or how well — nothing here spoils the round (§8). */
  private broadcastProgress(room: Room, now: number): void {
    if (room.phase !== 'ROUND_ACTIVE' || !room.round) return;
    this.broadcast(room, {
      type: 'guessProgress',
      roundIndex: room.round.index,
      progress: this.progress(room, now),
    });
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
      graceUntil: null,
      score: 0,
      color: freeColor(room),
      preloaded: null,
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
    color: p.color,
    ready: isReady(room, p),
  }));
}

/** Their phone has the first round's panorama. Against the current deck, so a new deal resets it. */
function isReady(room: Room, player: Player): boolean {
  const first = room.deck[0];
  return first !== undefined && player.preloaded === first.panoId;
}

/**
 * The lowest palette slot nobody in the room holds. A leaver's colour goes back into use, and
 * with MAX_PLAYERS slots there is always one free.
 */
function freeColor(room: Room): number {
  const taken = new Set([...room.players.values()].map((p) => p.color));
  let color = 0;
  while (taken.has(color)) color++;
  return color;
}

export function connectedCount(room: Room): number {
  let n = 0;
  for (const p of room.players.values()) if (p.conn) n++;
  return n;
}

/** Connected, or dropped moments ago and very likely on their way back (§5). */
function isStillPlaying(player: Player, now: number): boolean {
  return player.conn !== null || (player.graceUntil !== null && now < player.graceUntil);
}

/**
 * Whether the round is still waiting on this player (§5): still playing, and with neither a
 * guess in nor their own time used up — by their report, or by the clock we started for them.
 */
function isWaitingOn(round: ActiveRound, player: Player, now: number): boolean {
  if (round.guesses.has(player.id) || round.timedOut.has(player.id)) return false;
  const clockEnd = round.clockEnds.get(player.id);
  if (clockEnd !== undefined && now >= clockEnd) return false;
  return isStillPlaying(player, now);
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
