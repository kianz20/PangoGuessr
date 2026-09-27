import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RoomStateMsg } from '@pangoguessr/shared';
import { Admin } from './admin/Admin';
import { ConnectionBanner } from './components/ConnectionBanner';
import { preloadPanoramas } from './panoramas';
import { GameOver } from './screens/GameOver';
import { Home } from './screens/Home';
import { Lobby } from './screens/Lobby';
import { Results } from './screens/Results';
import { Round } from './screens/Round';
import { readHandoff } from './session';
import { useRoom } from './useRoom';

export default function App() {
  // No router: one extra path doesn't justify the dependency, and /admin shares nothing
  // with the game's state.
  if (location.pathname.replace(/\/$/, '') === '/admin') return <Admin />;

  return <Game />;
}

function Game() {
  // A hub (e.g. PangoGaming) handing off a voted-in lobby: read once, then gone from the URL,
  // so a reload rejoins the room it made instead of acting on the hand-off again.
  const [handoff] = useState(readHandoff);

  const {
    status,
    room,
    me,
    notice,
    round,
    results,
    finalBoard,
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
    markRoundStarted,
    submitGuess,
  } = useRoom(handoff);

  const notifiedRef = useRef(false);

  // Once our room exists, tell the hub what code it got so it can redirect the other players.
  useEffect(() => {
    if (handoff?.kind !== 'create' || !handoff.notify) return;
    if (notifiedRef.current || !room || !me?.isHost) return;
    notifiedRef.current = true;
    fetch(handoff.notify, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: room.code }),
    }).catch(() => {});
  }, [handoff, room, me]);

  // Every phone loads the rest of the game's panoramas ahead of their rounds, so nobody is
  // waiting on imagery mid-game (§7). Held through a reconnect — `room` survives one — and
  // dropped on leaving.
  const upcoming = room ? panoramasStillToPlay(room) : [];
  const upcomingKey = upcoming.join(' ');
  useEffect(() => {
    preloadPanoramas(upcoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingKey]);

  if (status === 'replaced') return <Replaced onPlayHere={resume} />;

  if (status !== 'home' && status !== 'inRoom') {
    return <Connecting status={status} notice={notice} onCancel={leaveRoom} />;
  }

  if (status === 'inRoom' && room) {
    const isHost = me?.isHost ?? false;
    let screen: ReactNode;

    // The room's phase is authoritative; the payload for that phase may arrive a beat later,
    // which is what the fallbacks below cover.
    switch (room.phase) {
      case 'ROUND_ACTIVE':
        screen = round ? (
          <Round
            round={round}
            totalRounds={room.totalRounds}
            isHost={isHost}
            onGuess={submitGuess}
            onClockStart={markRoundStarted}
            onCancelGame={cancelGame}
          />
        ) : (
          <Waiting title="Loading the round" />
        );
        break;

      case 'ROUND_RESULTS':
        screen = results ? (
          <Results
            results={results}
            youId={room.youId}
            isHost={isHost}
            totalRounds={room.totalRounds}
            rankDeltas={rankDeltas}
            onAdvance={advance}
            onCancelGame={cancelGame}
          />
        ) : (
          <Waiting title="Scoring the round" />
        );
        break;

      case 'GAME_OVER':
        screen = finalBoard ? (
          <GameOver
            leaderboard={finalBoard}
            youId={room.youId}
            isHost={isHost}
            onPlayAgain={advance}
          />
        ) : (
          <Waiting title="Counting up" />
        );
        break;

      default:
        screen = (
          <Lobby
            room={room}
            me={me}
            notice={notice}
            onLeave={leaveRoom}
            onKick={kick}
            onStart={startRound}
          />
        );
    }

    // A dropped socket leaves the screen exactly as it was, with a banner over it.
    return (
      <>
        {screen}
        <ConnectionBanner since={linkDownSince} onLeave={leaveRoom} />
      </>
    );
  }

  return <Home notice={notice} onCreate={createRoom} onJoin={joinRoom} />;
}

/**
 * Another tab took this player's place in the room. Offered back rather than taken back
 * automatically: two tabs each reconnecting on their own used to kick each other out for
 * as long as both stayed open.
 */
function Replaced({ onPlayHere }: { onPlayHere: () => void }) {
  return (
    <main className="screen screen--status">
      <h1 className="status__title">Playing in another tab</h1>
      <p className="status__body">
        This game is open in another tab or window. Only one of them can play at a time.
      </p>
      <button className="button button--primary" type="button" onClick={onPlayHere}>
        Play here instead
      </button>
    </main>
  );
}

/** The live round's panorama and every one after it; a finished round's is let go. */
function panoramasStillToPlay(room: RoomStateMsg): string[] {
  switch (room.phase) {
    case 'LOBBY':
      return room.panoIds;
    case 'ROUND_ACTIVE':
      return room.panoIds.slice(room.roundIndex);
    case 'ROUND_RESULTS':
      return room.panoIds.slice(room.roundIndex + 1);
    case 'GAME_OVER':
      return [];
  }
}

function Waiting({ title }: { title: string }) {
  return (
    <main className="screen screen--status">
      <div className="spinner" aria-hidden />
      <h1 className="status__title">{title}</h1>
    </main>
  );
}

function Connecting({
  status,
  notice,
  onCancel,
}: {
  status: string;
  notice: string | null;
  onCancel: () => void;
}) {
  // The cold start is handled in the UI rather than paid away (§9). Without an explicit
  // "waking up" state the first person to scan the QR sees a broken app.
  const copy =
    status === 'waking'
      ? { title: 'Waking the server up', body: 'This takes about 30 seconds. Worth it — it’s free.' }
      : status === 'reconnecting'
        ? { title: 'Reconnecting', body: 'Hold tight — your place and score are kept.' }
        : status === 'waitingForGame'
          ? { title: 'Game in progress', body: notice ?? 'You’ll join automatically when it ends.' }
          : { title: 'Connecting', body: '' };

  return (
    <main className="screen screen--status">
      <div className="spinner" aria-hidden />
      <h1 className="status__title">{copy.title}</h1>
      {copy.body && <p className="status__body">{copy.body}</p>}
      <button className="button button--ghost" type="button" onClick={onCancel}>
        Cancel
      </button>
    </main>
  );
}
