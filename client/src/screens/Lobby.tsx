import { MAX_PLAYERS } from '@pangoguessr/shared';
import type { PublicPlayer, RoomStateMsg } from '@pangoguessr/shared';
import { QrCode } from '../components/QrCode';

export function Lobby({
  room,
  me,
  onLeave,
  onKick,
  onStart,
  notice,
}: {
  room: RoomStateMsg;
  me: PublicPlayer | null;
  onLeave: () => void;
  onKick: (playerId: string) => void;
  onStart: () => void;
  notice: string | null;
}) {
  const joinUrl = `${location.origin}/?c=${room.code}`;
  const isHost = me?.isHost ?? false;

  return (
    <main className="screen screen--lobby">
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <section className="join-card">
        <p className="join-card__hint">Join at <strong>{location.host}</strong> with code</p>
        <p className="code" aria-label={`Room code ${room.code.split('').join(' ')}`}>
          {room.code}
        </p>
        <QrCode url={joinUrl} size={180} />
      </section>

      <section className="players">
        <h2 className="players__title">
          Players <span className="players__count">{room.players.length}/{MAX_PLAYERS}</span>
        </h2>
        <ul className="players__list">
          {room.players.map((player) => (
            <li key={player.id} className={player.connected ? 'player' : 'player player--away'}>
              <span className={`dot ${player.connected ? 'dot--on' : 'dot--off'}`} aria-hidden />
              <span className="player__name">
                {player.name}
                {player.id === room.youId && <span className="player__you"> (you)</span>}
              </span>
              {player.isHost && <span className="badge">Host</span>}
              {!player.connected && <span className="player__status">reconnecting…</span>}
              {isHost && player.id !== room.youId && (
                <button
                  className="player__kick"
                  type="button"
                  onClick={() => onKick(player.id)}
                  aria-label={`Remove ${player.name}`}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <footer className="lobby__actions">
        {isHost ? (
          <>
            <button className="button button--primary" type="button" onClick={onStart}>
              Start game
            </button>
            <p className="hint">
              {room.totalRounds} rounds. The room locks once you start — nobody can join
              until it’s over.
            </p>
          </>
        ) : (
          <p className="hint">Waiting for the host to start.</p>
        )}
        <button className="button button--ghost" type="button" onClick={onLeave}>
          Leave room
        </button>
        {isHost && (
          <p className="hint hint--warn">
            You’re the host — if you close this, the room closes for everyone.
          </p>
        )}
      </footer>
    </main>
  );
}
