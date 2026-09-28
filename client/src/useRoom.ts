import { useCallback, useEffect, useRef, useState } from 'react';
import { LOAD_HEADROOM_MS, ROUND_MS } from '@pangoguessr/shared';
import type {
  ErrorCode,
  GuessProgress,
  LatLng,
  ReconnectDiag,
  RoomStateMsg,
  ServerMessage,
} from '@pangoguessr/shared';
import { Connection, type ConnectionEvents } from './connection';
import { forgetRoom, getSessionId, recallRoom, rememberRoom } from './session';

export type RoundView = {
  index: number;
  panoId: string;
  /** The player's own clock, which starts when their panorama renders (§5). */
  durationMs: number;
  /**
   * When the room's backstop fires, on this device's clock — it bounds the player's own 40s.
   * Refreshed from every snapshot, so a reconnect corrects it instead of trusting the
   * countdown from before the drop.
   */
  roomDeadline: number;
  /**
   * When the player's own clock started. Held here rather than in the round screen, so
   * nothing that remounts the screen can hand them a fresh 40 seconds.
   */
  startedAt: number | null;
  youGuessed: boolean;
  /** "5 of 8 guessed" — a count only (§8). Null until the server has said. */
  progress: GuessProgress | null;
};

export type ResultsView = Extract<ServerMessage, { type: 'roundEnd' }>;
/** The podium: final standings, plus every round for the recap. */
export type FinalView = Extract<ServerMessage, { type: 'gameEnd' }>;

export type Status =
  | 'home'
  | 'connecting'
  /** Render free tier spins down after ~15min idle and takes 30–60s to wake (§9). */
  | 'waking'
  | 'inRoom'
  /**
   * Getting back into a room from a fresh page load — a reload mid-game. Once in a room, a
   * dropped socket doesn't change the status at all: the game stays on screen, and
   * `linkDownSince` says it's reconnecting.
   */
  | 'reconnecting'
  /** Room is mid-game; we hold and retry until it returns to LOBBY (§4). */
  | 'waitingForGame'
  /** The same player connected from another tab, so this one has stood down. */
  | 'replaced';

export type Intent = { kind: 'create'; name: string } | { kind: 'join'; code: string; name: string };

const LOCKED_RETRY_MS = 3_000;

/** A guess the server hasn't acknowledged yet, so a dropped socket can't lose it (§5). */
type PendingGuess = { roundIndex: number; lat: number; lng: number; elapsedMs: number };

/**
 * `initialIntent` is a hub hand-off (session.ts), which wins over rejoining the last room:
 * the hub has just put this player somewhere new.
 */
export function useRoom(initialIntent: Intent | null = null) {
  const [status, setStatus] = useState<Status>('home');
  const [room, setRoom] = useState<RoomStateMsg | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [round, setRound] = useState<RoundView | null>(null);
  const [results, setResults] = useState<ResultsView | null>(null);
  const [final, setFinal] = useState<FinalView | null>(null);
  /** Positive means they moved up the board since the previous round. */
  const [rankDeltas, setRankDeltas] = useState<Record<string, number>>({});
  /**
   * When the socket went, while we're in a room and getting it back. The game stays on screen
   * underneath: a full-screen "Reconnecting" used to unmount the round, losing the pin and
   * restarting the clock, for what is usually a one-second blip.
   */
  const [linkDownSince, setLinkDownSince] = useState<number | null>(null);
  /** Last round's ranks, kept client-side — the server has no reason to track history. */
  const previousRanksRef = useRef<Record<string, number> | null>(null);

  const intentRef = useRef<Intent | null>(null);
  const timersRef = useRef<number[]>([]);
  const pendingGuessRef = useRef<PendingGuess | null>(null);

  /** The latest render's handlers, so the connection never calls into a stale one. */
  const eventsRef = useRef<ConnectionEvents | null>(null);
  const [connection] = useState(
    () =>
      new Connection({
        onOpen: (diag) => eventsRef.current?.onOpen(diag),
        onMessage: (msg) => eventsRef.current?.onMessage(msg),
        onDown: (since) => eventsRef.current?.onDown(since),
        onSlow: () => eventsRef.current?.onSlow(),
        onReplaced: () => eventsRef.current?.onReplaced(),
      }),
  );

  const clearTimers = () => {
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current = [];
  };
  const later = (fn: () => void, ms: number) => {
    timersRef.current.push(window.setTimeout(fn, ms));
  };

  const sendJoin = useCallback(
    (diag?: ReconnectDiag) => {
      const intent = intentRef.current;
      if (intent?.kind !== 'join') return;
      connection.send({
        type: 'join',
        code: intent.code,
        displayName: intent.name,
        sessionId: getSessionId(),
        ...(diag ? { diag } : {}),
      });
    },
    [connection],
  );

  const goHome = useCallback(
    (message: string | null) => {
      connection.stop();
      clearTimers();
      intentRef.current = null;
      pendingGuessRef.current = null;
      forgetRoom();
      setRoom(null);
      setRound(null);
      setResults(null);
      setFinal(null);
      setLinkDownSince(null);
      setNotice(message);
      setStatus('home');
    },
    [connection],
  );

  const start = useCallback(
    (intent: Intent, reload = false) => {
      clearTimers();
      intentRef.current = intent;
      pendingGuessRef.current = null;
      setNotice(null);
      setLinkDownSince(null);
      setStatus(reload ? 'reconnecting' : 'connecting');
      // A new intent means a different room, so any existing socket is dropped and a fresh
      // one opened.
      connection.start({ reload });
    },
    [connection],
  );

  eventsRef.current = {
    onOpen(diag) {
      const intent = intentRef.current;
      if (!intent) return;
      try {
        // A reconnect is just a `join` carrying the same sessionId — the server treats it as
        // restoring our slot, so this one path covers first join, reload and dropped WiFi.
        if (intent.kind === 'create') {
          connection.send({ type: 'create', displayName: intent.name, sessionId: getSessionId() });
        } else {
          sendJoin(diag);
        }
      } catch (err) {
        // Anything thrown here used to leave the UI spinning forever with no clue, because
        // the socket was open and simply never sent anything. Fail loudly instead.
        console.error('Could not send join', err);
        goHome('Something went wrong starting your session. Try reloading.');
      }
    },

    onDown(since) {
      // In a room, the game stays up and says it's reconnecting. Anywhere else — connecting,
      // waiting out a locked room — the screen already says we're working on it.
      if (status === 'inRoom') setLinkDownSince((prev) => prev ?? since);
    },

    onSlow() {
      setStatus((s) => (s === 'connecting' || s === 'reconnecting' ? 'waking' : s));
    },

    onReplaced() {
      clearTimers();
      setLinkDownSince(null);
      setStatus('replaced');
    },

    onMessage(msg) {
      if (msg.type === 'roomState') {
        clearTimers();
        connection.joined();
        setRoom(msg);
        setNotice(null);
        setLinkDownSince(null);
        setStatus('inRoom');
        const me = msg.players.find((p) => p.id === msg.youId);
        // Promote a create into a join, so any later reconnect targets this room.
        intentRef.current = { kind: 'join', code: msg.code, name: me?.name ?? '' };
        if (me) rememberRoom({ code: msg.code, name: me.name });

        const snapshot = msg.round;
        const pending = pendingGuessRef.current;
        if (pending && (!snapshot || pending.roundIndex !== snapshot.index || snapshot.youGuessed)) {
          pendingGuessRef.current = null;
        }

        if (snapshot) {
          const unacknowledged = pendingGuessRef.current;
          // Made while the socket was down, or lost with it. A duplicate is ignored and
          // acknowledged again, so resending is always safe.
          if (unacknowledged) connection.send({ type: 'submitGuess', ...unacknowledged });

          const roomDeadline = Date.now() + snapshot.remainingMs;
          const youGuessed = snapshot.youGuessed || unacknowledged !== null;
          // Reconnecting into the round we were already on: keep the player's clock and pin,
          // but take the room's deadline from the server rather than our old countdown (§4).
          setRound((prev) =>
            prev && prev.index === snapshot.index
              ? { ...prev, roomDeadline, youGuessed, progress: snapshot.progress }
              : {
                  index: snapshot.index,
                  panoId: snapshot.panoId,
                  durationMs: ROUND_MS,
                  roomDeadline,
                  startedAt: null,
                  youGuessed,
                  progress: snapshot.progress,
                },
          );
        }
        if (msg.phase === 'LOBBY') {
          setRound(null);
          setResults(null);
          setFinal(null);
          // A new game starts everyone level, so last game's movement is meaningless.
          previousRanksRef.current = null;
          setRankDeltas({});
        }
        return;
      }

      if (msg.type === 'roundStart') {
        if (pendingGuessRef.current?.roundIndex !== msg.roundIndex) pendingGuessRef.current = null;
        setResults(null);
        setFinal(null);
        setRound({
          index: msg.roundIndex,
          panoId: msg.panoId,
          durationMs: msg.durationMs,
          roomDeadline: Date.now() + msg.durationMs + LOAD_HEADROOM_MS,
          startedAt: null,
          youGuessed: false,
          progress: null,
        });
        return;
      }

      if (msg.type === 'guessProgress') {
        setRound((prev) =>
          prev?.index === msg.roundIndex ? { ...prev, progress: msg.progress } : prev,
        );
        return;
      }

      if (msg.type === 'guessAck') {
        if (pendingGuessRef.current?.roundIndex === msg.roundIndex) pendingGuessRef.current = null;
        setRound((prev) => (prev?.index === msg.roundIndex ? { ...prev, youGuessed: true } : prev));
        return;
      }

      if (msg.type === 'roundEnd') {
        pendingGuessRef.current = null;
        const previous = previousRanksRef.current;
        // Round 1 has nothing to compare against, so no chevrons appear at all.
        setRankDeltas(
          previous
            ? Object.fromEntries(
                msg.leaderboard.map((row) => [
                  row.playerId,
                  (previous[row.playerId] ?? row.rank) - row.rank,
                ]),
              )
            : {},
        );
        previousRanksRef.current = Object.fromEntries(
          msg.leaderboard.map((row) => [row.playerId, row.rank]),
        );
        setResults(msg);
        setRound(null);
        return;
      }

      if (msg.type === 'gameEnd') {
        setFinal(msg);
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
          later(() => sendJoin(), LOCKED_RETRY_MS);
          return;
        }

        if (FATAL.includes(msg.code)) {
          goHome(msg.message);
          return;
        }
        setNotice(msg.message);
      }
    },
  };

  // A hub hand-off lands in its room; otherwise a reload, or Safari discarding the tab
  // mid-game, should land back in the last one.
  useEffect(() => {
    if (initialIntent) {
      start(initialIntent);
    } else {
      const last = recallRoom();
      if (last) start({ kind: 'join', code: last.code, name: last.name }, true);
    }
    return () => {
      // Closing on unmount is what makes StrictMode's double-mount harmless: the first
      // socket goes away before the second is opened, so the server never sees two.
      connection.stop();
      clearTimers();
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
    (phase === 'ROUND_RESULTS' && !results) || (phase === 'GAME_OVER' && !final);

  useEffect(() => {
    if (!missingPayload) return;
    const resync = window.setInterval(() => sendJoin(), 1_500);
    return () => window.clearInterval(resync);
  }, [missingPayload, sendJoin]);

  const createRoom = useCallback((name: string) => start({ kind: 'create', name }), [start]);
  const joinRoom = useCallback(
    (code: string, name: string) => start({ kind: 'join', code, name }),
    [start],
  );
  const leaveRoom = useCallback(() => {
    connection.send({ type: 'leave' });
    goHome(null);
  }, [connection, goHome]);

  /** "Play here" after another tab took over: take the slot back, which stands that tab down. */
  const resume = useCallback(() => {
    setLinkDownSince(Date.now());
    setStatus('inRoom');
    connection.start({ inRoom: true });
  }, [connection]);

  const kick = useCallback(
    (playerId: string) => connection.send({ type: 'kick', playerId }),
    [connection],
  );
  const startRound = useCallback(() => connection.send({ type: 'startRound' }), [connection]);
  const advance = useCallback(() => connection.send({ type: 'advance' }), [connection]);
  const cancelGame = useCallback(() => connection.send({ type: 'cancelGame' }), [connection]);
  /** Round 1's panorama has loaded on this phone — the lobby's ready tick (§7). */
  const reportPreloaded = useCallback(
    (panoId: string) => connection.send({ type: 'preloaded', panoId }),
    [connection],
  );

  /** Their panorama is visible, so their 40 seconds start now (§5) — once per round. */
  const markRoundStarted = useCallback((index: number) => {
    setRound((prev) =>
      prev && prev.index === index && prev.startedAt === null
        ? { ...prev, startedAt: Date.now() }
        : prev,
    );
  }, []);

  const submitGuess = useCallback(
    (roundIndex: number, at: LatLng, elapsedMs: number) => {
      // Kept until acknowledged, and resent after a reconnect: a guess made while the socket
      // was down used to be dropped without a word, and scored 0 behind "Guess locked in".
      const guess: PendingGuess = { roundIndex, lat: at.lat, lng: at.lng, elapsedMs };
      pendingGuessRef.current = guess;
      // Optimistic: the round's waiting screen should appear on tap, not a round trip later.
      // The server ignores duplicates, so a racing auto-submit is harmless (§5).
      setRound((prev) => (prev?.index === roundIndex ? { ...prev, youGuessed: true } : prev));
      connection.send({ type: 'submitGuess', ...guess });
    },
    [connection],
  );

  const me = room?.players.find((p) => p.id === room.youId) ?? null;

  return {
    status,
    room,
    me,
    notice,
    round,
    results,
    final,
    rankDeltas,
    linkDownSince,
    createRoom,
    joinRoom,
    leaveRoom,
    resume,
    kick,
    startRound,
    advance,
    cancelGame,
    reportPreloaded,
    markRoundStarted,
    submitGuess,
    setNotice,
  };
}
