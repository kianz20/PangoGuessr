/// <reference types="google.maps" />
import { getConfig, loadStreetView } from './maps';

export type PanoramaStatus = 'loading' | 'ready' | 'error';

/**
 * Every Street View viewer this page holds, keyed by panorama ID — and the only place one is
 * ever created, because each one bills a load (§7).
 *
 * The room deals its whole game in the lobby, so each phone builds the viewers ahead of time,
 * hidden, and a round just moves its already-loaded viewer on screen. Nobody waits on imagery
 * mid-game, and it costs nothing extra: it's the same one load per player per round, spent
 * earlier. A viewer survives being unmounted — StrictMode, a dropped socket, a reconnect — and
 * is only destroyed once the room has moved past its round.
 */
type Entry = {
  /** What the panorama renders into. Moved between the parking lot and the round's stage. */
  element: HTMLDivElement;
  panorama: google.maps.StreetViewPanorama | null;
  status: PanoramaStatus;
  listeners: Set<(status: PanoramaStatus) => void>;
  disposed: boolean;
};

const entries = new Map<string, Entry>();
/** What the rest of the game will show, in the order it's needed. */
let wanted: string[] = [];
let pumping = false;
let lot: HTMLDivElement | null = null;

/** No event says a panorama's tiles have arrived, so give them a moment once it's accepted. */
const TILE_SETTLE_MS = 2_000;
/** A panorama that never reports back mustn't hold up the rest of the queue. */
const PRELOAD_TIMEOUT_MS = 15_000;

/**
 * Keeps viewers for exactly these panoramas: starts loading any that are missing and drops
 * any the room has moved past, or that belonged to a cancelled game.
 */
export function preloadPanoramas(panoIds: readonly string[]): void {
  // Placeholder tokens from the fixed list never touch Google.
  wanted = panoIds.filter((id) => !id.startsWith('dev:'));
  for (const [id, entry] of entries) {
    if (!wanted.includes(id)) dispose(id, entry);
  }
  void pump();
}

/**
 * Shows `panoId` inside `host` — the preloaded viewer if there is one, or one started now if
 * not (a reload mid-round, say). Returns a release function that parks it again.
 */
export function showPanorama(
  panoId: string,
  host: HTMLElement,
  onStatus: (status: PanoramaStatus) => void,
): () => void {
  const entry = entries.get(panoId) ?? open(panoId);
  host.appendChild(entry.element);
  resize(entry);
  entry.listeners.add(onStatus);
  onStatus(entry.status);

  return () => {
    entry.listeners.delete(onStatus);
    // Parked, not destroyed: a remount reuses it instead of billing a second load. It's
    // dropped by preloadPanoramas once the room moves past its round.
    if (!entry.disposed) {
      parkingLot().appendChild(entry.element);
      resize(entry);
    }
  };
}

/**
 * One at a time, in round order, so the next round's panorama gets the whole connection
 * instead of sharing it with every round after it.
 */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (let next = nextToLoad(); next; next = nextToLoad()) {
      await settled(open(next));
    }
  } finally {
    pumping = false;
  }
}

function nextToLoad(): string | undefined {
  return wanted.find((id) => !entries.has(id));
}

async function settled(entry: Entry): Promise<void> {
  const deadline = Date.now() + PRELOAD_TIMEOUT_MS;
  while (entry.status === 'loading' && !entry.disposed && Date.now() < deadline) {
    await sleep(250);
  }
  if (!entry.disposed) await sleep(TILE_SETTLE_MS);
}

function open(panoId: string): Entry {
  const element = document.createElement('div');
  element.style.cssText = 'position:absolute;inset:0';
  parkingLot().appendChild(element);

  const entry: Entry = {
    element,
    panorama: null,
    status: 'loading',
    listeners: new Set(),
    disposed: false,
  };
  entries.set(panoId, entry);
  void mount(panoId, entry);
  return entry;
}

async function mount(panoId: string, entry: Entry): Promise<void> {
  try {
    const { mapsBrowserKey } = await getConfig();
    if (!mapsBrowserKey) throw new Error('No browser key configured');
    const { StreetViewPanorama, StreetViewStatus } = await loadStreetView(mapsBrowserKey);
    // The room moved past it while the library loaded: nothing built, nothing billed.
    if (entry.disposed) return;

    const panorama = new StreetViewPanorama(entry.element, {
      pano: panoId,
      // Pannable, not movable (§7). Movement bills a new load per step — 20 players
      // taking 10 steps each is ~220 loads for one round, against 100 for a whole game.
      linksControl: false,
      clickToGo: false,
      disableDefaultUI: true,
      motionTracking: false,
      motionTrackingControl: false,
      showRoadLabels: false, // road names would give the country away
      zoomControl: true,
    });
    entry.panorama = panorama;

    // 'pano_changed' fires once the viewer has accepted the ID; tiles follow. This is the
    // closest signal to "the player can see something".
    panorama.addListener('pano_changed', () => setStatus(entry, 'ready'));
    // A wrong or retired panorama ID would otherwise sit as a grey box.
    panorama.addListener('status_changed', () => {
      if (panorama.getStatus() !== StreetViewStatus.OK) setStatus(entry, 'error');
    });
  } catch (err) {
    if (entry.disposed) return;
    console.error('Panorama failed to load', err);
    setStatus(entry, 'error');
  }
}

function setStatus(entry: Entry, status: PanoramaStatus): void {
  // An error is final; a late 'pano_changed' mustn't paper over it.
  if (entry.disposed || entry.status === status || entry.status === 'error') return;
  entry.status = status;
  for (const listener of entry.listeners) listener(status);
}

function dispose(panoId: string, entry: Entry): void {
  entry.disposed = true;
  entry.listeners.clear();
  if (entry.panorama) {
    google.maps.event.clearInstanceListeners(entry.panorama);
    entry.panorama.setVisible(false);
    entry.panorama = null;
  }
  entry.element.remove();
  entries.delete(panoId);
}

/** The viewer measures its container; moving it between containers needs a nudge. */
function resize(entry: Entry): void {
  if (entry.panorama) google.maps.event.trigger(entry.panorama, 'resize');
}

/**
 * Where viewers wait for their round. Full-viewport, so tiles load at roughly the size they'll
 * be shown, and inside the viewport so nothing treats them as offscreen — but invisible and
 * untouchable.
 */
function parkingLot(): HTMLDivElement {
  if (lot) return lot;
  lot = document.createElement('div');
  lot.setAttribute('aria-hidden', 'true');
  lot.inert = true;
  lot.style.cssText =
    'position:fixed;inset:0;z-index:-1;opacity:0;pointer-events:none;overflow:hidden';
  document.body.appendChild(lot);
  return lot;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
