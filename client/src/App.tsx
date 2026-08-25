import { useEffect, useRef } from 'react';
import { normalizeCode } from '@pangoguessr/shared';
import { Admin } from './admin/Admin';
import { GameOver } from './screens/GameOver';
import { Home } from './screens/Home';
import { Lobby } from './screens/Lobby';
import { Results } from './screens/Results';
import { Round } from './screens/Round';
import { useRoom } from './useRoom';

export default function App() {
  // No router: one extra path doesn't justify the dependency, and /admin shares nothing
  // with the game's state.
  if (location.pathname.replace(/\/$/, '') === '/admin') return <Admin />;

  return <Game />;
}

function Game() {
  const {
    status,
    room,
    me,
    notice,
    round,
    results,
    finalBoard,
    rankDeltas,
    createRoom,
    joinRoom,
    leaveRoom,
    kick,
    startRound,
    advance,
    cancelGame,
    submitGuess,
  } = useRoom();

  // A hub (e.g. PangoGaming) handing off a voted-in lobby lands here with ?autohost=1&n=Host
  // and ?c=<code>&n=<name> for players — see the effects below.
  const params = new URLSearchParams(location.search);
  const notifiedRef = useRef(false);

  useEffect(() => {
    if (status !== 'home') return;
    if (params.get('autohost') === '1') {
      createRoom(params.get('n')?.trim() || 'Host');
      return;
    }
    const code = normalizeCode(params.get('c') ?? '');
    const name = params.get('n')?.trim();
    if (code && name && params.get('pid')) joinRoom(code, name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Once our room exists, tell the hub what code it got so it can redirect the other players.
  useEffect(() => {
    const notify = params.get('notify');
    if (!notify || notifiedRef.current || !room || !me?.isHost) return;
    notifiedRef.current = true;
    fetch(notify, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: room.code }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, me]);

  if (status !== 'home' && status !== 'inRoom') {
    return <Connecting status={status} notice={notice} onCancel={leaveRoom} />;
  }

  if (status === 'inRoom' && room) {
    const isHost = me?.isHost ?? false;

    // The room's phase is authoritative; the payload for that phase may arrive a beat later,
    // which is what the fallbacks below cover.
    switch (room.phase) {
      case 'ROUND_ACTIVE':
        return round ? (
          <Round
            round={round}
            totalRounds={room.totalRounds}
            isHost={isHost}
            onGuess={submitGuess}
            onCancelGame={cancelGame}
          />
        ) : (
          <Waiting title="Loading the round" />
        );

      case 'ROUND_RESULTS':
        return results ? (
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

      case 'GAME_OVER':
        return finalBoard ? (
          <GameOver
            leaderboard={finalBoard}
            youId={room.youId}
            isHost={isHost}
            onPlayAgain={advance}
          />
        ) : (
          <Waiting title="Counting up" />
        );

      default:
        return (
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
  }

  return <Home notice={notice} onCreate={createRoom} onJoin={joinRoom} />;
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
