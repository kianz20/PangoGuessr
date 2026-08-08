import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type { LatLng } from '@pangoguessr/shared';
import { GUESS_PIN } from './mapPin';

const OSM_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '© OpenStreetMap';

/** Trimmed of the empty polar caps, so "the whole world" doesn't waste half the screen. */
const WORLD = L.latLngBounds([-58, -179], [78, 179]);

/** Leaflet + OSM tiles — free, and no reason to pay Google on both halves of the screen (§7). */
export function GuessMap({
  pin,
  onPin,
  disabled = false,
}: {
  pin: LatLng | null;
  onPin: (at: LatLng) => void;
  disabled?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  /** Fit the world once, not on every resize — that would fight the player's panning. */
  const fittedRef = useRef(false);
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
      // One copy of the world: with wrapping, a pin near the dateline can be placed on a
      // duplicate and come back with a longitude hundreds of degrees out.
      worldCopyJump: false,
      maxBounds: WORLD,
      maxBoundsViscosity: 1,
      // Leaflet snaps to integer zooms by default, so "fit the world" falls to the next
      // level down and leaves the map floating small in the middle. Fractional zoom lets it
      // fill the width exactly; the +/- buttons still step by whole levels.
      zoomSnap: 0,
      zoomDelta: 1,
    });
    L.tileLayer(OSM_URL, { attribution: OSM_ATTRIBUTION, noWrap: true }).addTo(map);
    map.on('click', (event: L.LeafletMouseEvent) => {
      onPinRef.current({ lat: event.latlng.lat, lng: event.latlng.wrap().lng });
    });
    mapRef.current = map;

    return () => {
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
      if (!fittedRef.current) {
        map.fitBounds(WORLD, { animate: false });
        fittedRef.current = true;
      }
    });
    if (hostRef.current) observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!pin) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (markerRef.current) markerRef.current.setLatLng(pin);
    else markerRef.current = L.marker(pin, { icon: GUESS_PIN, keyboard: false }).addTo(map);
  }, [pin]);

  return (
    <div
      ref={hostRef}
      className="map map--guess"
      // Once the guess is locked in, the map is a record of what you picked, not an input.
      style={disabled ? { pointerEvents: 'none', opacity: 0.75 } : undefined}
    />
  );
}
