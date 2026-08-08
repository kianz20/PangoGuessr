import { useCallback, useEffect, useRef, useState } from 'react';
import type { LatLng } from '@pangoguessr/shared';
import { GuessMap } from '../components/GuessMap';
import { PanoramaView } from '../components/PanoramaView';
import type { RoundView } from '../useRoom';

/** Wide enough to show the map beside the panorama instead of over it. */
const DOCKED_MAP = '(min-width: 1024px)';

export function Round({
  round,
  totalRounds,
  onGuess,
}: {
  round: RoundView;
  totalRounds: number;
  onGuess: (at: LatLng, elapsedMs: number) => void;
}) {
  const [pin, setPin] = useState<LatLng | null>(null);
  // On a phone the map is an overlay you open; on a desktop there's room for it to sit
  // docked open from the start.
  const [mapOpen, setMapOpen] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(DOCKED_MAP).matches,
  );
  const [remainingMs, setRemainingMs] = useState(round.durationMs);

  /** Set when the panorama is actually visible — this is what the 40s is measured from (§5). */
  const startedAtRef = useRef<number | null>(null);
  const pinRef = useRef<LatLng | null>(null);
  pinRef.current = pin;
  const submittedRef = useRef(false);
  const onGuessRef = useRef(onGuess);
  onGuessRef.current = onGuess;

  // The room's 46s clock, which bounds the player's own 40s. A player whose panorama loaded
  // slowly gets their personal clock clipped by this — accepted, and not reconciled in the
  // UI (§5).
  const roomDeadlineRef = useRef(Date.now() + round.remainingMs);

  const submit = useCallback((at: LatLng, elapsedMs: number) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onGuessRef.current(at, elapsedMs);
  }, []);

  // A fresh round: reset everything keyed on the round, not on renders.
  useEffect(() => {
    setPin(null);
    setMapOpen(window.matchMedia(DOCKED_MAP).matches);
    setRemainingMs(round.durationMs);
    startedAtRef.current = null;
    submittedRef.current = round.youGuessed;
    roomDeadlineRef.current = Date.now() + round.remainingMs;
  }, [round.index]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePanoReady = useCallback(() => {
    startedAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    const tick = window.setInterval(() => {
      const now = Date.now();
      const startedAt = startedAtRef.current;
      // Before the panorama renders, show a full clock: their time hasn't started yet.
      const ownRemaining = startedAt === null ? round.durationMs : startedAt + round.durationMs - now;
      const left = Math.max(0, Math.min(ownRemaining, roomDeadlineRef.current - now));
      setRemainingMs(left);

      if (left === 0 && !submittedRef.current) {
        // Time up with a pin placed but unconfirmed: submit it anyway rather than losing
        // the round to a missed button press (§5). No pin at all scores 0.
        const at = pinRef.current;
        if (at) submit(at, round.durationMs);
      }
    }, 200);
    return () => window.clearInterval(tick);
  }, [round.index, round.durationMs, submit]);

  const confirm = () => {
    const at = pin;
    const startedAt = startedAtRef.current;
    if (!at || startedAt === null) return;
    submit(at, Date.now() - startedAt);
  };

  const seconds = Math.ceil(remainingMs / 1000);
  const fraction = Math.max(0, Math.min(1, remainingMs / round.durationMs));
  const guessed = round.youGuessed || submittedRef.current;

  return (
    // Fixed height, no page scroll. Both the panorama and the map swallow drag gestures, so
    // a scrolling page meant the Confirm button could be unreachable on a phone.
    <main className="screen screen--round">
      <header className="round__bar">
        <span className="round__count">
          Round {round.index + 1}/{totalRounds}
        </span>
        <span className={`round__clock${seconds <= 10 ? ' round__clock--urgent' : ''}`}>
          {seconds}s
        </span>
      </header>
      <div className="timer" aria-hidden>
        <div className="timer__fill" style={{ width: `${fraction * 100}%` }} />
      </div>

      <div className={`stage${mapOpen ? ' stage--map-open' : ''}`}>
        <div className="stage__pano">
          <PanoramaView panoId={round.panoId} roundIndex={round.index} onReady={handlePanoReady} />
        </div>

        {!guessed && (
          <div className="stage__map" aria-hidden={!mapOpen}>
            <GuessMap pin={pin} onPin={setPin} />
          </div>
        )}
      </div>

      {/* Always on screen, never scrolled away from. */}
      <footer className="actions">
        {guessed ? (
          <p className="actions__locked">
            <strong>Guess locked in.</strong> Waiting for everyone else.
          </p>
        ) : (
          <>
            <button
              className="button button--ghost actions__toggle"
              type="button"
              onClick={() => setMapOpen((open) => !open)}
            >
              {mapOpen ? 'Hide map' : pin ? 'Adjust pin' : 'Open map'}
            </button>
            <button
              className="button button--primary actions__confirm"
              type="button"
              disabled={!pin}
              onClick={confirm}
            >
              {pin ? 'Confirm guess' : 'Drop a pin to guess'}
            </button>
          </>
        )}
      </footer>
    </main>
  );
}
