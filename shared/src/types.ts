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
};

/**
 * Enough for a reconnecting player to be dropped straight back into a live round (§4).
 * Carries `remainingMs` rather than an absolute deadline so no client/server clock skew
 * creeps into the timer.
 */
export type RoundSnapshot = {
  index: number;
  panoId: string;
  /** Left on the room's backstop clock, not the player's own 40s. */
  remainingMs: number;
  youGuessed: boolean;
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
  round?: RoundSnapshot;
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

export type LeaderboardRow = {
  /** Standard competition ranking — ties share a rank and the next rank skips (§4). */
  rank: number;
  playerId: string;
  name: string;
  score: number;
};

export type RoomClosedReason = 'hostLeft' | 'reaped';

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_LOCKED'
  | 'NAME_TAKEN'
  | 'NAME_INVALID'
  | 'CODE_INVALID'
  | 'NOT_HOST'
  | 'WRONG_PHASE'
  | 'BAD_MESSAGE';

export type ClientMessage =
  | { type: 'create'; displayName: string; sessionId: string }
  | { type: 'join'; code: string; displayName: string; sessionId: string }
  | { type: 'leave' }
  | { type: 'kick'; playerId: string } // host only
  | { type: 'startRound' } // host only
  | { type: 'advance' } // host only
  | { type: 'submitGuess'; lat: number; lng: number; elapsedMs: number };

export type ServerMessage =
  | RoomStateMsg
  /** Never carries the answer — only the panorama to render (§3). */
  | { type: 'roundStart'; roundIndex: number; panoId: string; durationMs: number }
  /** Deliberately no score: leaking one mid-round would spoil it (§8). */
  | { type: 'guessAck'; received: true }
  | {
      type: 'roundEnd';
      roundIndex: number;
      actual: LatLng;
      locationName: string;
      results: GuessResult[];
      leaderboard: LeaderboardRow[];
      isFinalRound: boolean;
    }
  | { type: 'gameEnd'; leaderboard: LeaderboardRow[] }
  | { type: 'roomClosed'; reason: RoomClosedReason }
  | { type: 'error'; code: ErrorCode; message: string };
