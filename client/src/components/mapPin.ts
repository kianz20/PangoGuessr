import L from 'leaflet';

/**
 * Leaflet's default marker is a PNG referenced from its own CSS, which a bundler doesn't
 * serve — you get a broken-image icon. A DivIcon has no asset to lose, scales crisply on a
 * phone, and can be themed from styles.css.
 */
export const GUESS_PIN = L.divIcon({
  className: 'pin-marker',
  html: '<span class="pin-marker__body"></span>',
  iconSize: [24, 34],
  // Anchor at the tip, so the point sits exactly on the tapped coordinate.
  iconAnchor: [12, 34],
  tooltipAnchor: [0, -28],
});
