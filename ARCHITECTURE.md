# PangoGuessr — Architecture

A GeoGuessr-style party game. Players join a room from their own phones, each sees the
same location, and scores individually on **accuracy + speed**.

Status: design doc, pre-implementation.

---

## 1. Core product decisions

| Decision | Choice |
| --- | --- |
| Play model | **Every player on their own phone.** No shared/TV screen. |
| Rounds per game | **5** |
| Round length | **40 seconds** per player, **46s** room backstop; ends early once all have guessed |
| Scoring | Distance curve, scaled down by time taken |
| Joining | 4-character room code, or QR code encoding the same join URL |
| Room size | Up to **20 players** (~16 typical) |
| Imagery | **Google Maps JS API + Street View** |
| Hosting | Render, single web service |
| Frontend | React + TypeScript (Vite) |

Because there is no shared screen, **every device is a full client**: it renders the
panorama, the guess map, the timer, and the between-round leaderboard. There is no
separate "host view" bundle — the room creator just gets extra controls (start round,
kick, next round) gated by a `isHost` flag on their player record.

---

## 2. Repository layout

```
/client          Vite + React + TypeScript  — the only UI
/server          Express + ws + TypeScript  — game authority, serves client build in prod
/shared          Types + scoring function, imported by both via tsconfig paths
```

One deployable. The server serves `/client/dist` as static files, so client and API
share an origin — no CORS, no cross-site cookie rules, no separate WebSocket host.

In development, Vite runs on 5173 and proxies `/api` and `/ws` to the server on 3000.
Set this up on day one so dev and prod don't diverge.

`shared/` holds the scoring function specifically. The client uses it to preview a
score; the server uses it to decide the real one. Two copies would drift.

---

## 3. Realtime layer

Raw `ws` over a single WebSocket per player. Not Socket.IO — we don't need its fallbacks
or rooms abstraction, and the smaller payload matters on phone networks.

Render's free tier runs a **single instance**, which means no sticky-session problem for
WebSocket connections. If we ever scale past one instance, that assumption breaks and we
need Redis pub/sub (see §9).

### Message protocol (draft)

Client → Server:

```
create          { displayName, sessionId }           // mints a room, caller becomes host
join            { code, displayName, sessionId }
leave           { }
kick            { playerId }                         // host only
startRound      { }                                  // host only
submitGuess     { lat, lng, elapsedMs }              // client-measured, server-clamped
advance         { }                                  // host only — leaves round results
```

Server → Client:

```
roomState       { code, players[], phase, roundIndex, totalRounds }
roundStart      { roundIndex, panoId, durationMs: 40000 }
guessAck        { received: true }                   // no score leaked yet
roundEnd        { actual: {lat,lng}, results[], leaderboard[], isFinalRound }
gameEnd         { leaderboard[] }
roomClosed      { reason }                           // host left, or room reaped (§8)
error           { code, message }
```

Room creation is a WS frame, not an HTTP endpoint, so there is **one transport and one code
path** — and `create` and `join` end in the same place, a `roomState` broadcast.

`roundStart` never includes the answer coordinates — only the panorama ID. Anything
sent to the client is visible in devtools, so the answer stays server-side until
`roundEnd`.

---

## 4. Room phases

```
LOBBY  ──startRound──▶  ROUND_ACTIVE  ──all guessed, else 46s──▶  ROUND_RESULTS
                              ▲                                      │
                              └──────────── advance ─────────────────┤
                                       (rounds remain)               │
                                                                     │
                                        advance on final round ──▶ GAME_OVER ──▶ LOBBY
```

`phase` lives on the room and is included in every `roomState`. A reconnecting player is
dropped straight into the current phase — mid-round they get the panorama with the
remaining time, mid-results they get the results screen.

**The room locks at `startRound`.** New players cannot join once a game is underway; the
join screen tells them a game is in progress and holds them until `GAME_OVER`, at which
point they're admitted to the lobby automatically. This avoids having to decide whether a
latecomer starts on 0 (unwinnable) or on the current average (unfair).

Reconnects are exempt — a known `sessionId` rejoining is restoring an existing player, not
joining, and must always be allowed through the lock (§8).

### ROUND_RESULTS — host-gated

After every round, **all players sit on a results screen until the host presses "Next."**
There is no auto-advance countdown. The whole point is to give the room time to react to
the reveal and argue about it, which is most of the fun of playing in person.

The screen shows the actual location on a map with **every player's guess pin**, each
labelled with their name, plus their distance and points for the round, and the running
leaderboard.

Showing all 16–20 pins is the point — seeing how badly everyone else missed is most of
the entertainment. It does mean the reveal map needs care on a phone: auto-fit bounds to
include the answer and all pins, cluster or shrink labels when pins overlap, and let the
player tap their own pin to highlight it. Make the map the dominant element on this
screen, with the leaderboard scrolling beneath it.

Only the host's client renders the Next button, but **the server must independently
re-check `isHost` on `advance`** — never trust a hidden button as an authorisation
mechanism.

### GAME_OVER — the podium

After the fifth round's results, `advance` goes to `GAME_OVER` rather than another round.

This screen leads with a **podium of the top 3** — 1st centre and tallest, 2nd left, 3rd
right, with final totals. It's the payoff for the whole game and should feel like an
event: animate the reveal 3rd → 2nd → 1st rather than drawing it all at once. Full
standings for everyone else scroll beneath it.

**Always three steps.** No tiebreaks, no variable-height podium logic. Exact ties are
vanishingly unlikely with a continuous distance curve and millisecond timing, so this needs
to be *correct*, not elaborate.

Ranking is **standard competition ranking**, and it is the same function that produces the
leaderboard — sort by total descending, equal totals share a rank, and the next rank skips
by the number tied. The podium renders three fixed steps and places whoever holds rank 1,
2 and 3 on them. Consequences:

- Two players tie for 1st → both stand on step 1, the next player is rank 3 and stands on
  step **3**. Step 2 renders empty.
- Three players tie for 1st → all three on step 1, steps 2 and 3 render empty.
- Fewer than three players → the unused steps render empty.

So a step with nobody on it is a normal state, not a special case.

From here the room returns to `LOBBY` with scores reset, same code and players, so a group
can immediately play again.

### The stall risk — the host leaving drops the room

Host-gating means one person's phone can freeze the room indefinitely: if the host's
battery dies on the results screen, everyone else is stuck staring at it.

**Decided: there is no host promotion. If the host disconnects, the room is dropped.**
Every remaining player gets `roomClosed` and is returned to the join screen; the code is
freed. This applies in every phase, `LOBBY` included — a lobby whose host has gone is
unstartable, so keeping it alive only produces a room nobody can play.

A *transient* drop is not a disconnect. The host locking their phone or losing WiFi for a
few seconds must not nuke the game, so the room is dropped only after the host's socket has
been gone for a **grace period of ~30 seconds** with no `sessionId` reconnect. A host who
reconnects inside that window resumes with `isHost` intact — `isHost` lives on the player
record, which is keyed by `sessionId` (§8), so this falls out of the normal reconnect path.

This is blunt, and deliberately so: it costs the group a rematch in a rare case, and it
removes host promotion, orphaned-room cleanup and a results-screen auto-advance backstop
from the design entirely. If it proves annoying in practice, host promotion on disconnect
is the upgrade path.

## 5. The 40-second round

**Each player's 40 seconds starts when their own panorama finishes rendering.**

This is the fairness fix. A player on slow 4G may not see the image for 3–4 seconds after
the server broadcasts. Timing from the broadcast would cost them ~10% of the round, and
because speed is a multiplier (§6), it would penalise them twice. With 20 phones all
pulling panorama tiles simultaneously, this is most rounds, not an edge case.

So timing is **client-measured**:

- The client starts a local stopwatch on the Street View viewer's `pano_changed` /
  first-tile-rendered event — not on message receipt.
- `submitGuess` carries `{ lat, lng, elapsedMs }`.
- The server **clamps `elapsedMs` to 0–40000** and computes distance and score from it.

### Placing a guess

The player taps the map to place a pin, may move it freely, and presses **Confirm** to
commit. A committed guess is final — there is no un-confirming.

**If the local 40s expires with a pin placed but unconfirmed, the client submits it
anyway.** Nobody loses a round to a missed button press. Two things fall out of this:

- The auto-submit races a last-instant Confirm tap, so the "ignore all but the first
  `submitGuess`" rule below is what keeps the guessed-count honest. It is not optional.
- **No pin placed at all still scores 0.** Auto-submit needs something to submit.

The auto-submit fires at the player's local 40s, which lands before the 46s room backstop
for anyone whose panorama loaded inside the 6s headroom — and is moot for anyone whose
didn't, since the room closes the round under them either way.

### Scoring stays on the server

Timing moves to the client; scoring does not. To compute a score the client would need
the *actual coordinates*, which means broadcasting the answer to 20 phones before guesses
are locked. Anyone could read it in devtools. In a room of 20 people playing a guessing
game, someone will do this as a joke.

The split keeps that closed. The worst a client can fake is its own stopwatch — capped at
a 40% swing by the speed multiplier — instead of knowing the answer outright.

### The room clock is still server-owned

Per-player timing does not mean per-player round length. The server runs one authoritative
**46s** `setTimeout` (40s + **6s** load headroom) as a backstop, so one player who never
finishes loading can't stall the rest.

The consequence: a player whose panorama took longer than 6s to load has their personal
40s clipped by the room timer. Accepted — 6s covers realistic load times, and the
alternative is letting one bad connection hold up the room.

### Ending early

**The round ends the moment every active player has guessed** — the room does not sit on
a dead timer. In practice this is how most rounds will end, and the 46s backstop only
fires when someone is idle, disconnected, or stuck.

On each `submitGuess`, the server checks whether all active players have now guessed; if
so it cancels the pending timeout and transitions to `ROUND_RESULTS` immediately.

"Active" excludes **disconnected players** — a phone that dropped mid-round must not hold
the room hostage for the full 46s. It also excludes players who already **timed out with
no guess**. Getting this predicate wrong is the likeliest cause of a round that mysteriously
refuses to end, so it's worth a unit test: disconnect one of three players mid-round and
assert the round closes when the remaining two have guessed.

### Edge cases this must handle

- **Late guess.** Accept guesses until the room timer fires; clamp `elapsedMs` to 40000.
- **Panorama never loads.** Client falls back to starting its stopwatch on message
  receipt after a ~6s timeout, so a broken viewer doesn't mean an infinite stopwatch.
- **Missing or absurd `elapsedMs`.** Treat as 40000 (worst case, still scored on
  accuracy) rather than rejecting the guess.
- **No guess.** Score 0 for the round. Do not stall the room.
- **Player disconnects mid-round.** Drop them from the "active" set so the early-end
  check can still be satisfied by everyone else.
- **Last active player disconnects before guessing.** End the round rather than waiting
  out the backstop on an empty room.
- **Duplicate `submitGuess`.** Ignore all but the first — a double-tap must not corrupt
  the guessed-count that the early-end check depends on.
- **Host disconnects.** After a ~30s grace period the room is dropped and everyone gets
  `roomClosed`, in this and every other phase. See §4.
- **Player's own timer runs out before the room's.** Accepted jank: a player whose
  panorama loaded slowly watches the round end with time still on their personal clock.
  The UI does not try to hide or reconcile this.

---

## 6. Scoring

```ts
// shared/scoring.ts
const MAX_KM  = 20000;   // ~antipodal — accuracy floors at zero here
const NEAR_KM = 0.5;     // below this, treat as a bullseye

export function scoreGuess(distanceKm: number, elapsedMs: number): number {
  const d = Math.max(distanceKm, 0);
  const decay = Math.log10(1 + d / NEAR_KM) / Math.log10(1 + MAX_KM / NEAR_KM);
  const accuracy = 5000 * Math.max(0, 1 - decay);
  const t = Math.min(Math.max(elapsedMs, 0) / 40000, 1);   // clamped: client-reported
  return Math.round(accuracy * (1 - 0.4 * t));
}
```

Runs on the server only. `elapsedMs` arrives from the client (§5) and is clamped here, so
the clamp cannot be bypassed by any caller. The client may import this to *preview* a
score, but never to decide one — it doesn't have the actual coordinates to pass in.

### Why log distance and not the GeoGuessr curve

The obvious formula is GeoGuessr's own, `5000 * exp(-10d / 14916)`. It was rejected because
it measures error as a **fraction of the planet**, which makes every city-sized miss
identical: a 1 km guess scores 4997 and a 10 km guess 4967. Local precision — actually
reading the signs and finding the street — is worth 5 points out of 5000. Raising the
exponent punishes mid-range misses harder but doesn't fix that flatness, because the
flatness is the shape, not the constant.

Log distance is **scale-free**: every halving of the error is worth the same amount,
whether you're 4000 km out or 400 m out.

| Miss | Accuracy | Reads as |
| --- | --- | --- |
| 0.5 km | 4673 | nailed the street |
| 5 km | 3868 | right suburb |
| 50 km | 2823 | right city |
| 500 km | 1740 | right region |
| 2000 km | 1087 | right continent, wrong country |
| 10000 km | 327 | wrong hemisphere |

Two knobs. **`NEAR_KM`** sets how much a pinpoint guess earns over a merely-close one —
lower rewards precision more. **`MAX_KM`** sets where hopeless guesses floor out; drop it
to ~8000 if a wrong-hemisphere guess should be worth nothing. It's deliberately left
generous at long range: with 5 rounds, zeroing people out early kills the podium.

Note this is *less* punishing than the exponential at long range and *far* more
discriminating up close, which is the intended trade.

### Speed

Speed is **multiplicative, on a floor** — an instant guess keeps 100% of its accuracy
score, a guess at the 40s buzzer keeps 60%.

This is deliberate. An *additive* speed bonus would let a player fire off a fast garbage
guess and out-earn someone slow and accurate, which feels awful to play. Multiplicative
means speed only ever amplifies accuracy you already earned.

The `0.4` is the main tuning knob. Raise it to make the game more frantic.

**Ties are allowed.** No tiebreak on the final leaderboard — equal totals share a rank and
are displayed as such. With a continuous distance curve and millisecond timing, exact ties
are vanishingly rare anyway; not having a rule is simpler than having one.

---

## 7. Imagery — Google Street View

**Decided.** Google Maps JS API + Street View panorama.

Mapillary was rejected: its crowd-sourced coverage clusters heavily in northern Europe,
so random coordinate sampling would sample *contributor density* rather than the world,
and the optimal strategy would collapse to "guess Germany."

### Cost model

Google removed the $200 monthly credit in March 2025. The current free allowance is
roughly 10k dynamic panorama loads/month, then ~$14/1k.

**Each player device loading a panorama bills as one load** — 16 players all viewing the
same `panoId` is 16 loads, not 1.

At the expected average of **16 players × 5 rounds = 80 loads per game**:

| Avg players | Loads/game | Free games/month |
| --- | --- | --- |
| 12 | 60 | ~166 |
| 16 | 80 | **125** |
| 20 (cap) | 100 | ~100 |

Expected usage is ~20 games/month, so roughly **6× headroom**. Allow ~10% for reconnects
re-loading the panorama mid-round — call it ~110 real games. Cost is a non-issue; a
billing account is still required to be on file.

### Billing guard

Normal play uses ~16% of the allowance and will never threaten it. **The risk is a bug**,
not volume — a render loop remounting the viewer, or a reconnect storm re-initialising it,
can burn thousands of loads in an afternoon with no visible symptom. The game keeps
working; only the bill changes.

Three layers, outermost first:

**1. A hard quota cap in Google Cloud Console.** This is the only real stop. Set a daily
per-API limit on Street View dynamic panorama requests to **300/day** — roughly 4 games,
comfortably above any real session, and it keeps even a runaway loop inside the monthly
free allowance. Budget *alerts* do not stop spend; they email after the fact. Set both,
but the quota is what actually saves you.

**2. Budget alerts** at $5 and $20 as a backstop for anything the quota doesn't cover.

**3. App-level discipline**, which is what stops it happening at all:

- **Mount the panorama exactly once per round.** Create the `StreetViewPanorama` in an
  effect keyed on `roundIndex` alone. If it's keyed on anything that changes during the
  round — timer state, player list, room state — every tick re-initialises the viewer and
  bills again.
- **React StrictMode double-mounts effects in development.** This silently doubles every
  panorama load while you're building. Either use a mount guard (ref) or disable
  StrictMode while working on the viewer. Easy to burn hundreds of loads on this without
  noticing.
- **Reconnecting to the same `panoId` must reuse the existing viewer**, not build a new
  one. Reconnects are the expected case on phones, not an edge case.
- **Never render the panorama outside `ROUND_ACTIVE`.** Unmount it on `ROUND_RESULTS` so
  a stuck results screen isn't holding a live viewer.

**Instrument it.** Have the server log a counter of rounds started per room and expose a
running monthly total at `/api/health`. Loads should track at roughly
`rounds × players`. If the ratio drifts above that, something is re-initialising — and
you'll see it in a log line rather than a month-end invoice.

### Location sampling: manually defined zones

Locations are **not** sampled uniformly from the whole world. Coverage-weighted random
lands overwhelmingly on featureless roads in the US, Russia, Australia and Brazil — most
rounds end up looking alike, with few clues to read.

Instead, zones are defined by hand in a config file:

```ts
// server/zones.ts
type Zone = {
  id: string;
  name: string;
  weight: number;                             // relative pick frequency
  bbox: [south: number, west: number, north: number, east: number];
};

export const ZONES: Zone[] = [
  // home advantage — everyone should recognise a few of these
  { id: 'nz',     name: 'New Zealand',      weight: 4, bbox: [-46.7, 166.4, -34.4, 178.6] },
  { id: 'au-e',   name: 'Australia (east)', weight: 3, bbox: [-38.5, 141.0, -25.0, 153.6] },

  // distinctive signage / architecture / driving side
  { id: 'jp',     name: 'Japan',            weight: 3, bbox: [ 31.0, 130.0,  45.5, 145.8] },
  { id: 'uk-ie',  name: 'UK & Ireland',     weight: 3, bbox: [ 50.0, -10.5,  58.7,   1.8] },
  { id: 'it',     name: 'Italy',            weight: 2, bbox: [ 36.6,   6.6,  47.1,  18.5] },
  { id: 'es-pt',  name: 'Iberia',           weight: 2, bbox: [ 36.0,  -9.5,  43.8,   3.3] },
  { id: 'alps',   name: 'Alps',             weight: 2, bbox: [ 45.8,   5.9,  49.0,  17.2] },
  { id: 'nordic', name: 'Norway & Sweden',  weight: 2, bbox: [ 57.0,   4.5,  71.2,  31.0] },
  { id: 'is',     name: 'Iceland',          weight: 1, bbox: [ 63.2, -24.6,  66.6, -13.5] },

  // wider world — keeps the map honest
  { id: 'us-w',   name: 'US (west)',        weight: 3, bbox: [ 32.5,-124.4,  49.0,-110.0] },
  { id: 'br-se',  name: 'Brazil (SE)',      weight: 2, bbox: [-25.5, -51.0, -19.5, -39.5] },
  { id: 'za',     name: 'South Africa',     weight: 2, bbox: [-34.9,  17.0, -22.1,  32.9] },
  { id: 'th',     name: 'Thailand',         weight: 2, bbox: [  5.6,  97.3,  20.5, 105.6] },
  { id: 'cl',     name: 'Chile',            weight: 1, bbox: [-42.0, -75.0, -30.0, -69.8] },
];
```

Starter set of 14, chosen for **variety of visual cues** rather than even geographic
coverage: mixed driving sides, distinct road markings and sign shapes, and vegetation
ranging from Icelandic tundra to Thai jungle. New Zealand is weighted highest so there are
recognisable home rounds. All have solid Street View coverage.

These are a starting point — expect to tune weights after playing a few games.

Selection per round:

1. Weighted-random pick of a zone.
2. Uniform-random lat/lng inside its bbox.
3. Metadata lookup **with `radius: 5000`** — this asks for the nearest panorama within
   5km rather than an exact hit, which raises the success rate enormously. Without a
   radius, a random point almost never lands exactly on a road.
4. On miss, retry from step 2. After ~15 misses, fall back to a different zone.

**Why bboxes and not polygons:** a rectangle over New Zealand includes a lot of ocean,
and ocean simply fails the metadata check and retries. Since metadata calls are free,
retrying is cheaper than maintaining country border geometry. Only worth revisiting if a
zone is so ocean-heavy that retries get slow.

Keep zones **small and distinctive**. "Europe" as one bbox reproduces the original
problem at smaller scale; a dozen country-sized zones with weights you tune by taste is
what makes rounds feel varied and deliberately chosen.

This config also gives themed games later — a `zoneSet` per room ("World", "Europe
only", "Asia") is just a filter over the same list.

### Admin zone editor

A desktop-only screen at `/admin` for drawing zones on a map instead of hand-typing
bounding boxes. Genuinely worth building — typing bbox coordinates by hand is tedious and
error-prone, and the whole quality of the game lives in this list.

**The screen:** a full-page Leaflet map with a rectangle-draw tool (`leaflet-draw`).
Draw a box, name it, set a weight. Existing zones render as editable rectangles. Two
things make it actually useful rather than just a drawing tool:

- **"Test this zone"** — runs the §7 sampling loop against the drawn box and drops pins
  where it found panoramas, with thumbnails. Instantly shows whether a zone is mostly
  ocean, mostly motorway, or good. This is the feature that makes the editor worth having.
- **Hit-rate estimate** — sample 20 points, report how many found coverage. A zone under
  ~30% will be slow to draw from and should be tightened.

#### Persistence — the wrinkle

Zones are the **first piece of state that must outlive a server restart**, which breaks the
"no database, everything in memory" assumption in §8. And Render's free tier has an
**ephemeral filesystem** — anything written to disk is wiped on every redeploy and every
spin-down. So writing `zones.json` server-side does not work on free tier.

Options considered:

| Approach | Verdict |
| --- | --- |
| Write `zones.json` on the server | **Broken on Render free** — wiped on redeploy/spin-down |
| Render persistent disk | Paid add-on; overkill for one config file |
| Hosted Postgres (Neon/Supabase free tier) | Works, but a whole database dependency for one array |
| **Export from the editor, commit to repo** | **Chosen** |

**Chosen: the editor is a generator, not a live store.** `/admin` loads the current
`ZONES` array, lets you draw and test, then produces updated JSON to download or copy.
You commit it to `server/zones.ts` and Render redeploys.

This costs one commit per change and gains a lot: zero infrastructure, zero cost, zones
versioned in git with the rest of the config, and no new failure mode at game time.
Zones change rarely — this is a config-authoring tool, not a runtime feature.

If zone editing ever needs to happen live, the upgrade path is a hosted Postgres and a
cache in memory, but there is no reason to pay that cost now.

#### Access

`/admin` sits behind a single shared password in a Render env var, checked server-side
before the route serves anything. Not real auth, but it stops the URL being found by
someone in the room mid-game. The editor calls the metadata API for its testing feature,
which is free, so an exposed editor is an annoyance rather than a bill.

Build this **after** step 3 — hand-write the starter 14 zones above to get playing, then
build the editor when tuning them becomes the bottleneck.

### Pre-warm a location pool

Metadata retries take real time — a handful of round-trips before a hit is normal. Doing
that at `startRound` means players stare at a blank screen.

So the server keeps a **pool of ~20 pre-validated `panoId`s**, refilled in the background
between rounds. `startRound` pops from the pool and broadcasts immediately. Metadata calls
are free, so over-fetching costs nothing but time the server has spare.

### One panorama for everyone

Because the server resolves the `panoId` before broadcasting, **all players are guaranteed
the same panorama** — no per-client coordinate resolution, no drift where two people see
different images of the same "location."

### Key handling

- **Browser key** — restricted by HTTP referrer to the `.onrender.com` domain. Used only
  for the panorama viewer. This one is public by nature; the referrer restriction is what
  protects it.
- **Server key** — unrestricted, kept in Render env vars, used for metadata calls. Never
  reaches the client.

### Panorama interaction: pannable, not movable

Players **can** drag to look around the full 360° sphere. Players **cannot** move to
adjacent panoramas — navigation arrows and double-click-to-move are disabled
(`linksControl: false`, `clickToGo: false`).

This is a cost decision as much as a gameplay one. Panning is free — it's the same sphere
already downloaded, so it stays at one load per player per round. **Movement bills a new
load for every step.** A player taking 10 steps costs 11 loads; 20 players doing that is
~220 loads for a single round, against a budget of 100 loads for an entire game. Enabling
movement would multiply usage by roughly 10–20× and blow through the free allowance.

Panning is also what makes the game *playable* — spotting a sign at the edge of frame and
turning to read it is the core skill. A frozen still would be much harder and less fun.
Movement, separately, really wants 90+ second rounds to be worth having.

### Guess map (independent of the above)

**Leaflet + OpenStreetMap tiles.** Free, and no reason to pay Google on both halves of
the screen. Phone-sized: the map should be a tap-to-expand overlay, not a permanent
split view.

---

## 8. State & persistence

In-memory `Map<roomCode, Room>` on the server. **No database for v1.** A party room lives
15 minutes; nobody wants their scores from last Tuesday.

### Room lifecycle

A room is **not** destroyed at `GAME_OVER` — that's the moment a group most wants to play
again, and making them re-scan a new QR code is the worst possible time to add friction. The
podium's "Play again" returns to `LOBBY` with the same code and players (§4).

Rooms die three ways:

- **The host disconnects** for longer than the grace period (§4). Immediate.
- **No connected players for ~10 minutes.** Covers the ordinary case: everyone closed the
  tab and went to lunch.
- **~2 hours idle regardless.** A backstop against a room somehow held open forever.

A reaper on a periodic sweep is enough; this doesn't need to be precise. Without it,
abandoned rooms accumulate as "live" forever and slowly poison the room-code collision
check below.

### Session identity

Each player gets a `sessionId` (UUID) stored in `localStorage` and sent on `join`. If a
phone locks its screen, backgrounds Safari, or drops WiFi, reconnecting with the same
`sessionId` restores that player into their existing slot with their score intact.

This is the single most common way phone-based party games break — an unidentified
reconnect creates a ghost duplicate player and the original's points vanish. Build it
into `join` from the very first version rather than retrofitting.

### Room codes

4 characters from a Crockford-style alphabet with `0 O 1 I L U` removed — people read
these aloud across a room. ~30 usable characters gives ~800k combinations, far more than
enough for the handful of rooms ever live at once. Collision-check against live rooms on
generation anyway.

### Implications of 20 players

Small enough that the architecture doesn't change, but three things need attention:

- **Broadcast fan-out.** Every guess touches 20 sockets. Don't broadcast per-guess score
  updates — send only `guessAck` (a boolean) during the round, and one `roundEnd` payload
  with all results. Live score leakage would also spoil the round.
- **Leaderboard on a phone screen.** 20 rows doesn't fit. Between rounds, show the
  player's own rank and delta prominently with the top 3, and make the full table a
  scroll/expand. Only the final results screen needs all 20 at once.
- **Display names.** With 20 people, collisions are likely and confusing. Enforce
  uniqueness within a room at `join` time rather than allowing duplicates. **The check must
  exempt the player's own existing record** — a reconnect is a `join` carrying the same
  `sessionId` and the same name, so a naive uniqueness check rejects every reconnect with
  "name taken." Compare against other players only.

Memory is a non-issue — 20 WebSocket connections and one room object sit comfortably
inside Render's 512MB free tier.

---

## 9. Deployment (Render)

Single Web Service, Node runtime.

- Build: `npm run build` (builds client, then server)
- Start: `node server/dist/index.js`
- Server serves `client/dist` statically and handles the WS upgrade on the same port.

### Known constraint: cold starts

Render free services spin down after ~15 minutes idle and take 30–60s to wake. That
cold start lands exactly when someone is trying to start a party.

**Decided: stay on free.** So the cold start must be handled in the UI rather than paid
away — the join screen shows an explicit "waking the server up, ~30 seconds" state rather
than a dead spinner or a timeout error. Without that, the first person to scan the QR
sees a broken app and tells everyone it doesn't work.

Worth knowing: the *host* creating the room absorbs the cold start, so by the time the QR
is up and people are scanning, the service is usually already awake.

Upgrading to a $7/mo Starter instance later removes this entirely, and is the obvious move
if the cold start proves annoying in practice.

### Scaling past one instance

Would require Redis for shared room state *and* pub/sub to fan messages across
instances. Explicitly out of scope for v1 — the single-instance assumption is load-bearing
for the current design.

---

## 10. Build order

1. **Lobby only.** Create/join room, QR + code, player list syncing over WS, reconnect
   via `sessionId`. No game at all.
2. **Round loop** with a hardcoded list of ~20 hand-picked coordinates. Full
   guess → 40s timer → host-gated results → next round cycle.
3. **Random coordinates** with metadata validation (§7).
4. **Polish.** Timer UI, reveal map with all pins, top-3 podium, kick/leave.
5. **Admin zone editor** (§7) — once hand-tuning the starter zones becomes the bottleneck.

Set the quota cap and budget alerts (§7) **before** step 3 — that's the first step that
loads a panorama from real code rather than a fixed list, and the first that can loop.

Getting the lobby and reconnect solid *before* touching imagery is deliberate. That's
where the real bugs are, and debugging socket lifecycle and map SDKs simultaneously is
miserable.

---

## 11. Open questions

### Non-blocking — can be decided during build

1. **Zone weights.** The starter 14 in §7 are a guess. Pure tuning — play a few games and
   adjust. Never really "answered."
2. **Scoring knobs.** `NEAR_KM` and `MAX_KM` (§6) are tuning, same as zone weights.

### Resolved

- [x] ~~Imagery provider~~ — **Google Street View**, §7
- [x] ~~Room size cap~~ — **20 players**
- [x] ~~Round advance~~ — **host-gated, no auto-advance**, §4
- [x] ~~When does the 40s start?~~ — **on each client's own panorama render**, §5
- [x] ~~Load headroom~~ — **6s (46s backstop)**, §5
- [x] ~~Rounds per game~~ — **5**, §1
- [x] ~~Pannable vs frozen~~ — **pannable, movement disabled**, §7
- [x] ~~Location sampling~~ — **hand-defined weighted zones**, §7
- [x] ~~Mid-game joins~~ — **blocked**, §4
- [x] ~~Leaderboard ties~~ — **allowed, no tiebreak**, §6
- [x] ~~Reveal map pins~~ — **all players' pins shown**, §4
- [x] ~~Hosting tier~~ — **Render free**, §9
- [x] ~~Billing account~~ — **available**, §7
- [x] ~~Final screen~~ — **top-3 podium over full standings**, §4
- [x] ~~Post-game flow~~ — **back to `LOBBY`, same room, scores reset**, §4
- [x] ~~Zone authoring~~ — **`/admin` editor that exports JSON to commit**, §7
- [x] ~~Host disconnects~~ — **room is dropped after a ~30s grace period; no host
  promotion**, §4
- [x] ~~Distance curve~~ — **log distance, not GeoGuessr's exponential**, §6
- [x] ~~Podium ties~~ — **standard competition ranking, empty steps render empty**, §4
- [x] ~~Committing a guess~~ — **pin then Confirm; unconfirmed pin auto-submits at
  time-up**, §5
- [x] ~~Room lifetime~~ — **survives `GAME_OVER`; reaped on host loss, 10min empty, or
  2h idle**, §8
- [x] ~~Reconnect vs name uniqueness~~ — **uniqueness check exempts the player's own
  record**, §8
- [x] ~~Personal timer clipped by room timer~~ — **accepted jank, not reconciled in UI**, §5
- [x] ~~Room creation transport~~ — **a `create` frame over WS, not an HTTP endpoint**, §3

---

## 12. Assumptions

Things this design takes as true without having been told. Each one is a place the
architecture would need revisiting if it turns out to be wrong.

**Product**

- Players are in the same physical room, talking to each other. This is why results are
  host-gated rather than timed, and why a 4-character spoken code is useful at all. If
  it's ever played remotely, the whole pacing model changes.
- The host is a player, not a dedicated operator — they need to be able to guess *and*
  drive the room.
- Games are casual and short (~10 minutes). Nobody expects accounts, history, stats, or
  rematching against past scores.
- World-wide locations only. No country/region/themed map modes.

**Technical**

- **In-flight games do not survive a server restart.** A Render redeploy, crash, or
  free-tier spin-down destroys all room state and every player is dropped. Acceptable at
  this scale; the fix is Redis and it's out of scope.
- One instance is enough (§3, §9). Load-bearing for the no-Redis decision.
- Distance is great-circle (haversine), not driving distance.
- Everyone has a modern mobile browser with WebSocket and WebGL support. Portrait
  orientation is the design target.
- **Players won't forge their own stopwatch.** §5 trades a small cheat surface for
  fairness on slow connections. A player editing `elapsedMs` to 0 gains at most a 40%
  multiplier on accuracy they still had to earn. Accepted for a party game among people
  in the same room; it would not be acceptable for anything ranked or public.
- No authentication. Anyone with the room code can join — including someone who guesses
  a code. At 4 characters and a handful of live rooms that's a non-issue, and the stakes
  are a party game.
- `sessionId` in `localStorage` is the only identity. Clearing browser data or switching
  device mid-game means becoming a new player and losing accumulated score.
- Server clock is monotonic enough over a 40s window for `Date.now()` deltas to be
  trustworthy.

**Cost**

- ~20 games/month averaging 16 players (§7). The free allowance absorbs roughly 6× that,
  but the assumption is worth re-checking if the game gets popular in the office.
