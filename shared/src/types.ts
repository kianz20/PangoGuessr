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

export type RoomStateMsg = {
  type: 'roomState';
  code: string;
  players: PublicPlayer[];
  phase: Phase;
  roundIndex: number;
  totalRounds: number;
  /** Which of `players` is the recipient, so the client needn't guess. */
  youId: string;
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
  | { type: 'roomClosed'; reason: RoomClosedReason }
  | { type: 'error'; code: ErrorCode; message: string };
