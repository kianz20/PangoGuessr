import { useEffect, useRef, useState } from 'react';
import { LOAD_HEADROOM_MS } from '@pangoguessr/shared';

/**
 * Stands in for the Street View panorama until step 3 (§10). The contract it implements is
 * the important part, because the real viewer must honour exactly the same one:
 *
 *  - mounted **once per round**, keyed on roundIndex alone — anything else re-initialises
 *    the viewer and bills another panorama load (§7);
 *  - calls `onReady` when the imagery is actually visible, which is what starts the
 *    player's own 40-second clock rather than the broadcast (§5);
 *  - falls back to calling `onReady` after the load headroom so a broken viewer can't mean
 *    an infinite stopwatch (§5).
 */
export function PanoramaView({
  panoId,
  roundIndex,
  onReady,
}: {
  panoId: string;
  roundIndex: number;
  onReady: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  // A ref, not state: onReady must fire exactly once per round even if the parent
  // re-renders, and in development StrictMode mounts effects twice (§7).
  const firedRef = useRef(false);

  useEffect(() => {
    firedRef.current = false;
    setLoaded(false);

    // The placeholder "loads" on the next frame. The real viewer will hang this off
    // pano_changed / the first tile render instead.
    const raf = requestAnimationFrame(() => {
      if (firedRef.current) return;
      firedRef.current = true;
      setLoaded(true);
      onReady();
    });

    const fallback = window.setTimeout(() => {
      if (firedRef.current) return;
      firedRef.current = true;
      onReady();
    }, LOAD_HEADROOM_MS);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(fallback);
    };
    // Keyed on the round alone. Adding timer or player state here would re-mount the
    // viewer on every tick — the exact bug §7's billing guard is about.
  }, [roundIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="pano" data-loaded={loaded}>
      <div className="pano__placeholder">
        <p className="pano__label">Street View lands in step 3</p>
        <p className="pano__pano-id">{panoId}</p>
        <p className="pano__hint">
          Guess anywhere — this step is about the round loop, the clocks and the scoring.
        </p>
      </div>
    </div>
  );
}
