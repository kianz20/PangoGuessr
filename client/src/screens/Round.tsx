import { useCallback, useEffect, useRef, useState } from 'react';
import type { LatLng } from '@pangoguessr/shared';
import { GuessMap } from '../components/GuessMap';
import { PanoramaView } from '../components/PanoramaView';
import type { RoundView } from '../useRoom';

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
  const [mapOpen, setMapOpen] = useState(false);
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
    setMapOpen(false);
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
    setMapOpen(false);
  };

  const seconds = Math.ceil(remainingMs / 1000);
  const fraction = Math.max(0, Math.min(1, remainingMs / round.durationMs));
  const guessed = round.youGuessed || submittedRef.current;

  return (
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

      <PanoramaView panoId={round.panoId} roundIndex={round.index} onReady={handlePanoReady} />

      {guessed ? (
        <section className="round__locked">
          <p className="round__locked-title">Guess locked in</p>
          <p className="hint">Waiting for everyone else — the round ends when all have guessed.</p>
        </section>
      ) : (
        <>
          {/* Phone-sized: a tap-to-expand overlay, not a permanent split view (§7). */}
          <button
            className={`button button--ghost map-toggle${mapOpen ? ' map-toggle--open' : ''}`}
            type="button"
            onClick={() => setMapOpen((open) => !open)}
          >
            {mapOpen ? 'Hide map' : pin ? 'Adjust your guess' : 'Open map to guess'}
          </button>

          <section className={`guess${mapOpen ? ' guess--open' : ''}`}>
            <GuessMap pin={pin} onPin={setPin} />
            <div className="guess__actions">
              <p className="hint">
                {pin ? 'Tap the map to move your pin.' : 'Tap the map to drop a pin.'}
              </p>
              <button
                className="button button--primary"
                type="button"
                disabled={!pin}
                onClick={confirm}
              >
                Confirm guess
              </button>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
