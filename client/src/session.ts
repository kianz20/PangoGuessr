const SESSION_KEY = 'pangoguessr.sessionId';
const LAST_ROOM_KEY = 'pangoguessr.lastRoom';

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
