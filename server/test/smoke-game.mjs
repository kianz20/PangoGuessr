/**
 * Plays a complete 5-round game over real WebSockets against a running server, the way two
 * phones would. Unit tests cover the round logic directly; this proves the wiring.
 *
 *   node server/test/smoke-game.mjs [port]
 */
import WebSocket from 'ws';

const PORT = Number(process.argv[2] ?? 3000);
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
    label,
    open: new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    }),
    send: (msg) => socket.send(JSON.stringify(msg)),
    close: () => socket.close(),
    all: (type) => inbox.filter((m) => m.type === type),
    async next(type, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return inbox.splice(i, 1)[0];
        if (Date.now() > deadline) throw new Error(`${label}: timed out waiting for ${type}`);
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, 25);
        });
      }
    },
  };
}

const host = client('host');
const guest = client('guest');
await Promise.all([host.open, guest.open]);

host.send({ type: 'create', displayName: 'Host', sessionId: 'game-host' });
const created = await host.next('roomState');
const code = created.code;
guest.send({ type: 'join', code, displayName: 'Guest', sessionId: 'game-guest' });
await guest.next('roomState');
log(`room ${code}, 2 players\n`);

log('1. a non-host cannot start the game');
guest.send({ type: 'startRound' });
check((await guest.next('error')).code === 'NOT_HOST', 'guest refused');

log('\n2. playing five rounds');
const WELLINGTON = { lat: -41.2887, lng: 174.7772 };
let previousTotal = 0;
const seenPlaces = new Set();

for (let round = 1; round <= 5; round++) {
  if (round === 1) host.send({ type: 'startRound' });

  const start = await host.next('roundStart');
  await guest.next('roundStart');
  check(start.roundIndex === round - 1, `round ${round}: roundStart index ${start.roundIndex}`);
  const leaked = JSON.stringify(start).match(/lat|lng|locationName/);
  check(leaked === null, `round ${round}: no answer in roundStart`);

  // Host guesses Wellington fast; guest guesses the South Atlantic slowly.
  host.send({ type: 'submitGuess', roundIndex: round - 1, ...WELLINGTON, elapsedMs: 1500 });
  const ack = await host.next('guessAck');
  check(ack.received === true && ack.roundIndex === round - 1, `round ${round}: guess acknowledged`);

  // With one of two players guessed, the round must still be open.
  const early = host.all('roundEnd');
  check(early.length === 0, `round ${round}: round stays open until everyone has guessed`);

  guest.send({ type: 'submitGuess', roundIndex: round - 1, lat: -40, lng: -20, elapsedMs: 38_000 });

  const end = await host.next('roundEnd');
  await guest.next('roundEnd');
  seenPlaces.add(end.locationName);
  check(end.results.length === 2, `round ${round}: both players in the results`);
  check(
    typeof end.actual.lat === 'number' && !!end.locationName,
    `round ${round}: answer revealed (${end.locationName})`,
  );
  check(end.isFinalRound === (round === 5), `round ${round}: isFinalRound correct`);

  const total = end.leaderboard.reduce((sum, row) => sum + row.score, 0);
  check(total > previousTotal, `round ${round}: scores accumulated`);
  previousTotal = total;

  host.send({ type: 'advance' });
}

check(seenPlaces.size === 5, `five distinct locations (${seenPlaces.size})`);

log('\n3. the podium');
const over = await host.next('gameEnd');
await guest.next('gameEnd');
check(over.leaderboard.length === 2, 'both players ranked');
check(over.leaderboard[0].rank === 1 && over.leaderboard[1].rank === 2, 'ranks 1 and 2');
check(
  over.leaderboard[0].score >= over.leaderboard[1].score,
  'leaderboard is sorted best-first',
);
check(
  over.rounds.length === 5 && over.rounds.every((r) => r.results.length === 2),
  'the recap holds every round, with both players in each',
);

log('\n4. play again returns to the lobby with scores cleared');
host.send({ type: 'advance' });
const lobby = await host.next('roomState');
check(lobby.phase === 'LOBBY', `phase is ${lobby.phase}`);
check(
  lobby.players.every((p) => p.score === 0),
  'scores reset',
);
check(lobby.players.length === 2, 'same players, same room');

log('\n5. a latecomer is admitted again now the game is over');
const late = client('late');
await late.open;
late.send({ type: 'join', code, displayName: 'Late', sessionId: 'game-late' });
const joined = await late.next('roomState');
check(joined.players.length === 3, 'room unlocked after the game');

host.send({ type: 'leave' });
[host, guest, late].forEach((c) => c.close());

log(failures === 0 ? '\ngame smoke test passed' : `\ngame smoke test FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
