import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type { GuessResult, LatLng } from '@pangoguessr/shared';

const OSM_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '© OpenStreetMap';

/**
 * Every player's pin, labelled, plus the answer (§4). Showing all 16–20 is the point —
 * seeing how badly everyone else missed is most of the entertainment — so this has to stay
 * legible on a phone: bounds auto-fit to include everything, and tapping your own pin
 * highlights it.
 */
export function RevealMap({
  actual,
  results,
  youId,
}: {
  actual: LatLng;
  results: GuessResult[];
  youId: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const map = L.map(host, { zoomControl: true, worldCopyJump: true });
    L.tileLayer(OSM_URL, { attribution: OSM_ATTRIBUTION }).addTo(map);
    mapRef.current = map;

    const answer = L.circleMarker(actual, {
      radius: 9,
      color: '#0f1720',
      weight: 3,
      fillColor: '#35d39a',
      fillOpacity: 1,
    })
      .addTo(map)
      .bindTooltip('Answer', { permanent: true, direction: 'top', className: 'pin-label pin-label--answer' });

    const points: L.LatLngExpression[] = [actual];

    for (const result of results) {
      if (!result.guess) continue;
      points.push(result.guess);
      const isYou = result.playerId === youId;

      L.circleMarker(result.guess, {
        radius: isYou ? 8 : 6,
        color: '#0f1720',
        weight: 2,
        fillColor: isYou ? '#f0b542' : '#8fb3d9',
        fillOpacity: 1,
      })
        .addTo(map)
        .bindTooltip(result.name, {
          // Only your own label is pinned open; 20 permanent labels is an unreadable mess
          // on a phone. Tap any pin to read its name.
          permanent: isYou,
          direction: 'top',
          className: `pin-label${isYou ? ' pin-label--you' : ''}`,
        });

      // A line to the answer makes "how far off was that" readable at a glance.
      L.polyline([result.guess, actual], {
        color: isYou ? '#f0b542' : '#8fb3d9',
        weight: isYou ? 2 : 1,
        opacity: isYou ? 0.9 : 0.35,
        dashArray: '4 4',
      }).addTo(map);
    }

    map.fitBounds(L.latLngBounds(points).pad(0.25), { animate: false });
    // A single pin on the answer would otherwise zoom to street level, which reads as a bug.
    if (points.length === 1) map.setZoom(Math.min(map.getZoom(), 5));

    answer.bringToFront();

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [actual, results, youId]);

  return <div ref={hostRef} className="map map--reveal" />;
}
