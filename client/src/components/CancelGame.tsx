import { useEffect, useState } from 'react';

/**
 * Two taps, not one: cancelling wipes everyone's scores mid-game, and it lives next to
 * buttons the host presses every round. A modal would be heavier than the action deserves,
 * and worse on a phone.
 */
export function CancelGame({ onCancel, compact = false }: { onCancel: () => void; compact?: boolean }) {
  const [armed, setArmed] = useState(false);

  // Disarm on its own, so a stray tap doesn't leave a live "confirm" button sitting there
  // for the rest of the round.
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <button
      className={`cancel-game${armed ? ' cancel-game--armed' : ''}${compact ? ' cancel-game--compact' : ''}`}
      type="button"
      onClick={() => (armed ? onCancel() : setArmed(true))}
    >
      {armed ? 'Tap again to end it' : 'End game'}
    </button>
  );
}
