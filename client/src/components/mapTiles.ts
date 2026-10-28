import L from 'leaflet';

/**
 * Esri's World Street Map rather than OpenStreetMap's own tiles. OSM labels every place in its
 * local script — Москва, 北京, กรุงเทพ — which leaves half the world unreadable on a map whose
 * whole job is "where is this?". Esri labels in English down to city level (street-level zooms
 * in some countries add the local name alongside), and like OSM it needs no key.
 *
 * Note the {y}/{x} order: Esri's tile URLs put the row before the column.
 */
const TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
const TILE_ATTRIBUTION = 'Tiles © Esri';

/** The base map every Leaflet map in the game draws on, so they all read the same. */
export function baseTiles(options: L.TileLayerOptions = {}): L.TileLayer {
  return L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, ...options });
}
