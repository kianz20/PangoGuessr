import { isValidCode, normalizeCode } from '@pangoguessr/shared';

const SESSION_KEY = 'pangoguessr.sessionId';
const LAST_ROOM_KEY = 'pangoguessr.lastRoom';
const NAME_KEY = 'pangoguessr.name';

/**
 * The only identity in the system (§12). Clearing browser data means becoming a new
 * player, which is accepted. Built into `join` from the first version rather than
 * retrofitted, because an unidentified reconnect is how phone party games break (§8).
 */
export function getSessionId(): string {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = randomId();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

/**
 * A hub (e.g. PangoGaming) handing off a voted-in lobby: the host lands with
 * `?autohost=1&n=<name>&notify=<url>`, players with `?c=<code>&n=<name>&pid=<id>`.
 */
export type Handoff =
  | { kind: 'create'; name: string; notify: string | null }
  | { kind: 'join'; code: string; name: string };

/** Read once per page load; see readHandoff. */
let handoff: Handoff | null | undefined;

/**
 * The hub hand-off in this page's URL, if any — read the first time this is called, and the
 * same answer every time after. Called at boot, before anything reads getSessionId().
 *
 * Adopts `pid` as this browser's identity, so the room it's about to join matches what the
 * hub pre-announced, and `join`'s sessionId matching in rooms.ts treats it as a normal join
 * rather than a stranger showing up.
 *
 * Then strips the hand-off from the address bar. Left there, it acted on every reload and
 * every return to the home screen: a host whose tab reloaded mid-game created a second room
 * and abandoned the first, a kicked player walked straight back in, and a player whose room
 * had closed re-joined it in a loop. A reload now rejoins through recallRoom like any other.
 * `c` stays, as it's also the ordinary QR join link; that goes once it has got them in
 * (clearJoinLink).
 */
export function readHandoff(): Handoff | null {
  if (handoff !== undefined) return handoff;

  const params = new URLSearchParams(location.search);
  const name = params.get('n')?.trim();
  const code = normalizeCode(params.get('c') ?? '');
  const pid = params.get('pid');
  if (pid) localStorage.setItem(SESSION_KEY, pid);

  handoff =
    params.get('autohost') === '1'
      ? { kind: 'create', name: name || 'Host', notify: params.get('notify') }
      : code && name && pid
        ? { kind: 'join', code, name }
        : null;

  if (handoff) {
    for (const key of ['autohost', 'n', 'pid', 'notify']) params.delete(key);
    const query = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}`);
  }
  return handoff;
}

/**
 * NOT `crypto.randomUUID()`. That's restricted to secure contexts, so it exists on
 * localhost and on Render's HTTPS, but is `undefined` when testing from a phone against
 * `http://<lan-ip>:5173` — which is exactly how this gets tested. `getRandomValues` has no
 * such restriction.
 */
function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Last resort. Only identifies a player within one room, so collision risk is academic.
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type LastRoom = { code: string; name: string };

/** Lets a page reload — or Safari discarding the tab — land back in the room. */
export function rememberRoom(room: LastRoom): void {
  localStorage.setItem(LAST_ROOM_KEY, JSON.stringify(room));
}

export function recallRoom(): LastRoom | null {
  const raw = localStorage.getItem(LAST_ROOM_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LastRoom;
    return parsed.code && parsed.name ? parsed : null;
  } catch {
    return null;
  }
}

export function forgetRoom(): void {
  localStorage.removeItem(LAST_ROOM_KEY);
}

/** The name typed on the home screen last time, so a returning player needn't type it again. */
export function recallName(): string {
  return localStorage.getItem(NAME_KEY) ?? '';
}

export function rememberName(name: string): void {
  localStorage.setItem(NAME_KEY, name);
}

/** The room code in this page's URL — the QR join link — if it's a valid one. */
export function linkedCode(): string | null {
  const code = normalizeCode(new URLSearchParams(location.search).get('c') ?? '');
  return isValidCode(code) ? code : null;
}

/**
 * Drops `c` from the address bar once it has got them into a room. A QR link joins on its
 * own when the name is already known, so left there it would do it again on every reload:
 * a kicked player walking straight back in, or a closed room rejoined in a loop.
 */
export function clearJoinLink(): void {
  const params = new URLSearchParams(location.search);
  if (!params.has('c')) return;
  params.delete('c');
  const query = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}`);
}
