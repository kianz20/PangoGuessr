# PangoGuessr

A GeoGuessr-style party game for a room full of phones. See [ARCHITECTURE.md](ARCHITECTURE.md)
for the design and the reasoning behind it — this file is just how to run it.

**Status:** steps 1–5 of the build order (§10). Playable end to end: lobby → 5 rounds →
host-gated results → podium → play again, with reconnect at every phase.

Imagery is **key-gated**. With `GOOGLE_MAPS_*` keys set you get real Street View sampled from
the weighted zones in [server/src/zones.ts](server/src/zones.ts); without them the game falls
back to the fixed list in [server/src/locations.ts](server/src/locations.ts) and a placeholder
viewer, so it stays fully runnable and testable with no billing account attached.

## Enabling Street View

**Set the quota cap before the first real panorama load, not after.** Normal play uses ~16% of
the free allowance and will never threaten it — the risk is a bug (a remount loop, a reconnect
storm) burning thousands of loads with no visible symptom (§7).

1. Google Cloud Console → new project → **enable billing** (required even on free usage).
2. **APIs & Services → Enable**: *Maps JavaScript API* and *Street View Static API* (the
   latter is what serves metadata).
3. **Quotas — cap the right API.** Panorama loads bill through the *Maps JavaScript API*
   (as "Dynamic Street View"); the *Street View Static API* only serves metadata, which is
   [free of charge](https://developers.google.com/maps/documentation/streetview/metadata) but
   still consumes a daily quota.
   - **Maps JavaScript API → Quotas** → set the per-day limit to **300**. Roughly 4 games,
     comfortably above any real session, and it keeps even a runaway loop inside the monthly
     free allowance. This is the only thing that actually stops spend — budget alerts just
     email you afterwards.
   - **Street View Static API → "Metadata requests per day"** → raise to **10,000**. Sampling
     spends these freely; capping them low starves the location pool and the game fails with
     `OVER_QUERY_LIMIT` while costing you nothing.
4. **Billing → Budgets & alerts**: alerts at **$5** and **$20**.
5. **Credentials → two API keys**:
   - *Browser key* — restrict by **HTTP referrer** to your Render domain (and
     `http://localhost:5173/*` for local work). Restrict to Maps JavaScript API.
   - *Server key* — no referrer restriction, restricted to Street View Static API.
6. Locally: `cp .env.example .env` and fill both in. On Render: add
   `GOOGLE_MAPS_SERVER_KEY` and `GOOGLE_MAPS_BROWSER_KEY` as environment variables.

Check it took effect at `/api/health` — `locations.source` flips from `fixed` to `streetview`,
and `usage.estimatedPanoramaLoads` should track at roughly `rounds × players`. If that ratio
drifts upward, something is re-initialising the viewer.

## Running it

```bash
npm install
npm run dev          # server on :3000, client on :5173
```

Open http://localhost:5173. Vite proxies `/api` and `/ws` to the server, matching
production, where the server serves the client build from one origin.

To try it on your phone, run Vite with `--host` and hit your machine's LAN address — the
QR code encodes whatever origin the page is served from.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Server + client with hot reload |
| `npm run build` | Client bundle, then server bundle |
| `npm start` | Runs the built server (`NODE_ENV=production` to serve the client) |
| `npm run typecheck` | `tsc --noEmit` across all three workspaces |
| `npm test` | Unit tests (server + shared logic) |
| `npm run check:imagery` | Samples every zone and reports hit rates (free metadata calls) |

## Deploying to Render

[render.yaml](render.yaml) is a blueprint, so Render reads the build and start commands from
the repo rather than you typing them into a form. It needs a git remote Render can see:

```bash
git init && git add -A && git commit -m "PangoGuessr: lobby"
gh repo create PangoGuessr --private --source=. --push
```

Then in Render: **New → Blueprint**, pick the repo, apply. First build takes 2–3 minutes,
and you get `https://pangoguessr.onrender.com` (or whatever name is free).

Three things the blueprint handles that are easy to get wrong by hand:

- **`NODE_ENV=production` is required** or the server won't serve `client/dist` at all — you
  get a working API and a blank page.
- **`npm install --include=dev`** is required *because* of that: Render applies env vars to
  the build too, and npm skips devDependencies under `NODE_ENV=production`. That's where
  vite and esbuild live, so a plain `npm install` fails the build.
- **Nothing to configure for WebSockets.** Same port, same origin, single instance (§3).

Expect a 30–60s cold start after ~15 minutes idle (§9). That's accepted, and the join
screen has an explicit "waking the server up" state for it. Worth knowing the host absorbs
it: by the time the QR is up, the service is awake.

## Place names on the reveal

The reveal names the nearest settlement ("Wellington, New Zealand", or "25 km from Alexandra,
New Zealand" out in the country), resolved from a GeoNames extract committed at
`server/data/places.tsv.gz` — no API, no key, no quota. To refresh the data:

```bash
node server/scripts/build-cities.mjs
```

That downloads GeoNames' cities1000 plus the country and region tables, trims them, and rewrites
the gzipped file. Data © [GeoNames](https://www.geonames.org/), CC BY 4.0 — the reveal screen
carries the attribution.

## The zone editor

`/admin`, behind a single shared password. Set `ADMIN_PASSWORD` to enable it; leave it unset
and the endpoints return 503. Shift-drag the map to draw a zone, name it, set its weight, and
**Test this zone** samples it and reports a hit rate — under ~30% means mostly ocean.

Whether an edit outlives a restart depends on what's configured:

| Configured | Saving from `/admin` |
| --- | --- |
| `ZONES_KV_URL` + `ZONES_KV_TOKEN` | permanent — used by every game from then on |
| neither | applies now, lost on restart; the screen hands you JSON for `ZONES_JSON` |

Any Redis-compatible HTTP KV works (Upstash's free tier, for instance): create a database,
copy its REST URL and token. It stores one key holding one JSON array. The screen always
shows which mode it's in, so a change can't silently fail to stick.

## Testing

```bash
npm test        # 64 unit tests: rooms, rounds, scoring, distance, sampling, zones, place names
npm run smoke   # 63 end-to-end checks over real WebSockets; needs a server running
node server/test/smoke-game.mjs 3200       # ...or a single suite against another port
```

The round tests inject a fake scheduler, so the 46-second backstop fires instantly instead
of the suite taking a minute per round.

In development, `GET /api/health` includes a `detail` block listing every room, phase and
player — the fastest way to see what the server actually thinks. It's suppressed in
production.

**Two traps when testing on real phones**, both of which cost time to rediscover:

- Two tabs in one browser profile share `localStorage`, so they share one `sessionId` — the
  server correctly treats the second as a *reconnect* and drops the first. You can't fake
  two players with two tabs; use a private window, another browser, or a real phone.
- `http://<lan-ip>:5173` is **not a secure context**, so `crypto.randomUUID`, geolocation
  and clipboard APIs are unavailable there while working fine on localhost and on Render's
  HTTPS. Anything relying on them needs a fallback, or you'll only see the failure on a
  phone.

## Layout

```
client/   Vite + React + TypeScript — the only UI
server/   Express + ws — game authority, serves the client build in prod
shared/   Types, scoring, ranking, room-code alphabet — imported by both
```

`shared/` is a workspace package (`@pangoguessr/shared`) consumed as TypeScript source, so
there's no build step and no chance of the client and server disagreeing about scoring.
