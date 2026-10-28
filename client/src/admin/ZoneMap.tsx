import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { baseTiles } from '../components/mapTiles';

export type Bbox = [south: number, west: number, north: number, east: number];

export type ZoneShape = { id: string; name: string; bbox: Bbox; groupId: string };
export type TestHit = { lat: number; lng: number };

/**
 * Drag on the map to draw a zone; existing zones render as rectangles you can click to
 * select. Deliberately not `leaflet-draw`: drag-to-draw is the only tool this screen needs,
 * and it's less code than wiring up (and styling) a whole editing toolbar.
 */
export function ZoneMap({
  zones,
  selectedGroupId,
  selectedZoneId,
  testHits,
  onSelect,
  onDraw,
}: {
  zones: ZoneShape[];
  selectedGroupId: string | null;
  selectedZoneId: string | null;
  testHits: TestHit[];
  onSelect: (zoneId: string, groupId: string) => void;
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

    const map = L.map(host, {
      center: [10, 0],
      zoom: 2,
      zoomSnap: 0,
      // Leaflet binds box-zoom to shift-drag, which is the same gesture used here to draw a
      // zone — leaving it on meant every box you drew also zoomed the map into it.
      boxZoom: false,
    });
    baseTiles().addTo(map);
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
      // Three states, so you can see at a glance which boxes belong to the group you're
      // editing versus the one box you're editing.
      const isZone = zone.id === selectedZoneId;
      const inGroup = zone.groupId === selectedGroupId;
      const rect = L.rectangle(
        L.latLngBounds([zone.bbox[0], zone.bbox[1]], [zone.bbox[2], zone.bbox[3]]),
        {
          color: isZone ? '#f0b542' : inGroup ? '#35d39a' : '#8fb3d9',
          weight: isZone ? 3 : inGroup ? 2 : 1,
          fillOpacity: isZone ? 0.25 : inGroup ? 0.15 : 0.05,
        },
      )
        .bindTooltip(zone.name, { direction: 'center', className: 'pin-label' })
        .on('click', () => onSelectRef.current(zone.id, zone.groupId));
      group.addLayer(rect);
    }
  }, [zones, selectedGroupId, selectedZoneId]);

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
