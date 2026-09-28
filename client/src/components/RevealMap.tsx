import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type { GuessResult, LatLng } from '@pangoguessr/shared';
import { easeOutCubic, prefersReducedMotion } from '../motion';
import { initials, type ColorOf } from '../players';
import { play } from '../sound';

const OSM_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '© OpenStreetMap';

/** The reveal's beats: a moment on the answer, out to everyone, then the pins one by one. */
const FOCUS_MS = 800;
const FLY_MS = 1_000;
/** However many guessed, the pins take about this long — 20 players mustn't mean a minute. */
const PINS_MS = 1_800;
const MAX_PIN_STEP_MS = 320;
/** Each guess's line growing from the pin toward the answer. */
const LINE_MS = 380;
/** Where the reveal starts: close enough on the answer to read as "here". */
const START_ZOOM = 6;
/** Pin diameters: yours is bigger, so it's the first one your eye finds. */
const PIN = 26;
const YOU_PIN = 32;

const FIT: L.FitBoundsOptions = { padding: [36, 36], maxZoom: 12 };

const ANSWER_PIN = L.divIcon({
  className: 'pin-marker pin-marker--answer',
  html: '<span class="pin-drop"><span class="pin-marker__body"></span></span>',
  iconSize: [28, 34],
  // Anchored at the tip, so the point sits exactly on the answer: 14 + 14√2 ≈ 34px down.
  iconAnchor: [14, 34],
  tooltipAnchor: [0, -30],
});

type Guessed = GuessResult & { guess: LatLng };

/** Worst first, so the room's closest guess is the last to land. */
function revealOrder(results: GuessResult[]): Guessed[] {
  return results
    .filter((r): r is Guessed => r.guess !== null)
    .sort((a, b) => (b.distanceKm ?? 0) - (a.distanceKm ?? 0));
}

/**
 * When each player's pin lands, and when the last one has — so the rest of the results screen
 * can wait for the map instead of giving the ending away underneath it. All zero with
 * reduced motion, when everything is drawn at once.
 */
export function revealSchedule(results: GuessResult[]): {
  landsAt: Map<string, number>;
  doneAt: number;
} {
  if (prefersReducedMotion()) return { landsAt: new Map(), doneAt: 0 };
  const order = revealOrder(results);
  const step = Math.min(MAX_PIN_STEP_MS, PINS_MS / Math.max(order.length, 1));
  const landsAt = new Map(order.map((g, i) => [g.playerId, FOCUS_MS + FLY_MS + i * step]));
  const doneAt = order.length === 0 ? FOCUS_MS : FOCUS_MS + FLY_MS + (order.length - 1) * step + LINE_MS;
  return { landsAt, doneAt };
}

/**
 * Every player's pin, labelled, plus the answer (§4). Showing all 16–20 is the point —
 * seeing how badly everyone else missed is most of the entertainment — so this has to stay
 * legible on a phone: initials on each pin, bounds that fit everyone, and your own label
 * pinned open.
 *
 * Revealed rather than drawn at once: the answer first, then out to fit the room, then each
 * guess landing worst to best, so the room's closest guess is the last thing to appear.
 */
export function RevealMap({
  actual,
  results,
  youId,
  colorOf,
}: {
  actual: LatLng;
  results: GuessResult[];
  youId: string;
  colorOf: ColorOf;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Read once per reveal. It's a new function every render, and restarting the reveal on
  // every render would never let it finish.
  const colorOfRef = useRef(colorOf);
  colorOfRef.current = colorOf;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const map = L.map(host, { zoomControl: true, worldCopyJump: true });
    L.tileLayer(OSM_URL, { attribution: OSM_ATTRIBUTION }).addTo(map);

    let alive = true;
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms));

    L.marker(actual, { icon: ANSWER_PIN, zIndexOffset: 1000, keyboard: false })
      .addTo(map)
      .bindTooltip(text('Answer'), {
        permanent: true,
        direction: 'top',
        className: 'pin-label pin-label--answer',
      });

    const guesses = revealOrder(results);
    const bounds = L.latLngBounds([actual, ...guesses.map((g) => g.guess)]);

    const fitEveryone = (animate: boolean) => {
      // Nobody guessed: a fit on the answer alone would zoom to street level, which reads as
      // a bug.
      if (guesses.length === 0) map.setView(actual, 5, { animate });
      else if (animate) map.flyToBounds(bounds, { ...FIT, duration: FLY_MS / 1000 });
      else map.fitBounds(bounds, FIT);
    };

    const drop = (result: Guessed, animate: boolean) => {
      const isYou = result.playerId === youId;
      const color = colorOfRef.current(result.playerId);
      // A line to the answer makes "how far off was that" readable at a glance.
      const line = L.polyline([result.guess, animate ? result.guess : actual], {
        color: isYou ? '#f0b542' : color,
        weight: isYou ? 2.5 : 1.5,
        opacity: isYou ? 0.95 : 0.65,
        dashArray: '4 5',
        interactive: false,
      }).addTo(map);

      const size = isYou ? YOU_PIN : PIN;
      L.marker(result.guess, {
        icon: avatarPin(result.name, color, isYou),
        zIndexOffset: isYou ? 500 : 0,
        keyboard: false,
      })
        .addTo(map)
        // Only your own label is pinned open; 20 permanent labels is an unreadable mess on a
        // phone. Tap any pin to read its name. Text, not HTML: names are typed by players.
        // Yours hangs below the pin, so a close guess doesn't cover the answer's label above.
        .bindTooltip(text(result.name), {
          permanent: isYou,
          direction: isYou ? 'bottom' : 'top',
          offset: isYou ? [0, size] : [0, 0],
          className: `pin-label${isYou ? ' pin-label--you' : ''}`,
        });

      if (!animate) return;
      const from = result.guess;
      const began = performance.now();
      const grow = (now: number) => {
        if (!alive) return;
        const t = easeOutCubic(Math.min(1, (now - began) / LINE_MS));
        line.setLatLngs([
          from,
          { lat: from.lat + (actual.lat - from.lat) * t, lng: from.lng + (actual.lng - from.lng) * t },
        ]);
        if (t < 1) requestAnimationFrame(grow);
      };
      requestAnimationFrame(grow);
    };

    play('answer');
    if (prefersReducedMotion()) {
      fitEveryone(false);
      for (const guess of guesses) drop(guess, false);
    } else {
      map.setView(actual, START_ZOOM, { animate: false });
      later(() => fitEveryone(true), FOCUS_MS);
      const { landsAt } = revealSchedule(results);
      // Each pin a note higher than the last, so the room's closest guess lands on the top one.
      guesses.forEach((guess, i) =>
        later(() => {
          drop(guess, true);
          play('land', { step: i });
        }, landsAt.get(guess.playerId)!),
      );
    }

    return () => {
      alive = false;
      timers.forEach(window.clearTimeout);
      map.remove();
    };
  }, [actual, results, youId]);

  return <div ref={hostRef} className="map map--reveal" />;
}

function avatarPin(name: string, color: string, isYou: boolean): L.DivIcon {
  const chip = document.createElement('span');
  chip.className = `map-avatar${isYou ? ' map-avatar--you' : ''}`;
  chip.style.setProperty('--avatar', color);
  chip.textContent = initials(name);
  const size = isYou ? YOU_PIN : PIN;
  return L.divIcon({
    className: 'map-pin',
    html: chip,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    tooltipAnchor: [0, -size / 2],
  });
}

function text(value: string): HTMLElement {
  const span = document.createElement('span');
  span.textContent = value;
  return span;
}
