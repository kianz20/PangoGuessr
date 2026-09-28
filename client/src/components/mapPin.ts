import L from 'leaflet';

/**
 * Leaflet's default marker is a PNG referenced from its own CSS, which a bundler doesn't
 * serve — you get a broken-image icon. A DivIcon has no asset to lose, scales crisply on a
 * phone, and can be themed from styles.css.
 */
export const GUESS_PIN = L.divIcon({
  className: 'pin-marker',
  html: '<span class="pin-marker__body"></span>',
  iconSize: [24, 30],
  // Anchor at the tip, so the point sits exactly on the tapped coordinate. The tip is the
  // 24px square's corner turned to point down: 12 + 12√2 ≈ 29px from the top.
  iconAnchor: [12, 29],
  tooltipAnchor: [0, -24],
});
