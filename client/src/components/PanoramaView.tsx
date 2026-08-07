import { useEffect, useRef, useState } from 'react';
import { LOAD_HEADROOM_MS } from '@pangoguessr/shared';
import { getConfig, loadMaps } from '../maps';

/**
 * The panorama, and the single most cost-sensitive component in the app (§7).
 *
 * Rules it must keep, because each player device loading a panorama bills as one load:
 *
 *  - **Mounted exactly once per round.** The effect is keyed on `roundIndex` alone. Keying
 *    it on timer or room state would re-initialise the viewer on every tick and bill again.
 *  - **Never rendered outside ROUND_ACTIVE** — App only routes here during a live round.
 *  - **StrictMode double-mounts effects in development**, silently doubling every load, so a
 *    ref guards against the second run.
 *
 * It also owns the timing contract: `onReady` fires when imagery is actually visible, which
 * is what starts the player's own 40 seconds (§5), with a headroom fallback so a broken
 * viewer can't mean an infinite stopwatch.
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
  const panoramaRef = useRef<google.maps.StreetViewPanorama | null>(null);
  const firedRef = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const [status, setStatus] = useState<'loading' | 'ready' | 'placeholder' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    firedRef.current = false;
    setStatus('loading');

    const ready = () => {
      if (firedRef.current) return;
      firedRef.current = true;
      onReadyRef.current();
    };

    // Whatever happens — slow tiles, a dead key, no coverage — their clock starts within the
    // load headroom so the round can't hang on one device.
    const fallback = window.setTimeout(ready, LOAD_HEADROOM_MS);

    // Placeholder panoramas (step 2's fixed list) never touch Google at all.
    if (panoId.startsWith('dev:')) {
      setStatus('placeholder');
      requestAnimationFrame(ready);
      return () => {
        cancelled = true;
        window.clearTimeout(fallback);
      };
    }

    void (async () => {
      try {
        const { mapsBrowserKey } = await getConfig();
        if (!mapsBrowserKey) throw new Error('No browser key configured');
        const maps = await loadMaps(mapsBrowserKey);
        if (cancelled || !hostRef.current) return;

        const panorama = new maps.StreetViewPanorama(hostRef.current, {
          pano: panoId,
          // Pannable, not movable (§7). Movement bills a new load per step — 20 players
          // taking 10 steps each is ~220 loads for one round, against 100 for a whole game.
          linksControl: false,
          clickToGo: false,
          disableDefaultUI: true,
          motionTracking: false,
          motionTrackingControl: false,
          showRoadLabels: false, // road names would give the country away
          zoomControl: true,
        });
        panoramaRef.current = panorama;

        // 'pano_changed' fires once the viewer has accepted the ID; tiles follow. This is the
        // closest signal to "the player can see something".
        const listener = panorama.addListener('pano_changed', () => {
          if (cancelled) return;
          setStatus('ready');
          ready();
        });

        // A wrong or retired panorama ID would otherwise sit as a grey box.
        const statusListener = panorama.addListener('status_changed', () => {
          if (panorama.getStatus() !== maps.StreetViewStatus.OK) {
            setStatus('error');
            ready();
          }
        });

        if (cancelled) {
          listener.remove();
          statusListener.remove();
        }
      } catch (err) {
        if (cancelled) return;
        console.error('Panorama failed to load', err);
        setStatus('error');
        ready();
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
      // Drop the viewer between rounds so a stuck screen isn't holding a live one (§7).
      panoramaRef.current = null;
      if (hostRef.current) hostRef.current.innerHTML = '';
    };
    // Keyed on the round alone — deliberately not on panoId, status or any timer state.
  }, [roundIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="pano" data-status={status}>
      <div ref={hostRef} className="pano__viewer" />

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
