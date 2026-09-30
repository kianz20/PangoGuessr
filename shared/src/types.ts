export type Phase = 'LOBBY' | 'ROUND_ACTIVE' | 'ROUND_RESULTS' | 'GAME_OVER';

export type LatLng = { lat: number; lng: number };

/**
 * What every client sees about every player. Deliberately does NOT carry `sessionId`:
 * that's the bearer of identity (§8), and broadcasting it would let anyone in the room
 * reconnect as anyone else. `id` is a separate public handle.
 */
export type PublicPlayer = {
  id: string;
  name: string;
  isHost: boolean;
  connected: boolean;
  score: number;
  /**
   * A palette slot, unique in the room for as long as they're in it, so a player is the same
   * colour on every screen and every phone. Handed out by the server because hashing IDs
   * into a palette collides constantly at 20 players.
   */
  color: number;
  /**
   * Their phone has the game's first panorama loaded, so Start won't leave them looking at a
   * spinner (§7). Only meaningful in the lobby; a new deck clears it for everyone.
   */
  ready: boolean;
};

/** How many have guessed — a count, never who or how well, so nothing is spoiled (§8). */
export type GuessProgress = {
  guessed: number;
  /** Everyone the round is still waiting on, plus those who've already guessed. */
  total: number;
};

/**
 * Enough for a reconnecting player to be dropped straight back into a live round (§4).
 * Carries `remainingMs` rather than an absolute deadline so no client/server clock skew
 * creeps into the timer.
 */
export type RoundSnapshot = {
  index: number;
  panoId: string;
  /**
   * Until the room stops waiting on this player: the backstop, or sooner once their own clock
   * has started (§5). Bounds the countdown, so a reload mid-round can't show more time than
   * the room will give them.
   */
  remainingMs: number;
  youGuessed: boolean;
  progress: GuessProgress;
};

export type RoomStateMsg = {
  type: 'roomState';
  code: string;
  players: PublicPlayer[];
  phase: Phase;
  roundIndex: number;
  totalRounds: number;
  /** Which of `players` is the recipient, so the client needn't guess. */
  youId: string;
  /**
   * The game's panoramas in round order, dealt when the room is created so every phone can
   * load them before their round comes up (§7). IDs only — never coordinates or place names,
   * which stay server-side until each `roundEnd` (§3). Empty until the deck is dealt.
   */
  panoIds: string[];
  round?: RoundSnapshot;
  /**
   * Which state this is: the room counts every `roomState` it sends. The heartbeat's `pong`
   * carries the room's latest, so a phone that missed one — for any reason — finds out within
   * a beat and asks again, instead of sitting on a screen the room has left (§3).
   */
  rev: number;
};

export type GuessResult = {
  playerId: string;
  name: string;
  /** Null when they never guessed — scored 0 for the round, but still listed (§5). */
  guess: LatLng | null;
  distanceKm: number | null;
  points: number;
  elapsedMs: number | null;
};

/** One finished round, as the podium's recap shows it. */
export type RoundSummary = {
  roundIndex: number;
  locationName: string;
  actual: LatLng;
  results: GuessResult[];
};

export type LeaderboardRow = {
  /** Standard competition ranking — ties share a rank and the next rank skips (§4). */
  rank: number;
  playerId: string;
  name: string;
  score: number;
};

/** Why a client is being returned to the join screen. `kicked` is about that one player. */
export type RoomClosedReason = 'hostLeft' | 'reaped' | 'kicked';

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_LOCKED'
  | 'NAME_TAKEN'
  | 'NAME_INVALID'
  | 'CODE_INVALID'
  | 'NOT_HOST'
  | 'WRONG_PHASE'
  | 'LOCATIONS_NOT_READY'
  | 'BAD_MESSAGE';

/**
 * What a reconnecting client knows about its own drop, sent with the `join` that restores it.
 * Logged by the server, so "people keep getting disconnected" can be answered from the logs:
 * which phones, how long, and what noticed.
 */
export type ReconnectDiag = {
  /**
   * What noticed the drop: the browser closing the socket, the client's own heartbeat giving
   * up on a silent one, the phone going offline, or the page itself reloading.
   */
  cause: 'closed' | 'stale' | 'offline' | 'reload';
  /** How long it was without a working socket. Null for a reload, which can't know. */
  downMs: number | null;
  /** Connection attempts it took, including the one that worked. */
  attempts: number;
  /** The dropped socket's close code — 1006 is "gone without a goodbye". 0 if none. */
  closeCode: number;
  /** Whether the page was hidden when it dropped: screen locked, app switched. */
  hidden: boolean;
};

export type ClientMessage =
  | { type: 'create'; displayName: string; sessionId: string }
  | { type: 'join'; code: string; displayName: string; sessionId: string; diag?: ReconnectDiag }
  | { type: 'leave' }
  | { type: 'kick'; playerId: string } // host only
  | { type: 'startRound' } // host only
  | { type: 'advance' } // host only
  | { type: 'cancelGame' } // host only — abandon mid-game, back to the lobby
  /**
   * `roundIndex` is what makes a resend safe: a guess retried after a reconnect must never be
   * scored against the round after the one it was made in.
   */
  | { type: 'submitGuess'; roundIndex: number; lat: number; lng: number; elapsedMs: number }
  /**
   * This player's own 40s have started (§5). The server keeps the first report, and from it
   * knows when this phone has run out of time — so a phone that stops talking can't hold the
   * round until the 46s backstop.
   */
  | { type: 'clockStarted'; roundIndex: number }
  /** Their own clock ran out with no pin down: they're done, and the room needn't wait on them. */
  | { type: 'timeUp'; roundIndex: number }
  /** This phone has finished loading `panoId` — sent for the game's first round, from the lobby. */
  | { type: 'preloaded'; panoId: string }
  /**
   * App-level heartbeat. Browsers never expose the protocol's ping frames to JavaScript, so
   * this is the only way a phone can find out its socket has silently died.
   */
  | { type: 'ping' }
  /**
   * "Send me the room as it is now." Sent when a `pong` shows this phone is behind. Answered
   * with a `roomState` to this player alone (and the phase's payload, as on a rejoin), so a
   * resync never disturbs anyone else.
   */
  | { type: 'sync' };

export type ServerMessage =
  | RoomStateMsg
  /** Never carries the answer — only the panorama to render (§3). */
  | { type: 'roundStart'; roundIndex: number; panoId: string; durationMs: number }
  /**
   * Deliberately no score: leaking one mid-round would spoil it (§8). Sent again for a
   * duplicate, so a client resending after a reconnect always hears back.
   */
  | { type: 'guessAck'; received: true; roundIndex: number }
  /** Sent to the whole room on each new guess: one small count, not a score (§8). */
  | { type: 'guessProgress'; roundIndex: number; progress: GuessProgress }
  /**
   * The room's latest `roomState.rev`, or null when this socket isn't the player's live
   * connection to any room — the server has moved them to another socket, or lost them.
   */
  | { type: 'pong'; rev: number | null }
  | {
      type: 'roundEnd';
      roundIndex: number;
      actual: LatLng;
      locationName: string;
      results: GuessResult[];
      leaderboard: LeaderboardRow[];
      isFinalRound: boolean;
    }
  /** `rounds` is the whole game, oldest first, for the recap and the end-of-game awards. */
  | { type: 'gameEnd'; leaderboard: LeaderboardRow[]; rounds: RoundSummary[] }
  | { type: 'roomClosed'; reason: RoomClosedReason }
  | { type: 'error'; code: ErrorCode; message: string };
