import { GameOver } from './screens/GameOver';
import { Home } from './screens/Home';
import { Lobby } from './screens/Lobby';
import { Results } from './screens/Results';
import { Round } from './screens/Round';
import { useRoom } from './useRoom';

export default function App() {
  const {
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
  } = useRoom();

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
          <Round round={round} totalRounds={room.totalRounds} onGuess={submitGuess} />
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
            onAdvance={advance}
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
