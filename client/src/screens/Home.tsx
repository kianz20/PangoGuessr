import { useEffect, useState } from 'react';
import { MAX_NAME_LENGTH, isValidCode, normalizeCode } from '@pangoguessr/shared';

const NAME_KEY = 'pangoguessr.name';

export function Home({
  notice,
  onCreate,
  onJoin,
}: {
  notice: string | null;
  onCreate: (name: string) => void;
  onJoin: (code: string, name: string) => void;
}) {
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  // Scanning the QR lands here with the code already in the URL, so only the name is left.
  const [code, setCode] = useState(() =>
    normalizeCode(new URLSearchParams(location.search).get('c') ?? ''),
  );

  useEffect(() => {
    localStorage.setItem(NAME_KEY, name);
  }, [name]);

  const trimmed = name.trim();
  const canJoin = trimmed.length > 0 && isValidCode(code);
  const canCreate = trimmed.length > 0;

  return (
    <main className="screen screen--home">
      <header className="brand">
        <h1>PangoGuessr</h1>
        <p className="brand__tag">Guess where you are. Faster is better.</p>
      </header>

      {notice && <p className="notice" role="status">{notice}</p>}

      <label className="field">
        <span className="field__label">Your name</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={MAX_NAME_LENGTH}
          placeholder="Kian"
          autoComplete="given-name"
          enterKeyHint="done"
        />
      </label>

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
    </main>
  );
}
