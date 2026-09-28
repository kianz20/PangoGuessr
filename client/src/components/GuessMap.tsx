import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import type { LatLng } from '@pangoguessr/shared';
import { GUESS_PIN } from './mapPin';

const OSM_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '© OpenStreetMap';

/**
 * Trimmed of the empty polar caps, so "the whole world" doesn't waste half the screen.
 * In Web Mercator this is very close to 16:9, which is why the docked map is given that
 * aspect ratio — the world then fills it with no empty bands.
 */
const WORLD = L.latLngBounds([-58, -179], [78, 179]);

/**
 * Latitude is clamped; longitude deliberately is not. Letting the map wrap means zooming
 * into somewhere near the dateline doesn't dead-end at an edge. Clicks are wrapped back
 * into -180..180 before they leave this component, so a pin on a repeated copy of the world
 * still submits a sane coordinate.
 */
const PAN_LIMIT = L.latLngBounds([-85, -720], [85, 720]);

/** Leaflet + OSM tiles — free, and no reason to pay Google on both halves of the screen (§7). */
export function GuessMap({
  pin,
  onPin,
  disabled = false,
  compact = false,
}: {
  pin: LatLng | null;
  onPin: (at: LatLng) => void;
  disabled?: boolean;
  /** Shown as the small corner map, which keeps the pin in the middle of what little it shows. */
  compact?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  /**
   * The map moves between the corner and the full stage, and each size frames the world
   * differently. It's refitted on every resize until the player touches it — after that,
   * refitting would fight their panning.
   */
  const interactedRef = useRef(false);
  const compactRef = useRef(compact);
  compactRef.current = compact;
  /** Where the marker is drawn, which may be on a repeated copy of the world. */
  const [displayPin, setDisplayPin] = useState<L.LatLng | null>(null);
  // Kept in a ref so the click handler never needs re-binding, which would otherwise
  // recreate the map.
  const onPinRef = useRef(onPin);
  onPinRef.current = onPin;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || mapRef.current) return;

    const map = L.map(host, {
      center: [20, 0],
      zoom: 2,
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
      maxBounds: PAN_LIMIT,
      maxBoundsViscosity: 1,
      // Leaflet snaps to integer zooms by default, so "fit the world" falls to the next
      // level down and leaves the map floating small in the middle. Fractional zoom lets it
      // fill the width exactly; the +/- buttons still step by whole levels.
      zoomSnap: 0,
      zoomDelta: 1,
    });
    // Wrapping tiles, so panning east past the dateline continues into Asia rather than
    // running out of map. The whole world in the ~150px corner map is zoom −0.8, below the
    // tile source's lowest level; without minNativeZoom the layer draws the zoom-0 tile unscaled
    // and the corner shows only the mid-Atlantic.
    L.tileLayer(OSM_URL, {
      attribution: OSM_ATTRIBUTION,
      noWrap: false,
      minZoom: -3,
      minNativeZoom: 0,
    }).addTo(map);
    map.on('click', (event: L.LeafletMouseEvent) => {
      // Show the pin exactly where they clicked, but report a wrapped coordinate. With a
      // repeating world, clicking the second copy of New Zealand yields lng ~194; the
      // server would reject that, and snapping the pin to the primary copy would make it
      // jump across the screen. This keeps both halves honest.
      setDisplayPin(event.latlng);
      onPinRef.current({ lat: event.latlng.lat, lng: event.latlng.wrap().lng });
    });
    mapRef.current = map;

    const touched = () => {
      interactedRef.current = true;
    };
    host.addEventListener('pointerdown', touched);
    host.addEventListener('wheel', touched, { passive: true });

    return () => {
      host.removeEventListener('pointerdown', touched);
      host.removeEventListener('wheel', touched);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // The map is created inside a collapsed container, so Leaflet measures it at the wrong
  // size until it's visible. Without this the tiles come back grey.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const observer = new ResizeObserver(() => {
      map.invalidateSize();
      const host = hostRef.current;
      if (!host || host.clientHeight === 0) return;

      // Stop them zooming out past the whole world, which only reveals empty space and
      // makes the map feel broken.
      const worldZoom = map.getBoundsZoom(WORLD);
      map.setMinZoom(worldZoom);
      const marker = markerRef.current;
      if (!interactedRef.current && !marker) {
        map.fitBounds(WORLD, { animate: false });
      } else if (compactRef.current && marker) {
        map.panTo(marker.getLatLng(), { animate: false });
      }
    });
    if (hostRef.current) observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!pin) {
      // A new round clears the guess, so drop the drawn pin with it.
      setDisplayPin(null);
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    const at = displayPin ?? pin;
    if (markerRef.current) markerRef.current.setLatLng(at);
    else markerRef.current = L.marker(at, { icon: GUESS_PIN, keyboard: false }).addTo(map);
  }, [pin, displayPin]);

  return (
    <div
      ref={hostRef}
      className="map map--guess"
      // Once the guess is locked in, the map is a record of what you picked, not an input.
      style={disabled ? { pointerEvents: 'none', opacity: 0.75 } : undefined}
    />
  );
}
