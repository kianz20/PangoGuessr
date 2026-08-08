import { useEffect, useRef } from 'react';
import L from 'leaflet';

export type Bbox = [south: number, west: number, north: number, east: number];

export type ZoneShape = { id: string; name: string; bbox: Bbox };
export type TestHit = { lat: number; lng: number };

const OSM_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * Drag on the map to draw a zone; existing zones render as rectangles you can click to
 * select. Deliberately not `leaflet-draw`: drag-to-draw is the only tool this screen needs,
 * and it's less code than wiring up (and styling) a whole editing toolbar.
 */
export function ZoneMap({
  zones,
  selectedId,
  testHits,
  onSelect,
  onDraw,
}: {
  zones: ZoneShape[];
  selectedId: string | null;
  testHits: TestHit[];
  onSelect: (id: string) => void;
  onDraw: (bbox: Bbox) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const shapesRef = useRef<L.LayerGroup | null>(null);
  const hitsRef = useRef<L.LayerGroup | null>(null);
  const onDrawRef = useRef(onDraw);
  onDrawRef.current = onDraw;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || mapRef.current) return;

    const map = L.map(host, { center: [10, 0], zoom: 2, zoomSnap: 0 });
    L.tileLayer(OSM_URL, { attribution: '© OpenStreetMap' }).addTo(map);
    shapesRef.current = L.layerGroup().addTo(map);
    hitsRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // Drag-to-draw: hold and drag on empty map to define a box. Panning stays available
    // with the keyboard arrows and the zoom controls.
    let anchor: L.LatLng | null = null;
    let preview: L.Rectangle | null = null;

    const onMouseDown = (event: L.LeafletMouseEvent) => {
      if (!event.originalEvent.shiftKey) return; // shift-drag draws, plain drag pans
      anchor = event.latlng;
      map.dragging.disable();
      preview = L.rectangle(L.latLngBounds(anchor, anchor), {
        color: '#35d39a',
        weight: 2,
        dashArray: '4 3',
        fillOpacity: 0.1,
      }).addTo(map);
    };

    const onMouseMove = (event: L.LeafletMouseEvent) => {
      if (!anchor || !preview) return;
      preview.setBounds(L.latLngBounds(anchor, event.latlng));
    };

    const onMouseUp = (event: L.LeafletMouseEvent) => {
      if (!anchor) return;
      const bounds = L.latLngBounds(anchor, event.latlng);
      anchor = null;
      preview?.remove();
      preview = null;
      map.dragging.enable();

      const south = bounds.getSouth();
      const north = bounds.getNorth();
      const west = bounds.getWest();
      const east = bounds.getEast();
      // A click rather than a drag: ignore it instead of creating a degenerate zone.
      if (north - south < 0.05 || east - west < 0.05) return;
      onDrawRef.current([
        Math.max(south, -85),
        Math.max(west, -180),
        Math.min(north, 85),
        Math.min(east, 180),
      ]);
    };

    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);

    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(host);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const group = shapesRef.current;
    if (!group) return;
    group.clearLayers();
    for (const zone of zones) {
      const selected = zone.id === selectedId;
      const rect = L.rectangle(
        L.latLngBounds([zone.bbox[0], zone.bbox[1]], [zone.bbox[2], zone.bbox[3]]),
        {
          color: selected ? '#f0b542' : '#8fb3d9',
          weight: selected ? 3 : 1.5,
          fillOpacity: selected ? 0.2 : 0.08,
        },
      )
        .bindTooltip(zone.name, { direction: 'center', className: 'pin-label' })
        .on('click', () => onSelectRef.current(zone.id));
      group.addLayer(rect);
    }
  }, [zones, selectedId]);

  useEffect(() => {
    const group = hitsRef.current;
    if (!group) return;
    group.clearLayers();
    for (const hit of testHits) {
      group.addLayer(
        L.circleMarker([hit.lat, hit.lng], {
          radius: 4,
          color: '#0f1720',
          weight: 1,
          fillColor: '#35d39a',
          fillOpacity: 1,
        }),
      );
    }
  }, [testHits]);

  return <div ref={hostRef} className="map admin__map" />;
}
