import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOSE_REPLACED, EMPTY_ROOM_TTL_MS, HOST_GRACE_MS, rankByScore } from '@pangoguessr/shared';
import type { ServerMessage } from '@pangoguessr/shared';
import type { LocationSource } from '../src/locationSource';
import { RoomStore, connectedCount, type Conn } from '../src/rooms';

class FakeConn implements Conn {
  readonly sent: ServerMessage[] = [];
  closed = false;
  closeCode: number | undefined;
  send(msg: ServerMessage): void {
    this.sent.push(msg);
  }
  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }
  lastOfType<T extends ServerMessage['type']>(type: T) {
    return [...this.sent].reverse().find((m) => m.type === type);
  }
}

function roomWithHost(store: RoomStore, name = 'Host') {
  const conn = new FakeConn();
  const result = store.create(conn, name, 'session-host');
  assert.ok(result.ok);
  return { conn, room: result.room, player: result.player };
}

test('each player holds their own colour, kept across a reconnect and freed when they leave', () => {
  const store = new RoomStore();
  const { room } = roomWithHost(store);
  const a = new FakeConn();
  const b = new FakeConn();
  const joinedA = store.join(a, room.code, 'A', 'session-a');
  const joinedB = store.join(b, room.code, 'B', 'session-b');
  assert.ok(joinedA.ok && joinedB.ok);

  const colors = () => [...room.players.values()].map((p) => p.color);
  assert.deepEqual(colors(), [0, 1, 2], 'distinct, lowest first');

  store.disconnect(a);
  const back = store.join(new FakeConn(), room.code, 'A', 'session-a');
  assert.ok(back.ok);
  assert.equal(back.player.color, 1, 'a reconnect keeps the colour everyone knows them by');

  store.leave(back.ok ? back.player.conn! : a);
  const newcomer = store.join(new FakeConn(), room.code, 'C', 'session-c');
  assert.ok(newcomer.ok);
  assert.equal(newcomer.player.color, 1, 'a leaver’s colour goes back into use');

  store.broadcastState(room);
  const state = b.lastOfType('roomState');
  assert.ok(state && state.type === 'roomState');
  assert.deepEqual(
    state.players.map((p) => p.color),
    [0, 2, 1],
    'and every phone is told the same colours',
  );
});

test('a phone is ready once it has the first panorama, until a rejoin or a new deck', () => {
  // Every deal distinct, so a fresh deck is sure to start somewhere new.
  let dealt = 0;
  const source: LocationSource = {
    take: (count) =>
      Array.from({ length: count }, () => {
        const n = dealt++;
        return { id: `l${n}`, name: `Place ${n}`, at: { lat: 0, lng: 0 }, panoId: `pano-${n}` };
      }),
    stats: () => ({ source: 'test' }),
  };
  const store = new RoomStore(undefined, source);
  const { conn: hostConn, room } = roomWithHost(store);
  const a = new FakeConn();
  assert.ok(store.join(a, room.code, 'A', 'session-a').ok);
  const first = room.deck[0]!.panoId;

  const ready = () => {
    store.broadcastState(room);
    const state = hostConn.lastOfType('roomState');
    assert.ok(state && state.type === 'roomState');
    return state.players.map((p) => p.ready);
  };
  assert.deepEqual(ready(), [false, false], 'nobody has loaded anything yet');

  assert.equal(store.markPreloaded(a, room.deck[1]!.panoId), undefined, 'a later round is not it');
  assert.equal(store.markPreloaded(a, 'made-up'), undefined, 'nor is anything outside the deck');
  assert.equal(store.markPreloaded(a, first), room, 'the first round is, and wants a broadcast');
  assert.equal(store.markPreloaded(a, first), undefined, 'saying it twice changes nothing');
  assert.deepEqual(ready(), [false, true]);

  store.disconnect(a);
  const back = new FakeConn();
  assert.ok(store.join(back, room.code, 'A', 'session-a').ok);
  assert.deepEqual(ready(), [false, false], 'a rejoin may be a reload that lost it, so it must say again');
  assert.equal(store.markPreloaded(back, first), room);

  // A cancelled game deals a fresh deck, which nobody has loaded yet.
  assert.ok(store.startRound(hostConn).ok);
  assert.ok(store.cancelGame(hostConn).ok);
  assert.notEqual(room.deck[0]!.panoId, first);
  assert.deepEqual(ready(), [false, false], 'a new deck unreadies everyone');
});

test('a reconnect with a known sessionId restores the same slot and score', () => {
  const store = new RoomStore();
  const { room } = roomWithHost(store);

  const first = new FakeConn();
  const joined = store.join(first, room.code, 'Kian', 'session-a');
  assert.ok(joined.ok);
  joined.player.score = 3200;
  const playerId = joined.player.id;

  store.disconnect(first);
  assert.equal(room.players.get(playerId)?.conn, null, 'slot held, socket gone');

  const second = new FakeConn();
  const back = store.join(second, room.code, 'Kian', 'session-a');
  assert.ok(back.ok);
  assert.equal(back.player.id, playerId, 'same player record, not a ghost duplicate');
  assert.equal(back.player.score, 3200, 'score survives the reconnect');
  assert.equal(room.players.size, 2);
});

test('a second tab on the same session takes over, and the first is told why', () => {
  const store = new RoomStore();
  const { room } = roomWithHost(store);

  const firstTab = new FakeConn();
  const joined = store.join(firstTab, room.code, 'Kian', 'session-a');
  assert.ok(joined.ok);

  // The QR scanned twice: the camera app opens a second tab on the same browser storage.
  const secondTab = new FakeConn();
  const again = store.join(secondTab, room.code, 'Kian', 'session-a');
  assert.ok(again.ok);
  assert.equal(again.player.id, joined.player.id, 'still one player');
  assert.equal(joined.player.conn, secondTab, 'the newest socket wins');
  // The close code is what stops the first tab reconnecting and taking the slot straight back.
  assert.equal(firstTab.closeCode, CLOSE_REPLACED);

  // A late close event from the replaced socket must not mark the player disconnected.
  assert.equal(store.disconnect(firstTab), undefined);
  assert.equal(joined.player.conn, secondTab);

  // Re-sending join on the socket you're already on is a resync, not a takeover.
  assert.ok(store.join(secondTab, room.code, 'Kian', 'session-a').ok);
  assert.equal(secondTab.closed, false);
});

test('the name-uniqueness check exempts the reconnecting player themselves', () => {
  const store = new RoomStore();
  const { room } = roomWithHost(store);

  const first = new FakeConn();
  assert.ok(store.join(first, room.code, 'Kian', 'session-a').ok);
  store.disconnect(first);

  // The naive version of this check rejects every reconnect with NAME_TAKEN.
  const second = new FakeConn();
  const back = store.join(second, room.code, 'Kian', 'session-a');
  assert.ok(back.ok, 'reconnecting with your own name must be allowed');
});

test('a different player cannot take a name already in the room', () => {
  const store = new RoomStore();
  const { room } = roomWithHost(store);

  assert.ok(store.join(new FakeConn(), room.code, 'Kian', 'session-a').ok);
  const clash = store.join(new FakeConn(), room.code, 'kian', 'session-b');
  assert.equal(clash.ok, false);
  if (!clash.ok) assert.equal(clash.code, 'NAME_TAKEN');
});

test('the room locks once a game is underway, but reconnects still get through', () => {
  const store = new RoomStore();
  const { room } = roomWithHost(store);

  const early = new FakeConn();
  assert.ok(store.join(early, room.code, 'Kian', 'session-a').ok);
  room.phase = 'ROUND_ACTIVE';

  const latecomer = store.join(new FakeConn(), room.code, 'Sam', 'session-new');
  assert.equal(latecomer.ok, false);
  if (!latecomer.ok) assert.equal(latecomer.code, 'ROOM_LOCKED');

  store.disconnect(early);
  const back = store.join(new FakeConn(), room.code, 'Kian', 'session-a');
  assert.ok(back.ok, 'a known sessionId is restoring a player, not joining');
});

test('the host dropping briefly does not kill the room; passing the grace period does', () => {
  const store = new RoomStore();
  const t0 = 1_000_000;
  const store2 = store; // readability
  const hostConn = new FakeConn();
  const created = store2.create(hostConn, 'Host', 'session-host', t0);
  assert.ok(created.ok);
  const { room } = created;
  const guest = new FakeConn();
  assert.ok(store2.join(guest, room.code, 'Kian', 'session-a', t0).ok);

  store2.disconnect(hostConn, t0);

  assert.deepEqual(store2.sweep(t0 + HOST_GRACE_MS - 1), [], 'inside the grace period');
  assert.equal(store2.roomCount, 1);

  const backHost = store2.join(new FakeConn(), room.code, 'Host', 'session-host', t0 + 1_000);
  assert.ok(backHost.ok);
  assert.equal(backHost.player.isHost, true, 'isHost survives the reconnect');
  assert.deepEqual(store2.sweep(t0 + HOST_GRACE_MS + 1), [], 'reconnect cleared the timer');

  store2.disconnect(backHost.player.conn!, t0 + 2_000);
  const closed = store2.sweep(t0 + 2_000 + HOST_GRACE_MS);
  assert.deepEqual(closed, [{ code: room.code, reason: 'hostLeft' }]);
  assert.equal(store2.roomCount, 0);
  assert.equal(guest.lastOfType('roomClosed')?.type, 'roomClosed');
});

test('the room survives GAME_OVER and is only reaped once empty for long enough', () => {
  const store = new RoomStore();
  const t0 = 5_000_000;
  const hostConn = new FakeConn();
  const created = store.create(hostConn, 'Host', 'session-host', t0);
  assert.ok(created.ok);
  const { room } = created;

  room.phase = 'GAME_OVER';
  assert.deepEqual(store.sweep(t0 + 1_000), [], 'GAME_OVER alone must not drop the room');
  assert.equal(store.roomCount, 1, 'the group can still play again');

  store.disconnect(hostConn, t0);
  assert.equal(connectedCount(room), 0);

  // Host grace fires first here, which is correct — but check the empty-room path directly.
  const store3 = new RoomStore();
  const other = new FakeConn();
  const c2 = store3.create(other, 'Host', 'session-host', t0);
  assert.ok(c2.ok);
  const guest = new FakeConn();
  assert.ok(store3.join(guest, c2.room.code, 'Kian', 'session-a', t0).ok);
  store3.disconnect(guest, t0);
  store3.touch(c2.room, t0);
  assert.deepEqual(store3.sweep(t0 + EMPTY_ROOM_TTL_MS), [], 'host still connected, room lives');
});

test('an explicit leave by the host closes the room immediately', () => {
  const store = new RoomStore();
  const { conn, room } = roomWithHost(store);
  const guest = new FakeConn();
  assert.ok(store.join(guest, room.code, 'Kian', 'session-a').ok);

  store.leave(conn);
  assert.equal(store.roomCount, 0);
  assert.equal(guest.lastOfType('roomClosed')?.type, 'roomClosed');
});

test('a guest leaving removes them outright, unlike a disconnect', () => {
  const store = new RoomStore();
  const { room } = roomWithHost(store);
  const guest = new FakeConn();
  assert.ok(store.join(guest, room.code, 'Kian', 'session-a').ok);

  store.leave(guest);
  assert.equal(room.players.size, 1, 'no held slot for someone who chose to go');

  const rejoin = store.join(new FakeConn(), room.code, 'Kian', 'session-a');
  assert.ok(rejoin.ok, 'and they can come back as a fresh player');
  assert.equal(room.players.size, 2);
});

test('only the host can kick', () => {
  const store = new RoomStore();
  const { conn: hostConn, room } = roomWithHost(store);
  const a = new FakeConn();
  const b = new FakeConn();
  const guestA = store.join(a, room.code, 'A', 'session-a');
  const guestB = store.join(b, room.code, 'B', 'session-b');
  assert.ok(guestA.ok && guestB.ok);

  const denied = store.kick(a, guestB.player.id);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, 'NOT_HOST');

  assert.ok(store.kick(hostConn, guestB.player.id).ok);
  assert.equal(room.players.size, 2);

  // Being removed is not the same event as the room closing, and the player is told which.
  const told = b.lastOfType('roomClosed');
  assert.ok(told && told.type === 'roomClosed');
  assert.equal(told.reason, 'kicked');
});

test('broadcast state never leaks sessionId', () => {
  const store = new RoomStore();
  const { conn, room } = roomWithHost(store);
  assert.ok(store.join(new FakeConn(), room.code, 'Kian', 'session-a').ok);

  store.broadcastState(room);
  const state = conn.lastOfType('roomState');
  assert.ok(state && state.type === 'roomState');
  assert.equal(JSON.stringify(state).includes('session-'), false);
  assert.equal(state.youId, room.bySession.get('session-host'));
});

test('standard competition ranking: ties share a rank and the next rank skips', () => {
  const ranked = rankByScore(
    [
      { name: 'a', score: 100 },
      { name: 'b', score: 300 },
      { name: 'c', score: 300 },
      { name: 'd', score: 200 },
    ],
    (p) => p.score,
  );

  assert.deepEqual(
    ranked.map((r) => [r.entry.name, r.rank]),
    [
      ['b', 1],
      ['c', 1],
      ['d', 3],
      ['a', 4],
    ],
  );
});
