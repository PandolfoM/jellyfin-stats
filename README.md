# Jellyfin Stats

A self-hosted statistics dashboard for Jellyfin. Tracks playback sessions, watch history,
and per-user and per-library statistics, with a live view of active streams.

Jellyfin administrators sign in with their existing Jellyfin credentials.

## Status

Plans 1 and 2 of 3 are complete: the data pipeline runs and the HTTP API is live.
The web UI (Plan 3) is not built yet.

## Requirements

- Docker and Docker Compose — **for Postgres and Redis only**. There is no
  production image for this app yet. `docker compose up` starts the two
  datastores and nothing else.
- Node 22+ and pnpm 10+ — required to *run* the app, not just to develop it. Both
  long-running processes (the sync worker and the HTTP API) run on the host under
  `tsx`, started by hand or by whatever supervisor you point at them. There is no
  packaged deployment yet.
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

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `JELLYFIN_URL` | — | Base URL of your Jellyfin server (required) |
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
