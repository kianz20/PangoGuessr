import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { isValidCode } from '@pangoguessr/shared';
import type { ClientMessage, ServerMessage } from '@pangoguessr/shared';
import { RoomStore, type Conn } from './rooms';

const PORT = Number(process.env.PORT ?? 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

const store = new RoomStore();
const app = express();
const server = createServer(app);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    rooms: store.roomCount,
    uptimeSeconds: Math.round(process.uptime()),
    // Never in production: player names are more than a health check needs to expose.
    ...(IS_PROD ? {} : { detail: store.describe() }),
  });
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
      console.log(`[room ${result.room.code}] round 1 started`);
      return;
    }

    case 'submitGuess': {
      const result = store.submitGuess(conn, msg.lat, msg.lng, msg.elapsedMs);
      if (!result.ok) {
        conn.send({ type: 'error', code: result.code, message: result.message });
      }
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

server.listen(PORT, () => {
  console.log(`PangoGuessr server on :${PORT} (${IS_PROD ? 'production' : 'development'})`);
});
