import { Home } from './screens/Home';
import { Lobby } from './screens/Lobby';
import { useRoom } from './useRoom';

export default function App() {
  const { status, room, me, notice, createRoom, joinRoom, leaveRoom, kick } = useRoom();

  if (status === 'inRoom' && room) {
    return <Lobby room={room} me={me} onLeave={leaveRoom} onKick={kick} />;
  }

  if (status !== 'home') {
    return <Connecting status={status} notice={notice} onCancel={leaveRoom} />;
  }

  return <Home notice={notice} onCreate={createRoom} onJoin={joinRoom} />;
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
