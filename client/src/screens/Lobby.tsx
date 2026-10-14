import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { MAX_NAME_LENGTH, MAX_PLAYERS, normalizeDisplayName } from '@pangoguessr/shared';
import type { PublicPlayer, RoomStateMsg } from '@pangoguessr/shared';
import { Avatar } from '../components/Avatar';
import { SoundToggle } from '../components/Brand';
import { QrCode } from '../components/QrCode';
import { useFlip } from '../motion';
import type { ColorOf } from '../players';
import { play } from '../sound';

/** Phone QR stays the enlarged lobby size. A wide host window fills the left column. */
const QR_PHONE = 234;
const QR_DESKTOP = 720;
const HOST_COLUMNS = '(min-width: 1024px)';

function useWideLobby() {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(HOST_COLUMNS);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(HOST_COLUMNS).matches,
    () => false,
  );
}

export function Lobby({
  room,
  me,
  colorOf,
  onLeave,
  onKick,
  onStart,
  onRename,
  renameError,
  onDismissRenameError,
  notice,
}: {
  room: RoomStateMsg;
  me: PublicPlayer | null;
  colorOf: ColorOf;
  onLeave: () => void;
  onKick: (playerId: string) => void;
  onStart: () => void;
  onRename: (name: string) => void;
  renameError: string | null;
  onDismissRenameError: () => void;
  notice: string | null;
}) {
  const joinUrl = `${location.origin}/?c=${room.code}`;
  const isHost = me?.isHost ?? false;
  const wide = useWideLobby();
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
    <main className={`screen screen--lobby${isHost ? ' screen--host' : ''}`}>
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
        <div className="join-card__qr">
          <QrCode url={joinUrl} size={isHost && wide ? QR_DESKTOP : QR_PHONE} />
        </div>
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
              {player.id === room.youId ? (
                <YourName
                  name={player.name}
                  color={colorOf(player.id)}
                  player={player}
                  dealt={room.panoIds.length > 0}
                  error={renameError}
                  onRename={onRename}
                  onDismissError={onDismissRenameError}
                />
              ) : (
                <>
                  <span className="player__avatar">
                    <Avatar name={player.name} color={colorOf(player.id)} />
                    <ReadyBadge player={player} dealt={room.panoIds.length > 0} />
                  </span>
                  <span className="player__name">{player.name}</span>
                </>
              )}
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
        <div className="lobby__row">
          <SoundToggle />
          <button className="button button--ghost" type="button" onClick={onLeave}>
            Leave room
          </button>
        </div>
        {isHost ? (
          <button className="button button--primary" type="button" onClick={onStart}>
            Start game
          </button>
        ) : (
          <p className="hint">Waiting for the host to start.</p>
        )}
      </footer>
    </main>
  );
}

/**
 * Your own row. Tap the name to edit it in place — the field is the name, not a form, and it
 * saves when you leave it. A refusal stays on the row so a taken name never kicks you out.
 */
function YourName({
  name,
  color,
  player,
  dealt,
  error,
  onRename,
  onDismissError,
}: {
  name: string;
  color: string;
  player: PublicPlayer;
  dealt: boolean;
  error: string | null;
  onRename: (name: string) => void;
  onDismissError: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitted = useRef<string | null>(null);
  const ignoreBlur = useRef(false);
  const editing = draft !== null;
  const shown = localError ?? error;

  useEffect(() => {
    if (!error) return;
    ignoreBlur.current = false;
    setDraft((current) => current ?? name);
    inputRef.current?.focus();
  }, [error, name]);

  useEffect(() => {
    if (!editing) return;
    // Covers a refusal reopening the field. The tap that opens it focuses inside the click,
    // which is what actually raises the keyboard.
    inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!submitted.current || name !== submitted.current) return;
    const accepted = submitted.current;
    submitted.current = null;
    setLocalError(null);
    setDraft((current) =>
      current !== null && normalizeDisplayName(current) !== accepted ? current : null,
    );
  }, [name]);

  function close() {
    ignoreBlur.current = true;
    submitted.current = null;
    setLocalError(null);
    onDismissError();
    setDraft(null);
  }

  function commit(reason: 'blur' | 'submit') {
    if (draft === null || ignoreBlur.current) return;
    const next = normalizeDisplayName(draft);
    if (!next) {
      if (reason === 'blur') {
        close();
        return;
      }
      setLocalError('Pick a name.');
      return;
    }
    if (next === name) {
      close();
      return;
    }
    if (submitted.current === next) return;
    setLocalError(null);
    submitted.current = next;
    onRename(next);
  }

  return (
    <>
      <span className="player__avatar">
        {/* The same chip they'll wear on the reveal map, so people learn it here. */}
        <Avatar name={draft ?? name} color={color} you />
        <ReadyBadge player={player} dealt={dealt} />
      </span>
      {editing ? (
        <form
          className="player__rename"
          onSubmit={(event) => {
            event.preventDefault();
            commit('submit');
          }}
        >
          <input
            ref={inputRef}
            className="player__rename-input"
            value={draft ?? ''}
            maxLength={MAX_NAME_LENGTH}
            aria-label="Your name"
            aria-invalid={shown ? true : undefined}
            enterKeyHint="done"
            autoComplete="off"
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              submitted.current = null;
              setDraft(event.target.value);
              if (localError) setLocalError(null);
              if (error) onDismissError();
            }}
            onBlur={() => {
              if (ignoreBlur.current) {
                ignoreBlur.current = false;
                return;
              }
              commit('blur');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              }
            }}
          />
          {shown && (
            <p className="player__rename-error" role="alert">
              {shown}
            </p>
          )}
        </form>
      ) : (
        <button
          className="player__name-btn"
          type="button"
          aria-label={`Change your name, ${name}`}
          onClick={() => {
            ignoreBlur.current = false;
            setLocalError(null);
            onDismissError();
            // Mount the field inside this tap, then focus it. A focus from an effect is too
            // late for a phone to open the keyboard.
            flushSync(() => setDraft(name));
            inputRef.current?.focus();
            inputRef.current?.select();
          }}
        >
          <span className="player__name">
            {name}
            <span className="player__you"> (you)</span>
          </span>
          <PencilIcon />
        </button>
      )}
    </>
  );
}

function PencilIcon() {
  return (
    <svg className="player__pencil" viewBox="0 0 24 24" aria-hidden>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </svg>
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
