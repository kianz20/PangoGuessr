import { useEffect, useRef, useState } from 'react';
import { LOAD_HEADROOM_MS } from '@pangoguessr/shared';
import { showPanorama, type Viewer } from '../panoramas';

/**
 * The panorama for the live round. The viewer itself comes from `panoramas.ts`, which built it
 * while the room was in the lobby — this component just puts it on screen, so a round starts
 * with the imagery already there instead of loading it against the clock.
 *
 * Cost rules it must keep, because each viewer bills one load (§7):
 *
 *  - **Keyed on `roundIndex` alone.** Keying it on timer or room state would re-attach the
 *    viewer on every tick.
 *  - **Never builds a viewer of its own.** Unmounting parks the viewer rather than destroying
 *    it, so StrictMode's double-mount and a reconnect mid-round reuse it instead of billing
 *    again.
 *  - **Never rendered outside ROUND_ACTIVE** — App only routes here during a live round.
 *
 * It also owns the timing contract: `onReady` fires when imagery is actually visible, which
 * is what starts the player's own 40 seconds (§5) — immediately, for a preloaded panorama —
 * with a headroom fallback so a broken viewer can't mean an infinite stopwatch.
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
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  /** Rotated directly: `pov_changed` fires every frame of a drag, too often for React state. */
  const dialRef = useRef<HTMLSpanElement | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const [status, setStatus] = useState<'loading' | 'ready' | 'placeholder' | 'error'>('loading');

  useEffect(() => {
    let fired = false;
    const ready = () => {
      if (fired) return;
      fired = true;
      onReadyRef.current();
    };

    // Whatever happens — slow tiles, a dead key, no coverage — their clock starts within the
    // load headroom so the round can't hang on one device.
    const fallback = window.setTimeout(ready, LOAD_HEADROOM_MS);

    // Placeholder panoramas (step 2's fixed list) never touch Google at all.
    if (panoId.startsWith('dev:')) {
      setStatus('placeholder');
      requestAnimationFrame(ready);
      return () => window.clearTimeout(fallback);
    }

    const viewer = showPanorama(panoId, hostRef.current!, {
      onStatus(next) {
        setStatus(next);
        if (next !== 'loading') ready();
      },
      onHeading(heading) {
        // The dial turns against the view, so its N keeps pointing north.
        if (dialRef.current) dialRef.current.style.transform = `rotate(${-heading}deg)`;
      },
    });
    viewerRef.current = viewer;

    return () => {
      window.clearTimeout(fallback);
      viewerRef.current = null;
      viewer.release();
    };
    // Keyed on the round alone — deliberately not on panoId, status or any timer state.
  }, [roundIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="pano" data-status={status}>
      <div ref={hostRef} className="pano__viewer" />

      {/* Always rendered, shown only once the view is up, so the dial exists to rotate. */}
      <div className="pano__tools">
        <span className="compass" role="img" aria-label="Compass">
          <span ref={dialRef} className="compass__dial">
            <svg viewBox="0 0 40 40" aria-hidden>
              <path d="M20 11 L24.5 20 L15.5 20 Z" className="compass__north" />
              <path d="M20 31 L24.5 20 L15.5 20 Z" className="compass__south" />
              <text x="20" y="9.5" className="compass__n">N</text>
            </svg>
          </span>
        </span>
        <button
          className="pano__reset"
          type="button"
          onClick={() => viewerRef.current?.resetView()}
          aria-label="Back to the starting view"
          title="Back to the starting view"
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M4 12a8 8 0 1 0 2.4-5.7" />
            <path d="M4 4v4.5h4.5" />
          </svg>
        </button>
      </div>

      {status === 'placeholder' && (
        <div className="pano__overlay">
          <p className="pano__label">Placeholder imagery</p>
          <p className="pano__pano-id">{panoId}</p>
          <p className="pano__hint">
            Add a Google Maps key to see real Street View. Guess anywhere for now.
          </p>
        </div>
      )}

      {status === 'loading' && (
        <div className="pano__overlay">
          <div className="spinner" aria-hidden />
          <p className="pano__hint">Loading the view…</p>
        </div>
      )}

      {status === 'error' && (
        <div className="pano__overlay">
          <p className="pano__label">This view wouldn’t load</p>
          <p className="pano__hint">
            Guess from the map anyway — your clock is running either way.
          </p>
        </div>
      )}
    </div>
  );
}
