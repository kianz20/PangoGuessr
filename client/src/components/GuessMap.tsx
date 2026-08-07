import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type { LatLng } from '@pangoguessr/shared';

const OSM_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '© OpenStreetMap';

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
  // Kept in a ref so the click handler never needs re-binding, which would otherwise
  // recreate the map.
  const onPinRef = useRef(onPin);
  onPinRef.current = onPin;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || mapRef.current) return;

    const map = L.map(host, {
      center: [10, 0],
      zoom: 1,
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true,
    });
    L.tileLayer(OSM_URL, { attribution: OSM_ATTRIBUTION, noWrap: false }).addTo(map);
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
    const observer = new ResizeObserver(() => map.invalidateSize());
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
    else markerRef.current = L.marker(pin, { keyboard: false }).addTo(map);
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
