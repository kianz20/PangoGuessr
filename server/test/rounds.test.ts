import assert from 'node:assert/strict';
import test from 'node:test';
import { RECONNECT_GRACE_MS, ROUNDS_PER_GAME, ROUND_MS, scoreGuess } from '@pangoguessr/shared';
import type { ServerMessage } from '@pangoguessr/shared';
import type { LocationSource, RoundLocation } from '../src/locationSource';
import { RoomStore, type Conn, type Scheduler } from '../src/rooms';

class FakeConn implements Conn {
  readonly sent: ServerMessage[] = [];
  send(msg: ServerMessage): void {
    this.sent.push(msg);
  }
  close(): void {}
  lastOfType<T extends ServerMessage['type']>(type: T) {
    return [...this.sent].reverse().find((m) => m.type === type) as
      | Extract<ServerMessage, { type: T }>
      | undefined;
  }
  countOfType(type: ServerMessage['type']): number {
    return this.sent.filter((m) => m.type === type).length;
  }
}

/** Lets a test fire the room's 46s backstop instantly instead of waiting for it. */
function fakeScheduler() {
  const pending: { fn: () => void; ms: number }[] = [];
  const scheduler: Scheduler = {
    schedule(fn, ms) {
      const entry = { fn, ms };
      pending.push(entry);
      return entry;
    },
    cancel(handle) {
      const i = pending.indexOf(handle as { fn: () => void; ms: number });
      if (i >= 0) pending.splice(i, 1);
    },
  };
  return {
    scheduler,
    get pendingCount() {
      return pending.length;
    },
    get lastDelay() {
      return pending.at(-1)?.ms;
    },
    fireAll() {
      for (const entry of pending.splice(0)) entry.fn();
    },
    /** Fires the most recently armed timer alone — a grace check, leaving the backstop. */
    fireLatest() {
      pending.pop()?.fn();
    },
  };
}

/** A room with a host plus `guestNames.length` guests, all connected. */
function setup(guestNames: string[] = ['A', 'B']) {
  const clock = fakeScheduler();
  const store = new RoomStore(clock.scheduler);
  const hostConn = new FakeConn();
  const created = store.create(hostConn, 'Host', 'sess-host');
  assert.ok(created.ok);
  const room = created.room;

  const guests = guestNames.map((name) => {
    const conn = new FakeConn();
    const joined = store.join(conn, room.code, name, `sess-${name}`);
    assert.ok(joined.ok);
    return { conn, player: joined.player };
  });

  return { store, room, clock, host: { conn: hostConn, player: created.player }, guests };
}

test('only the host can start a round, and it locks the room', () => {
  const { store, room, guests } = setup(['A']);

  const denied = store.startRound(guests[0]!.conn);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, 'NOT_HOST');
  assert.equal(room.phase, 'LOBBY');

  assert.ok(store.startRound(room.players.get(room.bySession.get('sess-host')!)!.conn!).ok);
  assert.equal(room.phase, 'ROUND_ACTIVE');

  const latecomer = store.join(new FakeConn(), room.code, 'Late', 'sess-late');
  assert.equal(latecomer.ok, false);
  if (!latecomer.ok) assert.equal(latecomer.code, 'ROOM_LOCKED');
});

test('roundStart carries the panorama but never the answer', () => {
  const { store, host, guests } = setup(['A']);
  store.startRound(host.conn);

  const start = guests[0]!.conn.lastOfType('roundStart');
  assert.ok(start);
  assert.equal(start.durationMs, ROUND_MS);
  assert.ok(start.panoId);
  // The answer must stay server-side until roundEnd — anything sent is visible in devtools.
  const json = JSON.stringify(start);
  assert.equal(json.includes('lat'), false, 'no coordinates in roundStart');
  assert.equal(json.includes('locationName'), false, 'no place name in roundStart');
});

test('the round ends as soon as every active player has guessed', () => {
  const { store, room, clock, host, guests } = setup(['A', 'B']);
  store.startRound(host.conn);
  assert.equal(clock.pendingCount, 1, 'one room backstop armed');
  assert.equal(clock.lastDelay, 46_000, 'backstop is 40s + 6s headroom');

  store.submitGuess(host.conn, -41.3, 174.8, 5_000);
  assert.equal(room.phase, 'ROUND_ACTIVE', 'still waiting on the others');
  store.submitGuess(guests[0]!.conn, 0, 0, 6_000);
  assert.equal(room.phase, 'ROUND_ACTIVE');

  store.submitGuess(guests[1]!.conn, 10, 10, 7_000);
  assert.equal(room.phase, 'ROUND_RESULTS', 'last guess closes the round immediately');
  assert.equal(clock.pendingCount, 0, 'and cancels the backstop rather than leaking a timer');
});

/** The test §5 explicitly asks for. */
test('a player disconnecting mid-round does not stop the round from ending', () => {
  const { store, room, clock, host, guests } = setup(['A', 'B']);
  store.startRound(host.conn);
  const t0 = Date.now();

  store.disconnect(guests[1]!.conn, t0);
  assert.equal(room.phase, 'ROUND_ACTIVE', 'others still have time to guess');

  store.submitGuess(host.conn, -41.3, 174.8, 1_000, undefined, t0);
  assert.equal(room.phase, 'ROUND_ACTIVE');
  store.submitGuess(guests[0]!.conn, -36.8, 174.7, 2_000, undefined, t0);
  assert.equal(room.phase, 'ROUND_ACTIVE', 'held for the few seconds a blip gets to come back');

  clock.fireLatest();
  assert.equal(room.phase, 'ROUND_RESULTS', 'once that runs out, the remaining two are enough');
  assert.equal(clock.pendingCount, 0, 'the backstop went with it');
  const end = host.conn.lastOfType('roundEnd');
  assert.ok(end);
  const absent = end.results.find((r) => r.playerId === guests[1]!.player.id);
  assert.ok(absent, 'the disconnected player is still listed');
  assert.equal(absent.points, 0, 'and scores 0 for the round');
  assert.equal(absent.guess, null);
});

test('the last active player disconnecting ends the round', () => {
  const { store, room, clock, host, guests } = setup(['A']);
  store.startRound(host.conn);
  const t0 = Date.now();

  store.disconnect(guests[0]!.conn, t0);
  store.disconnect(host.conn, t0);
  assert.equal(room.phase, 'ROUND_ACTIVE', 'a whole room on one WiFi can blip together');
  clock.fireLatest();
  assert.equal(room.phase, 'ROUND_RESULTS', 'no sitting out the backstop on an empty room');
});

test('a player who drops and is straight back is still in the round', () => {
  const { store, room, clock, host, guests } = setup(['A', 'B']);
  store.startRound(host.conn);
  const t0 = Date.now();

  // Screen lock, or a WiFi-to-4G handoff: the socket closes and reconnects a second later.
  store.disconnect(guests[1]!.conn, t0);
  store.submitGuess(host.conn, 0, 0, 1_000, 0, t0 + 500);
  store.submitGuess(guests[0]!.conn, 1, 1, 1_000, 0, t0 + 700);
  assert.equal(room.phase, 'ROUND_ACTIVE', 'the round did not close under them');

  const back = new FakeConn();
  assert.ok(store.join(back, room.code, 'B', 'sess-B', t0 + 1_200).ok);
  clock.fireLatest(); // their grace running out no longer means anything
  assert.equal(room.phase, 'ROUND_ACTIVE', 'still waiting on them now they are back');

  store.submitGuess(back, 2, 2, 3_000, 0, t0 + 2_000);
  assert.equal(room.phase, 'ROUND_RESULTS');
  const theirs = host.conn.lastOfType('roundEnd')!.results.find((r) => r.name === 'B')!;
  assert.deepEqual(theirs.guess, { lat: 2, lng: 2 }, 'and their guess counted');
});

test('a whole room blipping together keeps its round', () => {
  const { store, room, clock, host, guests } = setup(['A']);
  store.startRound(host.conn);
  const t0 = Date.now();

  // The venue WiFi hiccups: every phone drops at once and comes straight back.
  store.disconnect(host.conn, t0);
  store.disconnect(guests[0]!.conn, t0);
  assert.ok(store.join(new FakeConn(), room.code, 'Host', 'sess-host', t0 + 800).ok);
  assert.ok(store.join(new FakeConn(), room.code, 'A', 'sess-A', t0 + 900).ok);
  clock.fireLatest();
  assert.equal(room.phase, 'ROUND_ACTIVE', 'nobody lost the round to the router');
});

test('a socket the heartbeat gave up on gets no grace', () => {
  const { store, room, host, guests } = setup(['A', 'B']);
  store.startRound(host.conn);
  const t0 = Date.now();

  // Silent for ~10s already: waiting a further few seconds would only hold everyone up.
  store.disconnect(guests[1]!.conn, t0, 'timeout');
  store.submitGuess(host.conn, 0, 0, 1_000, 0, t0);
  store.submitGuess(guests[0]!.conn, 1, 1, 1_000, 0, t0);
  assert.equal(room.phase, 'ROUND_RESULTS', 'closes the moment the others have guessed');
});

test('cancelling mid-round clears a pending grace check along with the backstop', () => {
  const { store, clock, host, guests } = setup(['A']);
  store.startRound(host.conn);
  store.disconnect(guests[0]!.conn);
  assert.equal(clock.pendingCount, 2, 'backstop plus the grace check');

  assert.ok(store.cancelGame(host.conn).ok);
  assert.equal(clock.pendingCount, 0, 'neither fires into the lobby');
});

test('a resent guess is acknowledged again, and one from an earlier round is dropped', () => {
  const { store, room, host, guests } = setup(['A']);
  store.startRound(host.conn);

  store.submitGuess(host.conn, -41.3, 174.8, 1_000, 0);
  // The ack was lost with the socket; the client resends after reconnecting.
  store.submitGuess(host.conn, -41.3, 174.8, 1_000, 0);
  assert.equal(host.conn.countOfType('guessAck'), 2, 'every resend hears back');
  assert.equal(host.conn.lastOfType('guessAck')!.roundIndex, 0);

  store.submitGuess(guests[0]!.conn, 0, 0, 1_000, 0);
  assert.equal(room.phase, 'ROUND_RESULTS');
  assert.ok(store.advance(host.conn).ok);
  assert.equal(room.roundIndex, 1);

  // A resend of round 1's guess arriving late, into round 2.
  const stale = store.submitGuess(host.conn, -41.3, 174.8, 1_000, 0);
  assert.ok(stale.ok, 'dropped quietly, not reported as an error');
  assert.equal(room.round!.guesses.size, 0, 'and never scored against the next round');
});

test('the backstop closes a round nobody finishes', () => {
  const { store, room, clock, host } = setup(['A']);
  store.startRound(host.conn);

  clock.fireAll();
  assert.equal(room.phase, 'ROUND_RESULTS');
  const end = host.conn.lastOfType('roundEnd');
  assert.ok(end);
  assert.ok(end.results.every((r) => r.points === 0), 'nobody guessed, nobody scored');
});

test('a duplicate guess is ignored rather than double-counted', () => {
  const { store, room, host, guests } = setup(['A']);
  store.startRound(host.conn);

  store.submitGuess(host.conn, -41.3, 174.8, 1_000);
  // A double-tap on Confirm, or Confirm racing the auto-submit at time-up (§5).
  store.submitGuess(host.conn, 0, 0, 2_000);
  assert.equal(room.phase, 'ROUND_ACTIVE', 'the second guess must not close the round');

  store.submitGuess(guests[0]!.conn, 0, 0, 3_000);
  assert.equal(room.phase, 'ROUND_RESULTS');

  const end = host.conn.lastOfType('roundEnd');
  const mine = end!.results.find((r) => r.playerId === host.player.id);
  assert.equal(mine!.guess!.lat, -41.3, 'the first guess is the one that counts');
});

test('the clock has no bearing on the score', () => {
  const { store, room, host, guests } = setup(['A']);
  store.startRound(host.conn);

  // Both guess the answer itself, so the score is high whichever location was dealt.
  const { lat, lng } = room.round!.location.at;
  store.submitGuess(host.conn, lat, lng, -99_999); // "instant"
  store.submitGuess(guests[0]!.conn, lat, lng, 999_999); // absurdly slow
  const end = host.conn.lastOfType('roundEnd');
  assert.ok(end);

  const fast = end.results.find((r) => r.playerId === host.player.id)!;
  const slow = end.results.find((r) => r.playerId === guests[0]!.player.id)!;
  assert.equal(fast.elapsedMs, 0, 'negative clamps to 0 for display');
  assert.equal(slow.elapsedMs, ROUND_MS, 'absurd clamps to the full round');
  // Identical guesses score identically, so a forged stopwatch buys nothing.
  assert.equal(slow.points, fast.points);
  assert.ok(fast.points > 0);
});

test('the host can cancel a game mid-round, unlocking the room', () => {
  const { store, room, clock, host, guests } = setup(['A']);
  store.startRound(host.conn);
  store.submitGuess(host.conn, -41.3, 174.8, 1_000);
  assert.equal(clock.pendingCount, 1, 'backstop armed');

  const denied = store.cancelGame(guests[0]!.conn);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, 'NOT_HOST');

  assert.ok(store.cancelGame(host.conn).ok);
  assert.equal(room.phase, 'LOBBY');
  assert.equal(room.round, null);
  assert.equal(room.deck.length, ROUNDS_PER_GAME, 'the next game is dealt for the lobby');
  assert.ok([...room.players.values()].every((p) => p.score === 0), 'scores cleared');
  // Leaving this armed would fire into an idle lobby.
  assert.equal(clock.pendingCount, 0, 'the round backstop is cancelled too');

  // Anyone held out by the lock can now join (§4).
  assert.ok(store.join(new FakeConn(), room.code, 'Late', 'sess-late').ok);
  // And a fresh game can start.
  assert.ok(store.startRound(host.conn).ok);
  assert.equal(room.roundIndex, 0);
});

test('cancelling from the podium is refused — that is what Play again is for', () => {
  const { store, room, host, guests } = setup(['A']);
  const nothingToCancel = store.cancelGame(host.conn);
  assert.equal(nothingToCancel.ok, false);
  if (!nothingToCancel.ok) assert.equal(nothingToCancel.code, 'WRONG_PHASE');

  store.startRound(host.conn);
  store.submitGuess(host.conn, 0, 0, 0);
  store.submitGuess(guests[0]!.conn, 1, 1, 0);
  assert.equal(room.phase, 'ROUND_RESULTS');
  assert.ok(store.cancelGame(host.conn).ok, 'but mid-results is fair game');
});

test('a guess with no coordinates is rejected, not scored as 0,0', () => {
  const { store, host } = setup([]);
  store.startRound(host.conn);

  const bad = store.submitGuess(host.conn, Number.NaN, 174.8, 1_000);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'BAD_MESSAGE');
  const worse = store.submitGuess(host.conn, 91, 200, 1_000);
  assert.equal(worse.ok, false);
});

test('scores accumulate across rounds and the game ends after the fifth', () => {
  const { store, room, clock, host, guests } = setup(['A']);
  store.startRound(host.conn);

  for (let round = 0; round < ROUNDS_PER_GAME; round++) {
    assert.equal(room.phase, 'ROUND_ACTIVE', `round ${round + 1} running`);
    assert.equal(room.roundIndex, round);
    // Guess the actual location, so points are close to the maximum.
    const actual = room.round!.location.at;
    store.submitGuess(host.conn, actual.lat, actual.lng, 0);
    store.submitGuess(guests[0]!.conn, -80, 0, ROUND_MS);
    assert.equal(room.phase, 'ROUND_RESULTS');

    const end = host.conn.lastOfType('roundEnd')!;
    assert.equal(end.isFinalRound, round === ROUNDS_PER_GAME - 1);
    assert.ok(store.advance(host.conn).ok);
  }

  assert.equal(room.phase, 'GAME_OVER');
  const over = host.conn.lastOfType('gameEnd');
  assert.ok(over);
  assert.equal(over.leaderboard[0]!.playerId, host.player.id, 'accurate player leads');
  assert.ok(over.leaderboard[0]!.score > over.leaderboard[1]!.score);
  assert.deepEqual(
    over.leaderboard.map((r) => r.rank),
    [1, 2],
  );
  assert.equal(clock.pendingCount, 0, 'no timers left running');

  // Play again: same room, same players, scores cleared (§4).
  assert.ok(store.advance(host.conn).ok);
  assert.equal(room.phase, 'LOBBY');
  assert.ok([...room.players.values()].every((p) => p.score === 0));
  assert.equal(room.players.size, 2, 'same players');
});

test('a game never draws the same location twice', () => {
  const { store, room, host } = setup([]);
  store.startRound(host.conn);
  const seen = new Set<string>();
  for (const location of room.deck) seen.add(location.id);
  assert.equal(seen.size, ROUNDS_PER_GAME);
});

/** Hands out sequentially numbered locations, so a test can tell one deck from the next. */
class CountingSource implements LocationSource {
  private n = 0;
  take(count: number): RoundLocation[] {
    return Array.from({ length: count }, () => {
      const id = `loc-${this.n++}`;
      return { id, name: `Place ${id}`, at: { lat: -41, lng: 174 }, panoId: `PANO_${id}` };
    });
  }
  stats() {
    return { source: 'counting' };
  }
}

/**
 * A pool that starts empty, like the first room after a cold start: `take` refuses, and
 * `deal` resolves only when the test says the refill has finished.
 */
class ColdSource implements LocationSource {
  private readonly inner = new CountingSource();
  private finish: ((deck: RoundLocation[] | null) => void) | null = null;
  take(): null {
    return null;
  }
  deal(): Promise<RoundLocation[] | null> {
    return new Promise((resolve) => {
      this.finish = resolve;
    });
  }
  async refilled(): Promise<void> {
    this.finish?.(this.inner.take(ROUNDS_PER_GAME));
    await new Promise((r) => setImmediate(r));
  }
  async failed(): Promise<void> {
    this.finish?.(null);
    await new Promise((r) => setImmediate(r));
  }
  stats() {
    return { source: 'cold' };
  }
}

test('the deck is dealt when the room is created, and the lobby is sent its panoramas', () => {
  const store = new RoomStore(fakeScheduler().scheduler, new CountingSource());
  const hostConn = new FakeConn();
  const created = store.create(hostConn, 'Host', 'sess-host');
  assert.ok(created.ok);
  const room = created.room;
  assert.equal(room.phase, 'LOBBY');
  assert.equal(room.deck.length, ROUNDS_PER_GAME, 'dealt before anyone presses Start');

  const guest = new FakeConn();
  assert.ok(store.join(guest, room.code, 'A', 'sess-A').ok);
  store.broadcastState(room);
  const state = guest.lastOfType('roomState');
  assert.ok(state);
  assert.deepEqual(
    state.panoIds,
    room.deck.map((l) => l.panoId),
    'a joining player gets every panorama, in round order',
  );
  // Preloading must not become a way to read the answers ahead of time (§3).
  const json = JSON.stringify(state);
  assert.equal(json.includes('Place loc-'), false, 'no place names');
  assert.equal(json.includes('"lat"'), false, 'no coordinates');
});

test('Start plays the deck the lobby preloaded, in the order it was sent', () => {
  const store = new RoomStore(fakeScheduler().scheduler, new CountingSource());
  const hostConn = new FakeConn();
  const created = store.create(hostConn, 'Host', 'sess-host');
  assert.ok(created.ok);
  const room = created.room;
  store.broadcastState(room);
  const sent = hostConn.lastOfType('roomState')!.panoIds;

  assert.ok(store.startRound(hostConn).ok);
  for (let round = 0; round < ROUNDS_PER_GAME; round++) {
    assert.equal(hostConn.lastOfType('roundStart')!.panoId, sent[round], `round ${round + 1}`);
    store.submitGuess(hostConn, 0, 0, 0);
    store.advance(hostConn);
  }
  assert.equal(room.phase, 'GAME_OVER');
});

test('play again and cancel each deal a fresh deck into the lobby', () => {
  const store = new RoomStore(fakeScheduler().scheduler, new CountingSource());
  const hostConn = new FakeConn();
  const created = store.create(hostConn, 'Host', 'sess-host');
  assert.ok(created.ok);
  const room = created.room;
  const ids = () => room.deck.map((l) => l.id);

  const first = ids();
  store.startRound(hostConn);
  for (let round = 0; round < ROUNDS_PER_GAME; round++) {
    store.submitGuess(hostConn, 0, 0, 0);
    store.advance(hostConn);
  }
  assert.equal(room.phase, 'GAME_OVER');
  store.advance(hostConn); // Play again
  assert.equal(room.phase, 'LOBBY');
  const second = ids();
  assert.equal(second.length, ROUNDS_PER_GAME);
  assert.equal(second.some((id) => first.includes(id)), false, 'nothing from the last game');

  store.startRound(hostConn);
  store.cancelGame(hostConn);
  const third = ids();
  assert.equal(third.length, ROUNDS_PER_GAME);
  assert.equal(third.some((id) => second.includes(id)), false, 'nothing from the cancelled game');
  assert.deepEqual(
    hostConn.lastOfType('roomState')!.panoIds,
    room.deck.map((l) => l.panoId),
    'and the lobby is told, so it can start preloading',
  );
});

test('after a cold start, the deck is broadcast to the lobby when the pool fills', async () => {
  const source = new ColdSource();
  const store = new RoomStore(fakeScheduler().scheduler, source);
  const hostConn = new FakeConn();
  const created = store.create(hostConn, 'Host', 'sess-host');
  assert.ok(created.ok);
  const room = created.room;
  assert.equal(room.deck.length, 0, 'nothing to deal yet');

  const tooSoon = store.startRound(hostConn);
  assert.equal(tooSoon.ok, false);
  if (!tooSoon.ok) assert.equal(tooSoon.code, 'LOCATIONS_NOT_READY');

  await source.refilled();
  assert.equal(room.deck.length, ROUNDS_PER_GAME);
  const state = hostConn.lastOfType('roomState');
  assert.equal(state?.panoIds.length, ROUNDS_PER_GAME, 'the lobby is told without anyone asking');
  assert.ok(store.startRound(hostConn).ok);
});

test('a deal that lands after its room has gone is dropped', async () => {
  const source = new ColdSource();
  const store = new RoomStore(fakeScheduler().scheduler, source);
  const hostConn = new FakeConn();
  const created = store.create(hostConn, 'Host', 'sess-host');
  assert.ok(created.ok);
  store.leave(hostConn);
  const before = hostConn.sent.length;

  await source.refilled();
  assert.equal(created.room.deck.length, 0);
  assert.equal(hostConn.sent.length, before, 'nothing sent to a closed room');
});

test('a failed deal leaves the lobby able to try again at Start', async () => {
  const source = new ColdSource();
  const store = new RoomStore(fakeScheduler().scheduler, source);
  const hostConn = new FakeConn();
  const created = store.create(hostConn, 'Host', 'sess-host');
  assert.ok(created.ok);

  await source.failed();
  assert.equal(created.room.deck.length, 0);
  assert.equal(created.room.dealing, false, 'not stuck waiting on a deal that gave up');
  const start = store.startRound(hostConn);
  assert.equal(start.ok, false);
  if (!start.ok) assert.equal(start.code, 'LOCATIONS_NOT_READY', 'an honest refusal, not a hang');
});

test('only the host can advance, and not from the wrong phase', () => {
  const { store, host, guests } = setup(['A']);

  const tooEarly = store.advance(host.conn);
  assert.equal(tooEarly.ok, false);
  if (!tooEarly.ok) assert.equal(tooEarly.code, 'WRONG_PHASE');

  store.startRound(host.conn);
  store.submitGuess(host.conn, 0, 0, 0);
  store.submitGuess(guests[0]!.conn, 0, 0, 0);

  const denied = store.advance(guests[0]!.conn);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, 'NOT_HOST', 'a hidden button is not authorisation');
});

test('reconnecting mid-round restores the round, mid-results restores the results', () => {
  const { store, room, host, guests } = setup(['A']);
  store.startRound(host.conn);

  store.disconnect(guests[0]!.conn);
  const backMid = new FakeConn();
  assert.ok(store.join(backMid, room.code, 'A', 'sess-A').ok);
  store.broadcastState(room);
  const state = backMid.lastOfType('roomState');
  assert.ok(state?.round, 'dropped straight back into the live round');
  assert.equal(state.round.youGuessed, false);
  assert.ok(state.round.remainingMs > 0 && state.round.remainingMs <= 46_000);
  assert.equal(JSON.stringify(state).includes('locationName'), false, 'still no answer');

  store.submitGuess(backMid, 0, 0, 1_000);
  store.submitGuess(host.conn, 0, 0, 1_000);
  assert.equal(room.phase, 'ROUND_RESULTS');

  store.disconnect(backMid);
  const backResults = new FakeConn();
  const rejoined = store.join(backResults, room.code, 'A', 'sess-A');
  assert.ok(rejoined.ok);
  store.replayPhase(room, rejoined.player);
  assert.ok(backResults.lastOfType('roundEnd'), 'gets the results screen, not a blank one');
});

test('a client that missed roundEnd can recover it by re-joining', () => {
  // The UI is driven by the phase, but drawn from the payload. If a socket misses the
  // roundEnd broadcast, re-sending `join` must hand it back — otherwise the client sits on
  // "Scoring the round" forever.
  const { store, room, host, guests } = setup(['A']);
  store.startRound(host.conn);
  store.submitGuess(host.conn, 0, 0, 100);
  store.submitGuess(guests[0]!.conn, 1, 1, 200);
  assert.equal(room.phase, 'ROUND_RESULTS');

  const fresh = new FakeConn();
  const rejoined = store.join(fresh, room.code, 'A', 'sess-A');
  assert.ok(rejoined.ok);
  assert.equal(fresh.lastOfType('roundEnd'), undefined, 'join alone does not include it');
  store.replayPhase(room, rejoined.player);
  const recovered = fresh.lastOfType('roundEnd');
  assert.ok(recovered, 'replayPhase hands back the results');
  assert.equal(recovered.roundIndex, 0);

  // Same for the podium.
  store.advance(host.conn);
  for (let i = 1; i < 5; i++) {
    store.submitGuess(host.conn, 0, 0, 0);
    store.submitGuess(fresh, 1, 1, 0);
    store.advance(host.conn);
  }
  assert.equal(room.phase, 'GAME_OVER');
  const podiumConn = new FakeConn();
  const backAgain = store.join(podiumConn, room.code, 'A', 'sess-A');
  assert.ok(backAgain.ok);
  store.replayPhase(room, backAgain.player);
  assert.ok(podiumConn.lastOfType('gameEnd'), 'and the podium');
});

test('no score leaks to any client during a round', () => {
  const { store, host, guests } = setup(['A']);
  store.startRound(host.conn);

  store.submitGuess(host.conn, -41.3, 174.8, 1_000);
  assert.equal(host.conn.countOfType('guessAck'), 1);
  assert.equal(host.conn.lastOfType('roundEnd'), undefined, 'no results while the round runs');
  assert.equal(guests[0]!.conn.countOfType('guessAck'), 0, "not told about others' guesses");
});

test('everyone hears how many have guessed, but not who or how well', () => {
  const { store, host, guests } = setup(['A', 'B']);
  store.startRound(host.conn);

  const opening = guests[1]!.conn.lastOfType('roomState')!.round!.progress;
  assert.deepEqual(opening, { guessed: 0, total: 3 }, 'the round starts with the count at zero');

  store.submitGuess(host.conn, -41.3, 174.8, 1_000);
  const heard = guests[1]!.conn.lastOfType('guessProgress');
  assert.ok(heard, 'a player who has not guessed still hears the count move');
  assert.equal(heard.roundIndex, 0);
  assert.deepEqual(heard.progress, { guessed: 1, total: 3 });
  // A count is all it carries: no name, no id, no coordinate, no points (§8).
  const json = JSON.stringify(heard);
  for (const leak of ['Host', host.player.id, 'lat', 'points']) {
    assert.equal(json.includes(leak), false, `no ${leak} in guessProgress`);
  }

  // A double-tap is not a second guess.
  const before = guests[1]!.conn.countOfType('guessProgress');
  store.submitGuess(host.conn, -41.3, 174.8, 1_000);
  assert.equal(guests[1]!.conn.countOfType('guessProgress'), before);

  store.submitGuess(guests[0]!.conn, 0, 0, 2_000);
  assert.deepEqual(guests[1]!.conn.lastOfType('guessProgress')!.progress, { guessed: 2, total: 3 });

  // The last guess ends the round, and the results say the rest.
  store.submitGuess(guests[1]!.conn, 0, 0, 3_000);
  assert.equal(guests[1]!.conn.lastOfType('guessProgress')!.progress.guessed, 2);
});

test('the guessed count stops waiting on a dropped player once their grace runs out', () => {
  const { store, room, clock, host, guests } = setup(['A', 'B']);
  store.startRound(host.conn);
  store.submitGuess(host.conn, -41.3, 174.8, 1_000);

  // Still inside the grace, they count: most drops are back in a second (§5).
  store.disconnect(guests[1]!.conn, Date.now());
  store.broadcastState(room);
  assert.deepEqual(host.conn.lastOfType('roomState')!.round!.progress, { guessed: 1, total: 3 });

  // The grace check never runs early, even fired straight away.
  clock.fireLatest();
  assert.equal(room.phase, 'ROUND_ACTIVE', 'A has not guessed yet');
  assert.deepEqual(host.conn.lastOfType('guessProgress')!.progress, { guessed: 1, total: 2 });
});

test('the podium arrives with its phase, so nobody waits on a resync to see it', () => {
  const { store, room, host, guests } = setup(['A']);
  store.startRound(host.conn);
  for (let round = 0; round < ROUNDS_PER_GAME; round++) {
    store.submitGuess(host.conn, 0, 0, 0);
    store.submitGuess(guests[0]!.conn, 1, 1, 0);
    store.advance(host.conn);
  }
  assert.equal(room.phase, 'GAME_OVER');

  const sent = guests[0]!.conn.sent;
  const gameEnd = sent.findIndex((m) => m.type === 'gameEnd');
  assert.ok(gameEnd >= 0);
  const state = sent.slice(gameEnd).find((m) => m.type === 'roomState');
  assert.equal(state?.type === 'roomState' && state.phase, 'GAME_OVER');
});

test('scoring is distance alone, decaying with distance', () => {
  assert.equal(scoreGuess(0), 5000, 'a perfect guess scores full marks');
  assert.ok(scoreGuess(1000) > 2000, 'the right region still banks a solid score');
  assert.equal(scoreGuess(20_000), 0, 'the far side of the planet scores nothing');
  assert.equal(scoreGuess(-5), 5000, 'a negative distance cannot exceed the maximum');

  let previous = Infinity;
  for (let d = 0; d <= 20_000; d += 250) {
    const value = scoreGuess(d);
    assert.ok(value <= previous, `curve must never reward a worse guess (at ${d}km)`);
    previous = value;
  }
});
