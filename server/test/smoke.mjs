/**
 * End-to-end check over a real WebSocket against a running server. Unit tests cover the
 * room store directly; this covers the wiring — protocol shape, broadcast fan-out, and the
 * reconnect path that actually matters on phones.
 *
 *   node server/test/smoke.mjs [port]      # default 3000, i.e. `npm run dev`
 */
import WebSocket from 'ws';

const PORT = Number(process.argv[2] ?? 3000);
const HTTP = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}/ws`;

let failures = 0;
const log = (...a) => console.log(...a);
const check = (cond, what) => {
  log(`   ${cond ? 'PASS' : 'FAIL'}  ${what}`);
  if (!cond) failures++;
};

function client(label) {
  const socket = new WebSocket(WS);
  const inbox = [];
  const waiters = [];
  socket.on('message', (raw) => {
    inbox.push(JSON.parse(raw.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  return {
    socket,
    label,
    open: new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    }),
    send: (msg) => socket.send(JSON.stringify(msg)),
    async waitFor(type, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = inbox.find((m) => m.type === type);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`${label}: timed out waiting for ${type}`);
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, 25);
        });
      }
    },
  };
}

const health = await fetch(`${HTTP}/api/health`).then((r) => r.json());
log(`server up, ${health.rooms} room(s) live\n`);

log('1. host creates a room');
const host = client('host');
await host.open;
host.send({ type: 'create', displayName: 'Host', sessionId: 'smoke-host' });
const created = await host.waitFor('roomState');
const code = created.code;
check(/^[2-9A-HJ-NP-TV-Z]{4}$/.test(code), `code "${code}" uses the spoken-alphabet charset`);
check(created.players[0].isHost === true, 'creator is host');
check(created.phase === 'LOBBY', 'room starts in LOBBY');

log('\n2. a guest joins with that code');
const guest = client('guest');
await guest.open;
guest.send({ type: 'join', code, displayName: 'Kian', sessionId: 'smoke-guest' });
const joined = await guest.waitFor('roomState');
check(joined.players.length === 2, 'guest sees both players');
check(!JSON.stringify(joined).includes('smoke-'), 'no sessionId leaks in roomState');

log('\n3. the guest drops and reconnects with the same sessionId');
guest.socket.terminate();
await new Promise((r) => setTimeout(r, 300));
const guestBack = client('guest2');
await guestBack.open;
guestBack.send({ type: 'join', code, displayName: 'Kian', sessionId: 'smoke-guest' });
const back = await guestBack.waitFor('roomState');
check(back.players.length === 2, `no ghost duplicate (${back.players.length} players)`);
check(
  back.players.every((p) => p.connected),
  'everyone shows as connected again',
);

log('\n4. someone else cannot take a name already in use');
const clash = client('clash');
await clash.open;
clash.send({ type: 'join', code, displayName: 'kian', sessionId: 'smoke-other' });
const nameErr = await clash.waitFor('error');
check(nameErr.code === 'NAME_TAKEN', `case-insensitive clash rejected (${nameErr.code})`);

log('\n5. a bad code is rejected rather than creating anything');
const lost = client('lost');
await lost.open;
lost.send({ type: 'join', code: 'ZZZZ', displayName: 'Nobody', sessionId: 'smoke-lost' });
const lostErr = await lost.waitFor('error');
check(lostErr.code === 'ROOM_NOT_FOUND', `unknown room rejected (${lostErr.code})`);

log('\n6. rounds are not implemented yet (step 2)');
host.send({ type: 'startRound' });
const notYet = await host.waitFor('error');
check(notYet.code === 'BAD_MESSAGE', `startRound refused: "${notYet.message}"`);

log('\n7. the host leaving closes the room for everyone');
host.send({ type: 'leave' });
const closed = await guestBack.waitFor('roomClosed');
check(closed.reason === 'hostLeft', `guest told the room closed (${closed.reason})`);
const after = await fetch(`${HTTP}/api/health`).then((r) => r.json());
check(after.rooms === health.rooms, `room count back to ${health.rooms}`);

log(failures === 0 ? '\nsmoke test passed' : `\nsmoke test FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
