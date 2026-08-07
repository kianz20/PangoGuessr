import { useCallback, useEffect, useRef, useState } from 'react';
import { LOAD_HEADROOM_MS, ROUND_MS } from '@pangoguessr/shared';
import type {
  ClientMessage,
  ErrorCode,
  LatLng,
  LeaderboardRow,
  RoomStateMsg,
  ServerMessage,
} from '@pangoguessr/shared';
import { forgetRoom, getSessionId, recallRoom, rememberRoom } from './session';

export type RoundView = {
  index: number;
  panoId: string;
  /** The player's own clock, which starts when their panorama renders (§5). */
  durationMs: number;
  /** Left on the room's backstop when we learned about the round — bounds the above. */
  remainingMs: number;
  youGuessed: boolean;
};

export type ResultsView = Extract<ServerMessage, { type: 'roundEnd' }>;

export type Status =
  | 'home'
  | 'connecting'
  /** Render free tier spins down after ~15min idle and takes 30–60s to wake (§9). */
  | 'waking'
  | 'inRoom'
  | 'reconnecting'
  /** Room is mid-game; we hold and retry until it returns to LOBBY (§4). */
  | 'waitingForGame';

type Intent = { kind: 'create'; name: string } | { kind: 'join'; code: string; name: string };

/** Past this, a slow connect is almost certainly a cold start, not a slow phone. */
const WAKING_AFTER_MS = 3_000;
const RETRY_MS = 2_000;
const LOCKED_RETRY_MS = 3_000;

function socketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export function useRoom() {
  const [status, setStatus] = useState<Status>('home');
  const [room, setRoom] = useState<RoomStateMsg | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [round, setRound] = useState<RoundView | null>(null);
  const [results, setResults] = useState<ResultsView | null>(null);
  const [finalBoard, setFinalBoard] = useState<LeaderboardRow[] | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const intentRef = useRef<Intent | null>(null);
  const timersRef = useRef<number[]>([]);
  /** Set while we're deliberately tearing down, so `onclose` doesn't try to reconnect. */
  const closingRef = useRef(false);

  const clearTimers = () => {
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current = [];
  };
  const later = (fn: () => void, ms: number) => {
    timersRef.current.push(window.setTimeout(fn, ms));
  };

  const send = useCallback((msg: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }, []);

  const goHome = useCallback((message: string | null) => {
    closingRef.current = true;
    clearTimers();
    intentRef.current = null;
    forgetRoom();
    socketRef.current?.close();
    socketRef.current = null;
    setRoom(null);
    setNotice(message);
    setStatus('home');
  }, []);

  const connect = useCallback(() => {
    if (!intentRef.current) return;
    // Never open a second socket. The server treats a second connection on the same
    // sessionId as a reconnect and closes the first, whose `onclose` then reconnects — a
    // 2-second churn that silently drops broadcasts, because a message sent to a closing
    // socket is discarded. StrictMode's double-mount is enough to start it.
    const existing = socketRef.current;
    if (
      existing &&
      (existing.readyState === WebSocket.CONNECTING || existing.readyState === WebSocket.OPEN)
    ) {
      return;
    }
    closingRef.current = false;

    const socket = new WebSocket(socketUrl());
    socketRef.current = socket;

    // Only claim we're waking the server if the connection is actually taking a while —
    // otherwise every join flashes a scary message (§9).
    later(() => {
      if (socket.readyState === WebSocket.CONNECTING) setStatus('waking');
    }, WAKING_AFTER_MS);

    socket.onopen = () => {
      const intent = intentRef.current;
      if (!intent) return;
      try {
        const sessionId = getSessionId();
        // A reconnect is just a `join` carrying the same sessionId — the server treats it
        // as restoring our slot, so this one path covers first join, reload and dropped
        // WiFi.
        send(
          intent.kind === 'create'
            ? { type: 'create', displayName: intent.name, sessionId }
            : { type: 'join', code: intent.code, displayName: intent.name, sessionId },
        );
      } catch (err) {
        // Anything thrown here used to leave the UI spinning forever with no clue, because
        // the socket was open and simply never sent anything. Fail loudly instead.
        console.error('Could not send join', err);
        goHome('Something went wrong starting your session. Try reloading.');
      }
    };

    socket.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }

      if (msg.type === 'roomState') {
        clearTimers();
        setRoom(msg);
        setNotice(null);
        setStatus('inRoom');
        const me = msg.players.find((p) => p.id === msg.youId);
        // Promote a create into a join, so any later reconnect targets this room.
        intentRef.current = { kind: 'join', code: msg.code, name: me?.name ?? '' };
        if (me) rememberRoom({ code: msg.code, name: me.name });

        if (msg.round) {
          // Reconnecting into a live round: adopt it without restarting the player's clock
          // if it's the round we were already on (§4).
          const snapshot = msg.round;
          setRound((prev) =>
            prev && prev.index === snapshot.index
              ? { ...prev, youGuessed: snapshot.youGuessed }
              : {
                  index: snapshot.index,
                  panoId: snapshot.panoId,
                  durationMs: ROUND_MS,
                  remainingMs: snapshot.remainingMs,
                  youGuessed: snapshot.youGuessed,
                },
          );
        }
        if (msg.phase === 'LOBBY') {
          setRound(null);
          setResults(null);
          setFinalBoard(null);
        }
        return;
      }

      if (msg.type === 'roundStart') {
        setResults(null);
        setFinalBoard(null);
        setRound({
          index: msg.roundIndex,
          panoId: msg.panoId,
          durationMs: msg.durationMs,
          remainingMs: msg.durationMs + LOAD_HEADROOM_MS,
          youGuessed: false,
        });
        return;
      }

      if (msg.type === 'guessAck') {
        setRound((prev) => (prev ? { ...prev, youGuessed: true } : prev));
        return;
      }

      if (msg.type === 'roundEnd') {
        setResults(msg);
        setRound(null);
        return;
      }

      if (msg.type === 'gameEnd') {
        setFinalBoard(msg.leaderboard);
        setResults(null);
        setRound(null);
        return;
      }

      if (msg.type === 'roomClosed') {
        goHome(
          msg.reason === 'hostLeft'
            ? 'The host left, so the room closed.'
            : msg.reason === 'kicked'
              ? 'The host removed you from the room.'
              : 'That room was closed after sitting idle.',
        );
        return;
      }

      if (msg.type === 'error') {
        // Only errors that mean "you are not in a room" send you home. A transient one — the
        // location pool still filling, a stale button press — must never eject the host from
        // their own room; it's a message on the screen they're already on.
        const FATAL: ErrorCode[] = [
          'ROOM_NOT_FOUND',
          'ROOM_FULL',
          'NAME_TAKEN',
          'NAME_INVALID',
          'CODE_INVALID',
        ];

        if (msg.code === 'ROOM_LOCKED') {
          // Hold them rather than bouncing them; they're admitted automatically once the
          // room returns to LOBBY (§4).
          setStatus('waitingForGame');
          setNotice(msg.message);
          later(() => {
            const intent = intentRef.current;
            const sessionId = getSessionId();
            if (intent?.kind === 'join') {
              send({ type: 'join', code: intent.code, displayName: intent.name, sessionId });
            }
          }, LOCKED_RETRY_MS);
          return;
        }

        if (FATAL.includes(msg.code)) {
          goHome(msg.message);
          return;
        }
        setNotice(msg.message);
      }
    };

    socket.onclose = () => {
      // Only if this is still the live socket. A stale socket closing late would otherwise
      // null out the reference to the good one and restart the very churn fixed above.
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      if (closingRef.current || !intentRef.current) return;
      // Phones drop sockets constantly — screen lock, backgrounding, WiFi handoff. Keep
      // retrying; the sessionId is what makes it a reconnect rather than a new player.
      setStatus('reconnecting');
      later(connect, RETRY_MS);
    };
  }, [goHome, send]);

  const start = useCallback(
    (intent: Intent) => {
      clearTimers();
      // A new intent means a different room, so drop any existing socket deliberately
      // rather than letting connect()'s guard reuse it.
      closingRef.current = true;
      socketRef.current?.close();
      socketRef.current = null;
      intentRef.current = intent;
      setNotice(null);
      setStatus('connecting');
      connect();
    },
    [connect],
  );

  // A reload, or Safari discarding the tab mid-game, should land back in the room.
  useEffect(() => {
    const last = recallRoom();
    if (last) start({ kind: 'join', code: last.code, name: last.name });
    return () => {
      // Closing on unmount is what makes StrictMode's double-mount harmless: the first
      // socket goes away before the second is opened, so the server never sees two.
      closingRef.current = true;
      clearTimers();
      socketRef.current?.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The phase is authoritative, but the payload that draws the screen arrives as a separate
   * message — so anything that loses one message strands the UI on a spinner forever. Ask
   * again until it turns up. `join` is idempotent for a known sessionId and replays the
   * current phase, so no extra message type is needed.
   */
  const phase = room?.phase;
  const missingPayload =
    (phase === 'ROUND_RESULTS' && !results) || (phase === 'GAME_OVER' && !finalBoard);

  useEffect(() => {
    if (!missingPayload) return;
    const resync = window.setInterval(() => {
      const intent = intentRef.current;
      if (intent?.kind !== 'join') return;
      send({
        type: 'join',
        code: intent.code,
        displayName: intent.name,
        sessionId: getSessionId(),
      });
    }, 1_500);
    return () => window.clearInterval(resync);
  }, [missingPayload, send]);

  const createRoom = useCallback((name: string) => start({ kind: 'create', name }), [start]);
  const joinRoom = useCallback(
    (code: string, name: string) => start({ kind: 'join', code, name }),
    [start],
  );
  const leaveRoom = useCallback(() => {
    send({ type: 'leave' });
    goHome(null);
  }, [goHome, send]);
  const kick = useCallback((playerId: string) => send({ type: 'kick', playerId }), [send]);
  const startRound = useCallback(() => send({ type: 'startRound' }), [send]);
  const advance = useCallback(() => send({ type: 'advance' }), [send]);

  const submitGuess = useCallback(
    (at: LatLng, elapsedMs: number) => {
      // Optimistic: the round's waiting screen should appear on tap, not a round trip later.
      // The server ignores duplicates, so a racing auto-submit is harmless (§5).
      setRound((prev) => (prev ? { ...prev, youGuessed: true } : prev));
      send({ type: 'submitGuess', lat: at.lat, lng: at.lng, elapsedMs });
    },
    [send],
  );

  const me = room?.players.find((p) => p.id === room.youId) ?? null;

  return {
    status,
    room,
    me,
    notice,
    round,
    results,
    finalBoard,
    createRoom,
    joinRoom,
    leaveRoom,
    kick,
    startRound,
    advance,
    submitGuess,
    setNotice,
  };
}
