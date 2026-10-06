import { useEffect, useState } from 'react';
import { MAX_NAME_LENGTH, isValidCode, normalizeCode } from '@pangoguessr/shared';
import { Wordmark } from '../components/Brand';
import { recallName, rememberName } from '../session';

export function Home({
  notice,
  onCreate,
  onJoin,
}: {
  notice: string | null;
  onCreate: (name: string) => void;
  onJoin: (code: string, name: string) => void;
}) {
  const [name, setName] = useState(recallName);
  // Scanning the QR with no name saved yet lands here with the code already in the URL, so
  // only the name is left. With one saved, useRoom has joined without stopping here.
  const [code, setCode] = useState(() =>
    normalizeCode(new URLSearchParams(location.search).get('c') ?? ''),
  );
  /**
   * Arriving from a QR link, the only job left is a name: sixteen people scanning at once
   * shouldn't each be offered a code box and a "Start a new room" button to get wrong. A
   * notice means that link has already let them down — a closed room, a bad code — so they
   * get the full screen instead.
   */
  const [invited, setInvited] = useState(() => isValidCode(code) && notice === null);

  useEffect(() => {
    rememberName(name);
  }, [name]);

  const trimmed = name.trim();
  const canJoin = trimmed.length > 0 && isValidCode(code);
  const canCreate = trimmed.length > 0;

  const nameField = (
    <label className="field">
      <span className="field__label">Your name</span>
      <input
        className="input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={MAX_NAME_LENGTH}
        placeholder="Kian"
        autoComplete="given-name"
        autoFocus={invited && !trimmed}
        enterKeyHint={invited ? 'go' : 'done'}
      />
    </label>
  );

  return (
    <main className="screen screen--home">
      <header className="brand">
        <img className="brand__mark" src="/favicon.svg" alt="" width={52} height={52} />
        <div>
          <Wordmark />
          <p className="brand__tag">Guess where you are. Closest wins.</p>
        </div>
      </header>

      {notice && <p className="notice" role="status">{notice}</p>}

      {invited ? (
        <form
          className="invite"
          onSubmit={(e) => {
            e.preventDefault();
            if (canJoin) onJoin(code, trimmed);
          }}
        >
          <section className="invite__card">
            <p className="invite__label">You’re joining room</p>
            <p className="code" aria-label={`Room code ${code.split('').join(' ')}`}>
              {code}
            </p>
          </section>
          {nameField}
          <button className="button button--primary" type="submit" disabled={!canJoin}>
            Join the game
          </button>
          <button className="link-button" type="button" onClick={() => setInvited(false)}>
            Not this room? Enter a code or start your own
          </button>
        </form>
      ) : (
        <>
          {nameField}

          <form
            className="field"
            onSubmit={(e) => {
              e.preventDefault();
              if (canJoin) onJoin(code, trimmed);
            }}
          >
            <span className="field__label">Room code</span>
            <input
              className="input input--code"
              value={code}
              onChange={(e) => setCode(normalizeCode(e.target.value))}
              placeholder="AB2X"
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
            />
            <button className="button button--primary" type="submit" disabled={!canJoin}>
              Join room
            </button>
          </form>

          <div className="or">or</div>

          <button
            className="button button--ghost"
            type="button"
            disabled={!canCreate}
            onClick={() => onCreate(trimmed)}
          >
            Start a new room
          </button>
        </>
      )}
    </main>
  );
}
