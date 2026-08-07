import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, RoomStateMsg, ServerMessage } from '@pangoguessr/shared';
import { forgetRoom, getSessionId, recallRoom, rememberRoom } from './session';

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
        return;
      }

      if (msg.type === 'roomClosed') {
        goHome(
          msg.reason === 'hostLeft'
            ? 'The host left, so the room closed.'
            : 'That room was closed after sitting idle.',
        );
        return;
      }

      if (msg.type === 'error') {
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
        goHome(msg.message);
      }
    };

    socket.onclose = () => {
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
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const me = room?.players.find((p) => p.id === room.youId) ?? null;

  return { status, room, me, notice, createRoom, joinRoom, leaveRoom, kick, setNotice };
}
