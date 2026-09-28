import { setSoundOn, useSoundOn } from '../sound';

export function Wordmark() {
  return (
    <h1 className="wordmark">
      Pango<span className="wordmark__accent">Guessr</span>
    </h1>
  );
}

/**
 * Off by default on every phone: sixteen phones chiming the same reveal is chaos. `compact` is
 * the icon alone, for a header.
 */
export function SoundToggle({ compact = false }: { compact?: boolean }) {
  const on = useSoundOn();
  return (
    <button
      className={`sound-toggle${compact ? ' sound-toggle--compact' : ''}${on ? ' is-on' : ''}`}
      type="button"
      aria-pressed={on}
      aria-label={compact ? (on ? 'Sound on' : 'Sound off') : undefined}
      onClick={() => setSoundOn(!on)}
    >
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
        {on ? (
          <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" className="sound-toggle__waves" />
        ) : (
          <path d="M16 9.5l5 5M21 9.5l-5 5" className="sound-toggle__waves" />
        )}
      </svg>
      {!compact && <span>{on ? 'Sound on' : 'Sound off'}</span>}
    </button>
  );
}
