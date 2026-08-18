# Jellyfin Stats

A self-hosted statistics dashboard for Jellyfin. Tracks playback sessions, watch history,
and per-user and per-library statistics, with a live view of active streams.

Jellyfin administrators sign in with their existing Jellyfin credentials.

## Status

All three plans are complete: the data pipeline runs, the HTTP API is live, and the
web UI is built and packaged. `docker compose up -d` brings up the whole stack —
Postgres, Redis, the sync worker, and the API serving the built dashboard — from one
command; see [Running the app](#running-the-app) for that flow and for the
alternative two-terminal dev setup.

## Requirements

- Docker and Docker Compose. In production (`docker compose up -d`) this runs
  everything: Postgres, Redis, the sync worker, and the API, which also serves the
  built web UI on one port. For local development, Docker is needed only for
  Postgres and Redis — the worker, API, and Vite dev server run on the host instead;
  see [Running the app](#running-the-app).
- Node 22+ and pnpm 10+ — required for local development (see above), and to run
  the one-off `migrate:push`/`seed`/`backfill` scripts against either setup.
- A Jellyfin server and an API key (Jellyfin: Dashboard → API Keys)

## Setup

```bash
cp .env.example .env
# Fill in JELLYFIN_URL, JELLYFIN_API_KEY, and POSTGRES_PASSWORD.
```

`.env` is gitignored. Never commit real credentials.

```bash
pnpm install
docker compose up -d
pnpm --filter @jfstats/db migrate:push
pnpm --filter @jfstats/server dev:worker
```

Compose publishes Postgres and Redis on their conventional host ports
(`5432`/`6379`). `POSTGRES_PORT`/`REDIS_PORT` control only what Docker
publishes on the host — set one when something on your machine already
occupies the conventional port. Everything that connects to Postgres or
Redis (`dev:worker`, `migrate:push`, `seed`) runs on the host, outside
Docker, and never reads `POSTGRES_PORT`/`REDIS_PORT` — it connects only
through `DATABASE_URL`/`REDIS_URL`. So the port inside those URLs must be
changed to match, in the same edit, or the app keeps trying the old port
and fails to connect. For example, if `6379` is already taken:

```bash
# .env
REDIS_PORT=16379
REDIS_URL=redis://localhost:16379
```

To populate the database with 90 days of fake history instead of a live server:

```bash
pnpm --filter @jfstats/server seed
```

The seed script is idempotent, and re-running it is safe. What it does, in order:

1. Deletes the `seed-`-prefixed sessions and `seed-user-`-prefixed rollup rows it
   previously wrote. This part is scoped strictly to its own rows and cannot match
   data synced from a real Jellyfin server.
2. Upserts its fake users, libraries, items, and sessions.
3. **Rebuilds every daily rollup for the last 93 days from `playback_sessions`** —
   not only its own. This runs the same `recomputeRollupRange` the nightly job uses,
   which deletes all `playback_rollup_daily` rows in that window and rebuilds them
   from the underlying sessions. Real rollup rows in that window are therefore
   rewritten, not preserved.

Step 3 is non-destructive in effect — the rebuild is derived from `playback_sessions`,
which the seed never deletes from except for its own rows, so real rollups come back
with the same numbers. But it does rewrite real rows, and it is a full delete-and-
rebuild while it runs. Point the seed at a development database, not one holding
history you care about.

### Repairing rollups over an arbitrary range

The nightly job only rebuilds the trailing 7 days. If rollups have drifted further
back than that — the worker was down for over a week, or the database was restored
from an older dump — rebuild an explicit range from `playback_sessions`:

```bash
pnpm --filter @jfstats/server backfill --from 2026-08-10 --to 2026-08-17
```

Both dates are `YYYY-MM-DD` and are interpreted as UTC day starts. The range covers
whole UTC days and `--to` is inclusive: `--from 2026-08-10 --to 2026-08-17` rebuilds
all 8 named days, and passing the same date for both rebuilds exactly that one day.
(The underlying `recomputeRollupRange` takes a half-open `[from, to)` range, so the
script advances the parsed `--to` by one UTC day before calling it.) This touches
only `playback_rollup_daily` and reads `playback_sessions`, so unlike the seed it adds
no fake data.

## Running the app

Two ways to run the whole stack, covering the same code: a two-terminal setup for
developing against it, and one command for running it like a deployed service.

### Development (two terminals)

Postgres and Redis run under Docker (`docker compose up -d`, per Setup above); the
API and the web UI's Vite dev server both run on the host, in two separate
terminals:

```bash
# terminal 1 — the HTTP API, listening on PORT (default 3000)
pnpm --filter @jfstats/server dev:api

# terminal 2 — the Vite dev server (default http://localhost:5173)
pnpm --filter @jfstats/web dev
```

Open the URL Vite prints (normally `http://localhost:5173`), not the API's own
port — Vite's dev server proxies `/api/*` requests to the API (see
`apps/web/vite.config.ts`) so the browser stays same-origin and the session cookie
behaves exactly as it does in production. Sign in with a real Jellyfin
administrator account.

The dashboard needs data to be interesting. Either run
`pnpm --filter @jfstats/server dev:worker` in a third terminal to sync a real
Jellyfin server, or skip that and run `pnpm --filter @jfstats/server seed` once
for 90 days of fake history instead (see Setup, above).

### Production (`docker compose up -d`)

```bash
cp .env.example .env
# Fill in JELLYFIN_URL, JELLYFIN_API_KEY, and POSTGRES_PASSWORD.
docker compose up -d
```

This builds and runs everything from the one `Dockerfile`: Postgres, Redis, a
one-shot `migrate` service that applies schema migrations and exits, the sync
worker, and the API — which also serves the built web UI, so the whole dashboard
is one origin, `http://localhost:3000` by default (`PORT` in `.env` changes it;
`docker-compose.yml` publishes whatever `PORT` is set to). There is no separate
web server or build step to run by hand; `docker compose build` produces the SPA
as part of the API image.

**`JELLYFIN_URL` must be reachable from inside a container, not just from your
host.** A common setup runs Jellyfin on the same machine as this stack, with
`.env` pointing `JELLYFIN_URL` at something like `http://localhost:8096` — that
works for the host-side dev flow above, but breaks under `docker compose up -d`:
inside a container, `localhost` means the container itself, not the host machine,
so the worker and API can never reach Jellyfin. Unlike `DATABASE_URL`/`REDIS_URL`
(which `docker-compose.yml` already repoints at the `postgres`/`redis` services on
the compose network), `docker-compose.yml` cannot fix this one for you, because
Jellyfin is not a compose service it manages. Point `JELLYFIN_URL` at something a
container can actually reach: your machine's LAN IP or a real hostname, or
`host.docker.internal` if you're on Docker Desktop (Docker Desktop resolves it to
the host automatically; it is not available on plain Linux Docker Engine without
extra configuration).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `JELLYFIN_URL` | — | Base URL of your Jellyfin server (required); must be reachable *from inside a container* under `docker compose up -d` — see [Running the app](#running-the-app) |
| `JELLYFIN_API_KEY` | — | Jellyfin API key used for syncing (required) |
| `DATABASE_URL` | — | Postgres connection string (required) |
| `REDIS_URL` | — | Redis connection string (required) |
| `FALLBACK_ADMIN_USER` | unset | Optional emergency admin username; see [Authentication](#authentication) |
| `FALLBACK_ADMIN_PASSWORD` | unset | Optional emergency admin password; both must be set to activate |
| `SESSION_POLL_INTERVAL_MS` | `5000` | How often active sessions are polled |
| `REFERENCE_SYNC_INTERVAL_MS` | `900000` | How often users and libraries refresh |
| `COMPLETION_THRESHOLD` | `0.9` | Fraction of runtime that counts as watched |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `PORT` | `3000` | Port the HTTP API listens on |
| `COOKIE_SECURE` | `false` | Marks the session cookie `Secure`; see [Running the API](#running-the-api) |
| `SESSION_TTL_HOURS` | `168` | Session lifetime (sliding); see [Running the API](#running-the-api) |
| `TRUST_PROXY_HEADERS` | `false` | Trust `X-Forwarded-For` for rate limiting; see [Running the API](#running-the-api) |
| `POSTGRES_PORT` | `5432` | Host port docker-compose publishes Postgres on |
| `REDIS_PORT` | `6379` | Host port docker-compose publishes Redis on |

## API

The HTTP API is a Hono app served by `pnpm --filter @jfstats/server dev:api` (script:
`tsx --env-file=../../.env src/api.ts`), listening on `PORT` (default `3000`). It is a
separate long-running process from the worker — `dev:worker` and `dev:api` both run on
the host and neither depends on the other being up.

### Authentication

Jellyfin administrators sign in with their existing Jellyfin username and password. The
API never stores the password, and revokes the Jellyfin access token it requests for
the login check immediately after using it, regardless of whether the user turns out to
be an admin. A successful login sets an opaque, httpOnly, `SameSite=Lax` session cookie
(`jfstats_session`); the session record itself lives server-side in Redis, not in the
cookie.

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/auth/login` | none | Body: `{ "username": "...", "password": "..." }`. Rate-limited to 10 attempts per 15 minutes per client (see `TRUST_PROXY_HEADERS` below). On success: `200` with `{ userId, userName, isAdmin: true }`, and the session cookie is set. Otherwise: `400 invalid_request` (malformed body), `401 invalid_credentials`, `403 not_an_administrator` (a valid Jellyfin login that isn't an admin), `429 too_many_attempts`, or `503 jellyfin_unavailable`. |
| `POST /api/auth/logout` | none | Destroys the session and clears the cookie. Always `200 { ok: true }`, even with no session present. |
| `GET /api/auth/me` | session cookie | `200` with `{ userId, userName, isAdmin }` if the cookie names a live admin session, else `401 unauthenticated`. Goes through the same admin gate as the data routes below, so it re-checks admin status and refreshes both the session and the cookie — polling it keeps a session alive on both sides, not just server-side. |

An optional emergency fallback admin (`FALLBACK_ADMIN_USER` / `FALLBACK_ADMIN_PASSWORD`,
both required together to activate, and commented out in `.env.example`) is checked
before Jellyfin, so it still works when Jellyfin itself is unreachable. Leave both unset
— the shipped default — to disable it. When set, it is a standing username/password on
your dashboard that does not expire with a Jellyfin account, so use a long random
password and remove it once you no longer need the recovery path.

### Statistics, history, live feed, and images

Every route below requires a valid admin session — the cookie set by
`/api/auth/login`. Without one, each answers `401 { "error": "unauthenticated" }`
before any query parameter is even parsed. `GET /api/health` is the only endpoint in
the whole API that does not require a session; it always answers `200 { status: "ok" }`,
for use as a liveness check.

`from`/`to` below are `YYYY-MM-DD` UTC calendar days. On the `/api/stats/*` routes,
omitting either (or both) defaults to the trailing 30 days ending today (UTC). An
unparsable or out-of-order range answers `400 { "error": "invalid_range" }`, as does a
range spanning more than 1000 days — the day-by-day series is built from a
`generate_series` spine, so an unbounded span turns one request into millions of rows.

| Endpoint | Query parameters | Notes |
|---|---|---|
| `GET /api/stats/overview` | `from`, `to` | Aggregate totals for the range. |
| `GET /api/stats/series` | `from`, `to` | Per-day watch-time series for the range. |
| `GET /api/stats/top-items` | `from`, `to`, `limit` (default `10`, max `100`), `libraryId`, `userId` | Most-watched items, optionally scoped to a library or a user. |
| `GET /api/stats/users` | `from`, `to` | Per-user totals. |
| `GET /api/stats/users/:userId` | `from`, `to` | One user's detail; `404 { "error": "not_found" }` for an unknown id. |
| `GET /api/stats/libraries` | `from`, `to` | Per-library totals. |
| `GET /api/history` | `limit` (default `50`, max `200`), `offset` (default `0`), `userId`, `libraryId`, `from`, `to` | Paginated playback history. Unlike the `/api/stats/*` routes, `from`/`to` here are not defaulted: if neither is given, no date filter is applied at all. Giving one without the other fills in the missing side using the same 30-day default as the stats routes. |
| `GET /api/live` | — | Server-Sent Events. Emits a `sessions` event (a JSON array) immediately on connect with whatever is currently playing, then again on every change; sends a heartbeat comment roughly every 25s so idle-timeout proxies don't close the connection. |
| `GET /api/images/items/:itemId` | `tag`, `maxWidth` (default `400`, max `1000`) | Proxies one item's poster art from Jellyfin, so the browser needs neither the Jellyfin API key nor direct network access to Jellyfin. `itemId` must be a 32-character hex GUID; anything else answers `400 { "error": "invalid_item_id" }` before any outbound request is made. Responses are cached `private` for 30 days, since they sit behind the admin gate. |

### Running the API

```bash
pnpm --filter @jfstats/server dev:api
```

Two configuration decisions are worth understanding before deploying:

- **`COOKIE_SECURE`** (default `false`) marks the session cookie `Secure`. Turn it on
  once the API is served over HTTPS. Leaving it on while still serving over plain HTTP
  doesn't raise an error — the browser silently drops a `Secure` cookie sent over an
  insecure connection, which looks like a login that succeeds (the `200` response comes
  back fine) and then is immediately logged out, because the cookie was never actually
  stored.
- **`TRUST_PROXY_HEADERS`** (default `false`) controls whether the login rate limiter
  keys attempts by the `X-Forwarded-For` header instead of the raw TCP connection.
  Enable it **only** when a reverse proxy you control sits in front of the API and sets
  that header itself. Enabling it without a real proxy in front lets any client set its
  own `X-Forwarded-For` on every request and mint a fresh rate-limit identity each time,
  defeating login throttling entirely. Leaving it off behind a proxy is safer but
  coarser: every request then arrives from the proxy's own address, so all clients
  behind it share a single rate-limit bucket.
- **`SESSION_TTL_HOURS`** (default `168`, i.e. 7 days) is the sliding session lifetime.
  Both the Redis-backed session and the cookie's `maxAge` are refreshed on every
  authenticated request, so an admin actively using the dashboard is not logged out
  mid-session.

## Development

```bash
pnpm test        # full suite; Docker must be running for integration tests
pnpm typecheck   # workspace-wide
```

### End-to-end tests

`e2e/smoke.spec.ts` (Playwright) drives a real browser against a running stack at
`http://localhost:3000` — start it first with `docker compose up -d`, or point
`E2E_BASE_URL` at wherever it's actually running. The browser binary is a separate,
one-time download:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

Most of the suite needs no credentials at all: it covers the anonymous redirect to
`/login`, the login screen rendering, an anonymous deep link also landing on
`/login` instead of 404ing, and a deliberately wrong username/password showing the
invalid-credentials message.

The one test that actually signs in — verifying a successful login reaches the
dashboard with real data, a deep link survives a page reload, and logout returns to
`/login` — needs a real Jellyfin administrator account. Set both:

```bash
E2E_JELLYFIN_USER=youradmin E2E_JELLYFIN_PASSWORD=yourpassword pnpm test:e2e
```

Neither variable is stored anywhere by this repo — they're read from the
environment for the one login request and nothing else. **Without both set, that
one test reports as `skipped`, not passing and not failing** — check the test
output for that distinction rather than assuming a green run exercised it.

## How watch time is measured

Watch time is accumulated from wall-clock intervals between polls, counted only while a
stream is unpaused, and each increment is capped at 1.5× the poll interval. Seeking does
not affect it, and a stalled worker cannot inflate it.

Daily totals live in `playback_rollup_daily`, written incrementally as sessions progress
and end. A nightly job rebuilds the trailing 7 whole UTC days from `playback_sessions` to
correct any drift, so the two paths always agree — including for sessions that cross
midnight, which are attributed entirely to the day the stream started.

Agreement rests on both paths applying the same two rules:

- **A play is counted once, when the session ends.** A stream still running is not yet a
  play, in either path. Sessions closed by startup reconciliation count too — that is
  still a session ending.
- **Watch time accrues as it is observed**, so a session that is still open already
  contributes the time it has accumulated so far.
