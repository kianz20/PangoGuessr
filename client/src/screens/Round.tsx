import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuessProgress, LatLng } from '@pangoguessr/shared';
import { CancelGame } from '../components/CancelGame';
import { GuessMap } from '../components/GuessMap';
import { PanoramaView } from '../components/PanoramaView';
import type { RoundView } from '../useRoom';

/** Wide enough for the map to sit open over the panorama from the start. */
const DOCKED_MAP = '(min-width: 1024px)';
const isDocked = () => typeof window !== 'undefined' && window.matchMedia(DOCKED_MAP).matches;

/**
 * How long the "Round 3 of 5" card holds. The player's clock doesn't start until it's gone
 * (§5), so it costs them nothing — it comes out of the load headroom, and only when their
 * panorama was ready before the card finished anyway.
 */
const INTRO_MS = 1_300;

const URGENT_S = 10;
const CRITICAL_S = 5;

/** Android only. iOS Safari has no vibration API, so this quietly does nothing there. */
function buzz(ms: number): void {
  navigator.vibrate?.(ms);
}

/**
 * Keyed on the round index by App, so each round is a fresh mount: nothing from the last one
 * — the pin, the title card, the clock — has to be reset by hand.
 */
export function Round({
  round,
  totalRounds,
  isHost,
  onGuess,
  onClockStart,
  onCancelGame,
}: {
  round: RoundView;
  totalRounds: number;
  isHost: boolean;
  onGuess: (roundIndex: number, at: LatLng, elapsedMs: number) => void;
  /** The panorama is visible — this is what the 40s is measured from (§5). */
  onClockStart: (roundIndex: number) => void;
  onCancelGame: () => void;
}) {
  const [pin, setPin] = useState<LatLng | null>(null);
  /**
   * The map is always on screen: small in the corner of the panorama, or open to place a pin.
   * On a desktop there's room for it to start open.
   */
  const [mapOpen, setMapOpen] = useState(isDocked);
  const [remainingMs, setRemainingMs] = useState(round.durationMs);
  /** Only for a round starting fresh. A reconnect mid-round goes straight back to it. */
  const [intro, setIntro] = useState(() => round.startedAt === null && !round.youGuessed);

  /**
   * The latest round, for the clock's interval. Its start and the room's deadline live in
   * useRoom, so a reconnect can correct the deadline and nothing can restart their 40s.
   */
  const roundRef = useRef(round);
  roundRef.current = round;
  const pinRef = useRef<LatLng | null>(null);
  pinRef.current = pin;
  const submittedRef = useRef(round.youGuessed);
  const onGuessRef = useRef(onGuess);
  onGuessRef.current = onGuess;
  const onClockStartRef = useRef(onClockStart);
  onClockStartRef.current = onClockStart;

  // Set from the panorama's effect, which runs before this component's own — so these start
  // with their mount values and are never reset by an effect here.
  const panoReadyRef = useRef(false);
  const introDoneRef = useRef(!intro);

  /** Their 40 seconds start once they can actually see: loaded, and the card gone (§5). */
  const startClockIfReady = useCallback(() => {
    if (panoReadyRef.current && introDoneRef.current) {
      onClockStartRef.current(roundRef.current.index);
    }
  }, []);

  const submit = useCallback((at: LatLng, elapsedMs: number) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onGuessRef.current(roundRef.current.index, at, elapsedMs);
    // Back to the corner on a phone, so they can look at the view again while they wait —
    // with their pin still showing.
    if (!isDocked()) setMapOpen(false);
  }, []);

  const handlePanoReady = useCallback(() => {
    panoReadyRef.current = true;
    startClockIfReady();
  }, [startClockIfReady]);

  useEffect(() => {
    if (!intro) return;
    const timer = window.setTimeout(() => {
      introDoneRef.current = true;
      setIntro(false);
      startClockIfReady();
    }, INTRO_MS);
    return () => window.clearTimeout(timer);
  }, [intro, startClockIfReady]);

  useEffect(() => {
    const tick = window.setInterval(() => {
      const now = Date.now();
      const { startedAt, durationMs, roomDeadline } = roundRef.current;
      // Before the panorama renders, show a full clock: their time hasn't started yet.
      const ownRemaining = startedAt === null ? durationMs : startedAt + durationMs - now;
      // The room's 46s clock bounds the player's own 40s. A player whose panorama loaded
      // slowly gets their personal clock clipped by this — accepted, and not reconciled in
      // the UI (§5).
      const left = Math.max(0, Math.min(ownRemaining, roomDeadline - now));
      setRemainingMs(left);

      if (left === 0 && !submittedRef.current) {
        // Time up with a pin placed but unconfirmed: submit it anyway rather than losing
        // the round to a missed button press (§5). No pin at all scores 0.
        const at = pinRef.current;
        if (at) submit(at, durationMs);
      }
    }, 200);
    return () => window.clearInterval(tick);
  }, [submit]);

  const confirm = () => {
    const at = pin;
    const startedAt = round.startedAt;
    if (!at || startedAt === null) return;
    submit(at, Date.now() - startedAt);
  };

  const seconds = Math.ceil(remainingMs / 1000);
  const fraction = Math.max(0, Math.min(1, remainingMs / round.durationMs));
  const guessed = round.youGuessed || submittedRef.current;
  const clockRunning = round.startedAt !== null;
  const urgency = !clockRunning
    ? null
    : seconds <= CRITICAL_S
      ? 'critical'
      : seconds <= URGENT_S
        ? 'urgent'
        : null;

  // A nudge at ten seconds and each of the last three — only for someone still deciding.
  useEffect(() => {
    if (!clockRunning || guessed) return;
    if (seconds === URGENT_S) buzz(60);
    else if (seconds > 0 && seconds <= 3) buzz(35);
  }, [seconds]); // eslint-disable-line react-hooks/exhaustive-deps

  const progress = round.progress;
  const isFinal = round.index + 1 === totalRounds;

  return (
    // Fixed height, no page scroll. Both the panorama and the map swallow drag gestures, so
    // a scrolling page meant the Confirm button could be unreachable on a phone.
    <main className="screen screen--round">
      <header className="round__bar">
        <span className="round__status">
          <span className="round__count">
            Round {round.index + 1}/{totalRounds}
          </span>
          {progress && progress.total > 1 && (
            <span className="round__progress">
              {progress.guessed} of {progress.total} guessed
            </span>
          )}
        </span>
        {/* In the header, deliberately away from the Confirm button the host is aiming for
            under time pressure. */}
        {isHost && <CancelGame onCancel={onCancelGame} compact />}
        {/* Re-keyed each second once it's urgent, so the pulse plays on every tick. */}
        <span
          key={urgency ? seconds : 'calm'}
          className={`round__clock${urgency ? ` round__clock--${urgency}` : ''}`}
        >
          {seconds}s
        </span>
      </header>
      <div className={`timer${urgency ? ` timer--${urgency}` : ''}`} aria-hidden>
        <div className="timer__fill" style={{ width: `${fraction * 100}%` }} />
      </div>

      <div className={`stage${mapOpen ? ' stage--map-open' : ''}`}>
        <div className="stage__pano">
          <PanoramaView panoId={round.panoId} roundIndex={round.index} onReady={handlePanoReady} />
        </div>

        <div className={`stage__map${mapOpen ? '' : ' stage__map--mini'}`}>
          {/* Read-only once locked in: a record of what they picked, not an input. */}
          <GuessMap pin={pin} onPin={setPin} disabled={guessed} compact={!mapOpen} />
          {!mapOpen && (
            // In the corner a tap opens the map rather than dropping a pin on a map too
            // small to aim at.
            <button
              className="stage__map-expand"
              type="button"
              onClick={() => setMapOpen(true)}
              aria-label={guessed ? 'Show your guess on the map' : 'Open the map to guess'}
            />
          )}
        </div>
      </div>

      {/* Always on screen, never scrolled away from. */}
      <footer className="actions">
        {guessed ? (
          <>
            <p className="actions__locked">
              <strong>Guess locked in.</strong> {waitingOn(progress)}
            </p>
            <button
              className="button button--ghost actions__toggle"
              type="button"
              onClick={() => setMapOpen((open) => !open)}
            >
              {mapOpen ? 'Hide map' : 'Your pin'}
            </button>
          </>
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

      {intro && (
        <div className="round-intro" role="status">
          <p className="round-intro__label">{isFinal ? 'Final round' : `Round ${round.index + 1}`}</p>
          <p className="round-intro__of">
            {isFinal ? `${totalRounds} of ${totalRounds}` : `of ${totalRounds}`}
          </p>
        </div>
      )}
    </main>
  );
}

function waitingOn(progress: GuessProgress | null): string {
  if (!progress) return 'Waiting for everyone else.';
  const left = progress.total - progress.guessed;
  if (left <= 0) return 'That’s everyone — scoring it now.';
  return left === 1 ? 'Waiting on one more.' : `Waiting on ${left} more.`;
}
