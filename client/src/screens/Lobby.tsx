import { useEffect, useRef } from 'react';
import { MAX_PLAYERS } from '@pangoguessr/shared';
import type { PublicPlayer, RoomStateMsg } from '@pangoguessr/shared';
import { Avatar } from '../components/Avatar';
import { SoundToggle } from '../components/Brand';
import { QrCode } from '../components/QrCode';
import { useFlip } from '../motion';
import type { ColorOf } from '../players';
import { play } from '../sound';

export function Lobby({
  room,
  me,
  colorOf,
  onLeave,
  onKick,
  onStart,
  notice,
}: {
  room: RoomStateMsg;
  me: PublicPlayer | null;
  colorOf: ColorOf;
  onLeave: () => void;
  onKick: (playerId: string) => void;
  onStart: () => void;
  notice: string | null;
}) {
  const joinUrl = `${location.origin}/?c=${room.code}`;
  const isHost = me?.isHost ?? false;
  const listRef = useRef<HTMLUListElement>(null);

  // Someone leaving from the middle closes the gap with a slide rather than a jump. Joiners
  // arrive at the bottom and animate themselves in (CSS, on mount).
  const order = room.players.map((p) => p.id).join(' ');
  useFlip(listRef, order);

  // A blip for each new arrival — not for the people already here when this phone joined.
  const seenRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const seen = seenRef.current;
    if (seen && room.players.some((p) => !seen.has(p.id) && p.id !== room.youId)) play('join');
    seenRef.current = new Set(room.players.map((p) => p.id));
  }, [order, room]);

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
          <span>
            Players <span className="players__count">{room.players.length}/{MAX_PLAYERS}</span>
          </span>
          <ReadyCount room={room} />
        </h2>
        <ul ref={listRef} className="players__list">
          {room.players.map((player) => (
            <li
              key={player.id}
              data-flip-id={player.id}
              className={player.connected ? 'player' : 'player player--away'}
            >
              <span className="player__avatar">
                {/* The same chip they'll wear on the reveal map, so people learn it here. */}
                <Avatar name={player.name} color={colorOf(player.id)} you={player.id === room.youId} />
                <ReadyBadge player={player} dealt={room.panoIds.length > 0} />
              </span>
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
        <div className="lobby__row">
          <SoundToggle />
          <button className="button button--ghost" type="button" onClick={onLeave}>
            Leave room
          </button>
        </div>
        <p className="hint">Sound’s off on every phone to start with. One phone with it on is plenty for a room.</p>
        {isHost && (
          <p className="hint hint--warn">
            You’re the host — if you close this, the room closes for everyone.
          </p>
        )}
      </footer>
    </main>
  );
}

/**
 * How many phones have round 1 loaded (§7), so the host can see whether Start will leave anyone
 * watching a spinner. Advice, not a gate: Start works either way.
 */
function ReadyCount({ room }: { room: RoomStateMsg }) {
  if (room.panoIds.length === 0) {
    return <span className="players__ready">Finding locations…</span>;
  }
  const ready = room.players.filter((p) => p.connected && p.ready).length;
  const total = room.players.length;
  return ready === total ? (
    <span className="players__ready players__ready--all">
      {total === 1 ? 'Ready' : 'Everyone’s ready'}
    </span>
  ) : (
    <span className="players__ready">
      {ready} of {total} ready
    </span>
  );
}

function ReadyBadge({ player, dealt }: { player: PublicPlayer; dealt: boolean }) {
  if (!player.connected || !dealt) return null;
  return player.ready ? (
    <span className="ready-badge ready-badge--ready" role="img" aria-label="Ready">
      <svg viewBox="0 0 12 12" aria-hidden>
        <path d="M3 6.2l2 2 4-4.4" />
      </svg>
    </span>
  ) : (
    <span className="ready-badge ready-badge--loading" role="img" aria-label="Still loading round 1" />
  );
}
