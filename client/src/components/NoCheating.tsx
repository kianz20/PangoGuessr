import { useEffect, useState } from 'react';
import { play } from '../sound';

/** Long enough to sting, short enough that it's a joke rather than a lost round. */
const LOCKOUT_MS = 3_000;

/**
 * What a player gets for tapping Google's link out to Maps: the whole screen, in red, for
 * three seconds. Their clock keeps running underneath — that's the actual penalty.
 */
export function NoCheating({ onDone }: { onDone: () => void }) {
  const [until] = useState(() => Date.now() + LOCKOUT_MS);
  const [seconds, setSeconds] = useState(Math.ceil(LOCKOUT_MS / 1000));

  useEffect(() => {
    play('busted');
    navigator.vibrate?.([90, 60, 90, 60, 90]);
    const tick = window.setInterval(() => {
      const left = until - Date.now();
      if (left <= 0) {
        window.clearInterval(tick);
        onDone();
        return;
      }
      setSeconds(Math.ceil(left / 1000));
    }, 100);
    return () => window.clearInterval(tick);
  }, [until]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="busted" role="alertdialog" aria-modal="true" aria-labelledby="busted-title">
      <p className="busted__siren" aria-hidden>
        🚨
      </p>
      <h2 id="busted-title" className="busted__title">
        No cheating!
      </h2>
      <p className="busted__hint">Nice try. Google Maps isn’t part of the game.</p>
      {/* Re-keyed each second so the number punches in fresh. */}
      <p key={seconds} className="busted__count" aria-live="assertive">
        {seconds}
      </p>
      <p className="busted__hint">Your clock is still running…</p>
    </div>
  );
}
