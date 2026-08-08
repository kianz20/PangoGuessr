import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { isValidCode } from '@pangoguessr/shared';
import type { ClientMessage, ServerMessage } from '@pangoguessr/shared';
import { loadDotEnv } from './env';
import { createLocationSource, PooledLocationSource } from './locationSource';
import { RoomStore, type Conn } from './rooms';
import { googleMetadataFetcher } from './streetview';
import { createZonePersistence } from './zonePersistence';
import { validateGroups, ZoneStore } from './zoneStore';
import { randomPointIn } from './zones';

loadDotEnv();

const PORT = Number(process.env.PORT ?? 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
/** Unrestricted, server-side only, used for metadata calls. Never reaches the client (§7). */
const SERVER_KEY = process.env.GOOGLE_MAPS_SERVER_KEY;
/** Public by nature; an HTTP-referrer restriction is what protects it (§7). */
const BROWSER_KEY = process.env.GOOGLE_MAPS_BROWSER_KEY ?? '';

/** Not real auth — it stops the URL being found by someone in the room mid-game (§7). */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const zoneStore = new ZoneStore();
const locations = createLocationSource(SERVER_KEY, () => zoneStore.get());
// New zones mean the pool may hold panoramas from zones that no longer exist.
zoneStore.onChange(() => {
  if (locations instanceof PooledLocationSource) locations.clear();
});

const app = express();
app.use(express.json({ limit: '64kb' }));
const server = createServer(app);

/**
 * Instrumentation (§7): panorama loads should track at roughly `rounds × players`. If the
 * ratio drifts above that, something is re-initialising the viewer — and you see it in a log
 * line rather than a month-end invoice.
 */
const usage = { roundsStarted: 0, playerRounds: 0, gamesStarted: 0 };

const store = new RoomStore(undefined, locations, (room, playerCount) => {
  usage.roundsStarted++;
  usage.playerRounds += playerCount;
  console.log(
    `[room ${room.code}] round ${room.roundIndex + 1} — ${playerCount} players, ` +
      `${usage.playerRounds} panorama loads this boot`,
  );
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    rooms: store.roomCount,
    uptimeSeconds: Math.round(process.uptime()),
    usage: {
      ...usage,
      // The number that actually bills. Compare against the free allowance (~10k/month).
      estimatedPanoramaLoads: usage.playerRounds,
    },
    locations: locations.stats(),
    // Enough to confirm a zone store is wired up without needing the admin password.
    zones: {
      groups: zoneStore.get().length,
      count: zoneStore.zoneCount(),
      source: zoneStore.source(),
      store: zoneStore.persistenceLabel(),
      ...(zoneStore.saveError() ? { saveError: zoneStore.saveError() } : {}),
    },
    // Never in production: player names are more than a health check needs to expose.
    ...(IS_PROD ? {} : { detail: store.describe() }),
  });
});

/**
 * The browser key is served at runtime rather than baked into the bundle, so one build works
 * with or without imagery configured — and swapping the key doesn't need a rebuild.
 */
app.get('/api/config', (_req, res) => {
  res.json({ mapsBrowserKey: BROWSER_KEY, imagery: BROWSER_KEY ? 'streetview' : 'placeholder' });
});

// ---------------------------------------------------------------------------------------
// Admin: zone editing (§7)
// ---------------------------------------------------------------------------------------

/**
 * A single shared password, checked on every admin request. The editor's only privileged
 * capability is metadata sampling, which is free, so an exposed editor is an annoyance
 * rather than a bill.
 */
function adminAuthorised(req: express.Request, res: express.Response): boolean {
  if (!ADMIN_PASSWORD) {
    res.status(503).json({ error: 'Admin is disabled: set ADMIN_PASSWORD to enable it.' });
    return false;
  }
  const supplied = req.get('x-admin-password') ?? '';
  if (supplied !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Wrong password.' });
    return false;
  }
  return true;
}

app.get('/api/admin/zones', (req, res) => {
  if (!adminAuthorised(req, res)) return;
  res.json({
    groups: zoneStore.get(),
    source: zoneStore.source(),
    persistence: zoneStore.persistenceLabel(),
    saveError: zoneStore.saveError(),
    imagery: SERVER_KEY ? 'streetview' : 'placeholder',
  });
});

app.put('/api/admin/zones', async (req, res) => {
  if (!adminAuthorised(req, res)) return;
  const result = await zoneStore.set((req.body as { groups?: unknown } | undefined)?.groups);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  console.log(
    `[zones] ${result.groups.length} groups applied from /admin (persisted: ${result.persisted})`,
  );
  res.json({
    ok: true,
    persisted: result.persisted ?? false,
    source: zoneStore.source(),
    saveError: zoneStore.saveError(),
  });
});

/**
 * Samples a candidate bbox and reports what it found — the feature that makes the editor
 * worth having, since it shows immediately whether a zone is mostly ocean (§7). Metadata
 * requests only, so testing a zone never costs anything.
 */
app.post('/api/admin/test-zone', async (req, res) => {
  if (!adminAuthorised(req, res)) return;
  if (!SERVER_KEY) {
    res.status(503).json({ error: 'No GOOGLE_MAPS_SERVER_KEY configured, so zones cannot be tested.' });
    return;
  }

  const body = req.body as { bbox?: unknown; samples?: unknown };
  // Reuse the zone validator so a drawn box is checked the same way a saved one is.
  const validated = validateGroups([
    { id: 'test', name: 'test', weight: 1, zones: [{ id: 'test', name: 'test', weight: 1, bbox: body.bbox }] },
  ]);
  if (!validated.ok) {
    res.status(400).json({ error: validated.error });
    return;
  }

  const zone = validated.groups[0]!.zones[0]!;
  const samples = Math.min(Math.max(Number(body.samples) || 12, 1), 25);
  const stats = { metadataCalls: 0, misses: 0 };
  const fetcher = googleMetadataFetcher(SERVER_KEY, stats);

  try {
    const hits: { lat: number; lng: number; panoId: string }[] = [];
    for (let i = 0; i < samples; i++) {
      const hit = await fetcher(randomPointIn(zone), 5000);
      if (hit) hits.push({ ...hit.at, panoId: hit.panoId });
    }
    res.json({
      samples,
      found: hits.length,
      hitRate: Math.round((hits.length / samples) * 100),
      hits,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Client and API share an origin in prod (§2), so there's no CORS or cross-site cookie
// story to get wrong. In dev, Vite proxies /api and /ws here instead.
if (IS_PROD) {
  const clientDist = path.resolve(fileURLToPath(import.meta.url), '../../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

const wss = new WebSocketServer({ server, path: '/ws' });

/** Adapts a `ws` socket to the transport-agnostic Conn the room store works with. */
function connFor(socket: WebSocket): Conn {
  return {
    send(msg: ServerMessage) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    },
    close() {
      socket.close();
    },
  };
}

/** Phones go quiet without closing the socket; a pong is what proves they're still there. */
const alive = new WeakMap<WebSocket, boolean>();

wss.on('connection', (socket, req) => {
  const conn = connFor(socket);
  alive.set(socket, true);
  // Logged because a phone that can't reach the WS at all looks identical, from the other
  // devices, to a phone whose join was rejected.
  console.log(`[ws] connected from ${req.socket.remoteAddress}`);

  socket.on('pong', () => alive.set(socket, true));

  socket.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      conn.send({ type: 'error', code: 'BAD_MESSAGE', message: 'Malformed message.' });
      return;
    }
    handleMessage(conn, msg);
  });

  socket.on('close', () => {
    const room = store.disconnect(conn);
    if (room) store.broadcastState(room);
  });
});

function handleMessage(conn: Conn, msg: ClientMessage): void {
  switch (msg?.type) {
    case 'create': {
      const result = store.create(conn, msg.displayName, msg.sessionId);
      if (!result.ok) {
        conn.send({ type: 'error', code: result.code, message: result.message });
        return;
      }
      console.log(`[room ${result.room.code}] created by ${result.player.name}`);
      store.broadcastState(result.room);
      return;
    }

    case 'join': {
      if (!isValidCode(msg.code ?? '')) {
        console.log(`[join] rejected malformed code ${JSON.stringify(msg.code)}`);
        conn.send({ type: 'error', code: 'CODE_INVALID', message: 'That code doesn’t look right.' });
        return;
      }
      const result = store.join(conn, msg.code, msg.displayName, msg.sessionId);
      if (!result.ok) {
        console.log(`[join] ${msg.displayName} -> ${msg.code} refused: ${result.code}`);
        conn.send({ type: 'error', code: result.code, message: result.message });
        return;
      }
      console.log(
        `[room ${result.room.code}] ${result.player.name} joined (${result.room.players.size} players)`,
      );
      store.broadcastState(result.room);
      // Mid-results or mid-podium, the state alone isn't enough to draw the screen (§4).
      store.replayPhase(result.room, result.player);
      return;
    }

    case 'leave': {
      const room = store.leave(conn);
      if (room) store.broadcastState(room);
      return;
    }

    case 'kick': {
      const result = store.kick(conn, msg.playerId);
      if (!result.ok) {
        conn.send({ type: 'error', code: result.code, message: result.message });
        return;
      }
      store.broadcastState(result.room);
      return;
    }

    case 'startRound': {
      const result = store.startRound(conn);
      if (!result.ok) {
        conn.send({ type: 'error', code: result.code, message: result.message });
        return;
      }
      usage.gamesStarted++;
      console.log(
        `[room ${result.room.code}] game started — ${result.room.deck.map((l) => l.name).join(', ')}`,
      );
      return;
    }

    case 'submitGuess': {
      const result = store.submitGuess(conn, msg.lat, msg.lng, msg.elapsedMs);
      if (!result.ok) {
        conn.send({ type: 'error', code: result.code, message: result.message });
      }
      return;
    }

    case 'cancelGame': {
      const result = store.cancelGame(conn);
      if (!result.ok) {
        conn.send({ type: 'error', code: result.code, message: result.message });
        return;
      }
      console.log(`[room ${result.room.code}] game cancelled by host`);
      return;
    }

    case 'advance': {
      const result = store.advance(conn);
      if (!result.ok) {
        conn.send({ type: 'error', code: result.code, message: result.message });
        return;
      }
      // beginRound broadcasts its own state; a return to LOBBY needs one.
      if (result.room.phase === 'LOBBY') store.broadcastState(result.room);
      return;
    }

    default:
      conn.send({ type: 'error', code: 'BAD_MESSAGE', message: 'Unknown message type.' });
  }
}

const HEARTBEAT_MS = 15_000;
setInterval(() => {
  for (const socket of wss.clients) {
    if (alive.get(socket) === false) {
      socket.terminate(); // fires 'close', which marks the player disconnected
      continue;
    }
    alive.set(socket, false);
    socket.ping();
  }
}, HEARTBEAT_MS).unref();

const SWEEP_MS = 5_000;
setInterval(() => {
  for (const { code, reason } of store.sweep()) {
    console.log(`[room ${code}] closed (${reason})`);
  }
}, SWEEP_MS).unref();

// Zones are loaded before serving, so the first game of a boot uses the saved list.
await zoneStore.attach(createZonePersistence());
console.log(
  `[zones] ${zoneStore.get().length} groups / ${zoneStore.zoneCount()} zones ` +
    `(source: ${zoneStore.source()}, ` +
    `store: ${zoneStore.persistenceLabel()})`,
);

server.listen(PORT, () => {
  console.log(`PangoGuessr server on :${PORT} (${IS_PROD ? 'production' : 'development'})`);
});
