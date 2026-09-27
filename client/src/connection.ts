import { CLOSE_REPLACED } from '@pangoguessr/shared';
import type { ClientMessage, ReconnectDiag, ServerMessage } from '@pangoguessr/shared';

/**
 * The page's one WebSocket to the server, and everything it takes to keep that alive on a
 * phone (§8): noticing when it has died without saying so, getting back quickly when it has,
 * and telling the server what happened. It knows nothing about the game — `useRoom` decides
 * what to say on each connect and what the messages mean.
 *
 * Phones drop sockets constantly: screen locks, app switches, WiFi-to-4G handoffs, lifts.
 * Most of those are over in a second, so the job is to make them cost about that much.
 */

/** Past this, a slow first connect is almost certainly a cold start, not a slow phone (§9). */
const WAKING_AFTER_MS = 3_000;

/**
 * Once in a room the server is known to be awake, so a handshake this slow is a bad network,
 * not a cold start. Giving up on it matters: until an attempt fails, nothing else is tried.
 */
const RECONNECT_TIMEOUT_MS = 5_000;

/**
 * Back-off between attempts, with jitter so a room that dropped together doesn't hammer the
 * server in lockstep. The first is immediate: most drops are a screen lock or a handoff, and
 * the network is usually already back by the time the page notices.
 */
const RETRY_STEPS_MS = [0, 500, 1_000, 2_000, 4_000];

/**
 * The app-level heartbeat. Browsers hide the protocol's ping frames from JavaScript, so
 * without this a socket that died silently — a tunnel, a dead WiFi — looks open until the OS
 * gives up on it, which can take minutes. Worst case this notices in PING + PATIENCE.
 */
const PING_EVERY_MS = 4_000;
const PONG_PATIENCE_MS = 6_000;
/** Coming back to the page: the socket may have died while we were away, so check quickly. */
const WAKE_PATIENCE_MS = 3_000;
/** Heartbeat ticks this far apart mean the page was frozen, so the silence proves nothing. */
const ASLEEP_AFTER_MS = 3_000;

export type ConnectionEvents = {
  /** A socket opened: say who we are. `diag` is set when this is recovering from a drop. */
  onOpen(diag: ReconnectDiag | undefined): void;
  onMessage(msg: ServerMessage): void;
  /** Lost the socket, or couldn't get one. `since` is when the trouble started. */
  onDown(since: number): void;
  /** A first connect is taking long enough to be the server waking up (§9). */
  onSlow(): void;
  /** The same player connected from another tab or device, so this page has stopped. */
  onReplaced(): void;
};

type Drop = {
  /** Null when the page itself reloaded, so there's no telling when the socket went. */
  at: number | null;
  cause: ReconnectDiag['cause'];
  closeCode: number;
  hidden: boolean;
};

/** Chrome on Android has it, Safari doesn't; worth having where it exists. */
type WithNetworkInfo = Navigator & { connection?: EventTarget };

function socketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export class Connection {
  private socket: WebSocket | null = null;
  private running = false;
  /**
   * The server has had us in a room on this page, so a lost socket is a reconnect to a server
   * that's awake — not a first connect to one that may be asleep.
   */
  private inRoom = false;
  /** Since the last one that got us into the room: drives back-off, and is reported. */
  private attempts = 0;
  /** The drop being recovered from, reported with the join that ends it. */
  private drop: Drop | null = null;
  /** When the heartbeat we're waiting on counts as unanswered. Null when nothing is owed. */
  private pingDeadline: number | null = null;
  private lastPingAt = 0;
  private lastBeatAt = 0;
  private attemptStartedAt = 0;
  private retryTimer: number | undefined;
  /** The cold-start notice for a first connect, or the give-up timer for a reconnect. */
  private attemptTimer: number | undefined;
  private heartbeat: number | undefined;

  constructor(private readonly events: ConnectionEvents) {}

  /**
   * Connects, and keeps reconnecting until `stop`.
   *
   * `reload`: this page is coming back to a room it was in before it loaded, which the rejoin
   * reports — a phone that reloads mid-game looks just like a slow reconnect to its player.
   * `inRoom`: carrying on in a room this page is already showing (taking over from another
   * tab), so there's no cold start to allow for.
   */
  start({ reload = false, inRoom = false }: { reload?: boolean; inRoom?: boolean } = {}): void {
    this.stop();
    this.running = true;
    this.inRoom = inRoom;
    this.attempts = 0;
    this.drop = reload ? { at: null, cause: 'reload', closeCode: 0, hidden: false } : null;

    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pageshow', this.onPageShow);
    window.addEventListener('online', this.wake);
    window.addEventListener('offline', this.onOffline);
    (navigator as WithNetworkInfo).connection?.addEventListener('change', this.wake);
    this.lastBeatAt = Date.now();
    this.heartbeat = window.setInterval(this.beat, 1_000);

    this.open();
  }

  /** Closes the socket for good: no reconnecting until `start` is called again. */
  stop(): void {
    this.running = false;
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.attemptTimer);
    window.clearInterval(this.heartbeat);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pageshow', this.onPageShow);
    window.removeEventListener('online', this.wake);
    window.removeEventListener('offline', this.onOffline);
    (navigator as WithNetworkInfo).connection?.removeEventListener('change', this.wake);
    this.pingDeadline = null;

    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  /** False when there's no open socket; the message is dropped, not queued. */
  send(msg: ClientMessage): boolean {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(msg));
    return true;
  }

  /** The server has us in the room: any drop is over, and the next one is a reconnect. */
  joined(): void {
    this.inRoom = true;
    this.attempts = 0;
    this.drop = null;
  }

  private open(): void {
    if (!this.running) return;
    // Never a second socket. The server treats a second connection on the same sessionId as
    // a takeover and closes the first, so two at once would fight over the player's slot.
    const existing = this.socket;
    if (existing && existing.readyState <= WebSocket.OPEN) return;

    window.clearTimeout(this.retryTimer);
    this.attempts++;
    this.attemptStartedAt = Date.now();
    this.pingDeadline = null;

    const socket = new WebSocket(socketUrl());
    this.socket = socket;

    window.clearTimeout(this.attemptTimer);
    this.attemptTimer = this.inRoom
      ? window.setTimeout(() => {
          if (socket.readyState === WebSocket.CONNECTING) this.abandon(socket, 'stale');
        }, RECONNECT_TIMEOUT_MS)
      : // Only claim we're waking the server if the connection is actually taking a while —
        // otherwise every join flashes a scary message (§9).
        window.setTimeout(() => {
          if (this.socket === socket && socket.readyState === WebSocket.CONNECTING) {
            this.events.onSlow();
          }
        }, WAKING_AFTER_MS);

    socket.onopen = () => {
      if (this.socket !== socket) return;
      window.clearTimeout(this.attemptTimer);
      this.lastPingAt = Date.now();
      this.events.onOpen(this.diagnosis());
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      // Anything at all proves the socket is alive, not just the pong.
      this.pingDeadline = null;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type !== 'pong') this.events.onMessage(msg);
    };

    socket.onclose = (event) => {
      // Only the live socket. One we already gave up on can take its time to close.
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.running) return;
      if (event.code === CLOSE_REPLACED) {
        // Reconnecting would take the slot straight back from the other tab, which would do
        // the same — the two used to kick each other out every few seconds indefinitely.
        this.stop();
        this.events.onReplaced();
        return;
      }
      this.dropped('closed', event.code);
    };
  }

  /** Gives up on a socket that's gone silent or is stuck connecting, and starts again. */
  private abandon(socket: WebSocket, cause: Drop['cause']): void {
    if (this.socket !== socket) return;
    // Forgotten before closing, so its close event — whenever it arrives — is ignored.
    this.socket = null;
    socket.close();
    this.dropped(cause, 0);
  }

  private dropped(cause: Drop['cause'], closeCode: number): void {
    this.pingDeadline = null;
    const now = Date.now();
    // The first failure is the one worth reporting; the attempts after it are the recovery.
    this.drop ??= { at: now, cause, closeCode, hidden: document.hidden };
    this.events.onDown(this.drop.at ?? now);
    this.retry();
  }

  private retry(): void {
    window.clearTimeout(this.retryTimer);
    const step = RETRY_STEPS_MS[Math.min(this.attempts, RETRY_STEPS_MS.length - 1)]!;
    const delay = step * (0.75 + Math.random() * 0.5);
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  /**
   * The page is back in front of the player, or the network changed under it: check now,
   * rather than waiting out a back-off step or the next heartbeat.
   */
  private wake = (): void => {
    if (!this.running) return;
    const socket = this.socket;
    if (!socket) {
      this.open();
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      this.probe(WAKE_PATIENCE_MS);
      return;
    }
    // An attempt started before the page froze or the network changed is unlikely to land.
    if (socket.readyState === WebSocket.CONNECTING && Date.now() - this.attemptStartedAt > 1_000) {
      this.socket = null;
      socket.close();
      this.drop ??= { at: Date.now(), cause: 'stale', closeCode: 0, hidden: document.hidden };
      this.open();
    }
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') this.wake();
  };

  /** Restored from the back/forward cache, where the socket will have been closed. */
  private onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) this.wake();
  };

  /** No network at all: the socket is certainly dead, so don't wait for it to say so. */
  private onOffline = (): void => {
    if (this.socket) this.abandon(this.socket, 'offline');
  };

  private beat = (): void => {
    const now = Date.now();
    const asleep = now - this.lastBeatAt > ASLEEP_AFTER_MS;
    this.lastBeatAt = now;

    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    // A hidden page's timers are throttled or frozen, so silence proves nothing yet. The
    // socket is checked the moment the page is visible again.
    if (document.hidden) return;
    if (asleep) {
      this.probe(WAKE_PATIENCE_MS);
      return;
    }
    if (this.pingDeadline !== null) {
      if (now > this.pingDeadline) this.abandon(socket, 'stale');
      return;
    }
    if (now - this.lastPingAt >= PING_EVERY_MS) this.probe(PONG_PATIENCE_MS);
  };

  /** Sends a heartbeat that must be answered — by anything — within `patienceMs`. */
  private probe(patienceMs: number): void {
    const now = Date.now();
    // A fresh deadline, not the old one: one set before the page froze has long passed.
    this.pingDeadline = now + patienceMs;
    this.lastPingAt = now;
    this.send({ type: 'ping' });
  }

  private diagnosis(): ReconnectDiag | undefined {
    const drop = this.drop;
    if (!drop) return undefined;
    return {
      cause: drop.cause,
      downMs: drop.at === null ? null : Date.now() - drop.at,
      attempts: this.attempts,
      closeCode: drop.closeCode,
      hidden: drop.hidden,
    };
  }
}
