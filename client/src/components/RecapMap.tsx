import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type { LatLng, RoundSummary } from '@pangoguessr/shared';
import { prefersReducedMotion } from '../motion';
import { baseTiles } from './mapTiles';

const FIT: L.FitBoundsOptions = { padding: [28, 28], maxZoom: 9 };
const PIN = 24;

/**
 * The whole game on one map: each round's answer, numbered, with your guess and a line between
 * them. `focus` flies to one round; null shows them all.
 */
export function RecapMap({
  rounds,
  youId,
  focus,
}: {
  rounds: RoundSummary[];
  youId: string;
  focus: number | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  /** The map opens on everything, so the first focus has nowhere to fly. */
  const focusedRef = useRef<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const map = L.map(host, { zoomControl: true, worldCopyJump: true, zoomSnap: 0.25 });
    baseTiles().addTo(map);

    for (const round of rounds) {
      const number = String(round.roundIndex + 1);
      const guess = yourGuess(round, youId);
      if (guess) {
        L.polyline([guess, round.actual], {
          color: '#f0b542',
          weight: 2,
          opacity: 0.85,
          dashArray: '4 5',
          interactive: false,
        }).addTo(map);
        L.marker(guess, { icon: numberPin(number, 'recap-pin recap-pin--you'), keyboard: false })
          .addTo(map)
          .bindTooltip(text(`Your round ${number} guess`), { direction: 'top', className: 'pin-label pin-label--you' });
      }
      // Text, not HTML: place names come from a dataset, but nothing here needs markup.
      L.marker(round.actual, {
        icon: numberPin(number, 'recap-pin'),
        zIndexOffset: 500,
        keyboard: false,
      })
        .addTo(map)
        .bindTooltip(text(`${number}. ${round.locationName}`), {
          direction: 'top',
          className: 'pin-label pin-label--answer',
        });
    }

    map.fitBounds(everything(rounds, youId), FIT);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [rounds, youId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || focusedRef.current === focus) return;
    focusedRef.current = focus;
    const round = focus === null ? undefined : rounds.find((r) => r.roundIndex === focus);
    const animate = !prefersReducedMotion();
    if (!round) {
      if (animate) map.flyToBounds(everything(rounds, youId), { ...FIT, duration: 0.8 });
      else map.fitBounds(everything(rounds, youId), { ...FIT, animate: false });
      return;
    }
    const guess = yourGuess(round, youId);
    const bounds = L.latLngBounds([round.actual, ...(guess ? [guess] : [])]);
    // No guess means one point, and fitting one point zooms to street level.
    if (!guess) {
      map.setView(round.actual, 5, { animate });
      return;
    }
    if (animate) map.flyToBounds(bounds, { ...FIT, duration: 0.8 });
    // Explicitly still: left to itself, Leaflet animates a fit's zoom anyway.
    else map.fitBounds(bounds, { ...FIT, animate: false });
  }, [focus, rounds, youId]);

  return <div ref={hostRef} className="map map--recap" />;
}

function yourGuess(round: RoundSummary, youId: string): LatLng | null {
  return round.results.find((r) => r.playerId === youId)?.guess ?? null;
}

function everything(rounds: RoundSummary[], youId: string): L.LatLngBounds {
  const points: LatLng[] = rounds.flatMap((round) => {
    const guess = yourGuess(round, youId);
    return guess ? [round.actual, guess] : [round.actual];
  });
  return L.latLngBounds(points);
}

function numberPin(number: string, className: string): L.DivIcon {
  return L.divIcon({
    className: 'map-pin',
    html: `<span class="${className}">${number}</span>`,
    iconSize: [PIN, PIN],
    iconAnchor: [PIN / 2, PIN / 2],
    tooltipAnchor: [0, -PIN / 2],
  });
}

function text(value: string): HTMLElement {
  const span = document.createElement('span');
  span.textContent = value;
  return span;
}
