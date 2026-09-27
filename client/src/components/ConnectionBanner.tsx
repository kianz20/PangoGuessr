import { useEffect, useState } from 'react';

/** Most drops are over inside this, and a banner that flashes for them is just noise. */
const SHOW_AFTER_MS = 1_000;
/** Long enough that it's worth reassuring them, and offering a way out. */
const STILL_TRYING_MS = 10_000;

/**
 * Shown over the game while its socket is down, rather than in place of it. The round, the
 * pin and the panorama all stay where they were, so a drop that's over in a second barely
 * registers — where the full-screen "Reconnecting" used to throw the round away (§8).
 */
export function ConnectionBanner({
  since,
  onLeave,
}: {
  since: number | null;
  onLeave: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(tick);
  }, [since]);

  if (since === null || now - since < SHOW_AFTER_MS) return null;
  const stillTrying = now - since >= STILL_TRYING_MS;

  return (
    <div className="link-banner" role="status" aria-live="polite">
      <span className="link-banner__spinner" aria-hidden />
      <span className="link-banner__text">
        {stillTrying ? 'Still reconnecting — your place and score are kept.' : 'Reconnecting…'}
      </span>
      {stillTrying && (
        <button className="link-banner__leave" type="button" onClick={onLeave}>
          Leave
        </button>
      )}
    </div>
  );
}
