import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUNDS_PER_GAME, ROUND_MS, scoreGuess } from '@pangoguessr/shared';
import type { ServerMessage } from '@pangoguessr/shared';
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
  const { store, room, host, guests } = setup(['A', 'B']);
  store.startRound(host.conn);

  store.disconnect(guests[1]!.conn);
  assert.equal(room.phase, 'ROUND_ACTIVE', 'others still have time to guess');

  store.submitGuess(host.conn, -41.3, 174.8, 1_000);
  assert.equal(room.phase, 'ROUND_ACTIVE');
  store.submitGuess(guests[0]!.conn, -36.8, 174.7, 2_000);

  assert.equal(room.phase, 'ROUND_RESULTS', 'the remaining two closing it is enough');
  const end = host.conn.lastOfType('roundEnd');
  assert.ok(end);
  const absent = end.results.find((r) => r.playerId === guests[1]!.player.id);
  assert.ok(absent, 'the disconnected player is still listed');
  assert.equal(absent.points, 0, 'and scores 0 for the round');
  assert.equal(absent.guess, null);
});

test('the last active player disconnecting ends the round', () => {
  const { store, room, host, guests } = setup(['A']);
  store.startRound(host.conn);

  store.disconnect(guests[0]!.conn);
  store.disconnect(host.conn);
  assert.equal(room.phase, 'ROUND_RESULTS', 'no sitting out the backstop on an empty room');
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
  assert.deepEqual(room.deck, []);
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
