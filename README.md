# Jellyfin Stats

A self-hosted statistics dashboard for Jellyfin. Tracks playback sessions, watch history,
and per-user and per-library statistics, with a live view of active streams.

Jellyfin administrators sign in with their existing Jellyfin credentials.

## Status

Complete: the data pipeline, the HTTP API, and the web UI are all built and packaged into
one process. `docker compose up -d` brings up the whole stack — Postgres (`jfstats-db`)
and the app (`jfstats`), which applies its own schema migrations on boot, then syncs from
Jellyfin on a schedule and serves both the API and the built web UI — from one command;
see [Running the app](#running-the-app) for that flow and for the alternative two-terminal
dev setup.

## Requirements

- Docker and Docker Compose. In production (`docker compose up -d`) this runs everything:
  Postgres and the app, which applies migrations on startup, syncs from Jellyfin, and
  serves the API and the built web UI on one port. That stack pulls a prebuilt image from
  GHCR rather than building from this checkout — see
  [Deploying](#deploying-docker-compose-up--d). For local development,
  `docker-compose.override.yml` builds from your working tree instead, and the Vite dev
  server runs on the host; see [Running the app](#running-the-app).
- Node 22+ and pnpm 10+ — required for local development (see above), and to run the
  one-off `seed`/`backfill` scripts against either setup.
- A Jellyfin server and an API key (Jellyfin: Dashboard → API Keys)

## Setup

```bash
cp .env.example .env
# Fill in JELLYFIN_URL, JELLYFIN_API_KEY, and JFSTATS_DB_PASSWORD.
```

`.env` is gitignored. Never commit real credentials.

### The two compose files

| File                          | Purpose                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `docker-compose.yml`          | The deployment stack — app plus its database, self-contained. This is the one to share. |
| `docker-compose.override.yml` | A development layer merged over it automatically. Delete it if you only want to deploy. |

Compose merges both with no `-f` flags, so `docker compose up -d` in a checkout is a
development run, while the same command with only the first file is a deployment. The
override changes exactly three things: it builds the app from your working tree instead
of pulling the published image, publishes Postgres on `127.0.0.1:15432` so host-side
tooling can reach it, and points the database at a separate development volume so a local
experiment can never touch a deployment's data on the same machine.

That development volume is declared `external`, so create it once:

```bash
docker volume create jfstats-dev-db-data
```

Then bring the stack up:

```bash
pnpm install
docker compose up -d --build
```

**Migrations run automatically at startup** — there is no separate migrate step. The
first time anything connects (the container, the dev server below, `seed`, or `backfill`)
it applies whatever schema migrations haven't run yet and continues.

Port `15432` is loopback only, never the LAN, and is deliberately not `5432` so it cannot
collide with a Postgres already installed on your machine. `DATABASE_URL` in `.env` should
match it; the container ignores that value and builds its own against the service name.

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
back than that — the app was down for over a week, or the database was restored
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
developing against it, and one command for running it like a deployed service. Both
run the exact same `apps/server/src/main.ts` entrypoint — there is only one process to
run; it applies migrations, reconciles sessions left open by an unclean shutdown, starts
the in-process scheduler (session polling, reference syncs, nightly rollup recompute,
session cleanup), and serves the HTTP API, in that order, every time it boots.

### Development (two terminals)

Postgres runs under Docker (`docker compose up -d jfstats-db`, per Setup above); the app
and the web UI's Vite dev server both run on the host, in two separate terminals. Stop the
`jfstats` container first if it is running, or two schedulers will poll the same Jellyfin
server into the same database:

```bash
# terminal 1 — the app: HTTP API + scheduler, listening on PORT (default 3000)
pnpm --filter @jfstats/server dev

# terminal 2 — the Vite dev server (default http://localhost:5173)
pnpm --filter @jfstats/web dev
```

Open the URL Vite prints (normally `http://localhost:5173`), not the app's own
port — Vite's dev server proxies `/api/*` requests to it (see
`apps/web/vite.config.ts`) so the browser stays same-origin and the session cookie
behaves exactly as it does in production. Sign in with a real Jellyfin
administrator account.

The dashboard needs data to be interesting. Either leave terminal 1 running against a
real Jellyfin server — its scheduler polls sessions every `SESSION_POLL_INTERVAL_MS`
(default 5s) on its own, no extra step needed — or run
`pnpm --filter @jfstats/server seed` once instead for 90 days of fake history (see
Setup, above).

### Deploying (`docker compose up -d`)

`docker-compose.yml` is self-contained and portable — it assumes nothing about the machine
it lands on. Copy it and `.env.example` to a server, fill in three values, and start:

```bash
cp .env.example .env
```

```bash
docker compose up -d
```

`JELLYFIN_URL`, `JELLYFIN_API_KEY`, and `JFSTATS_DB_PASSWORD` are the only required
values; every other setting has a working default. Delete `docker-compose.override.yml`
if you copied the whole repository — it is a development layer, and Compose would merge it
automatically and try to build from source.

This runs two services: `jfstats-db` (Postgres 17) and `jfstats` — one process that
applies migrations on boot, then serves the API and the built web UI, so the whole
dashboard is one origin on `http://localhost:3000`. Set `JFSTATS_PORT` if that port is
taken; the container always listens on 3000 internally. There is no separate web server or
build step.

The image is **pulled from GHCR** — `ghcr.io/pandolfom/jellyfin-stats:latest`, published by
`.github/workflows/publish.yml` on every push to `main`. So a deployment tracks `main`, not
your working tree; update with `docker compose pull && docker compose up -d`.

**`JELLYFIN_URL` must be reachable from inside a container.** `http://localhost:8096` never
works — inside a container `localhost` is the container itself, not your host. Use a LAN IP
or a real hostname, or `host.docker.internal` on Docker Desktop (unavailable on plain Linux
Docker Engine without extra configuration). If Jellyfin runs in Docker on the same machine
and you would rather keep the traffic internal than send it out to a reverse proxy and
back, add this app's two services to Jellyfin's own compose file and use the bare service
name `http://jellyfin:8096` — that is how the author's own deployment is set up.

**Run exactly one `jfstats` instance.** It runs the startup migration and the in-process
scheduler, and neither is safe to run twice against the same database: a second scheduler
would double-poll Jellyfin, and two concurrent `migrate()` calls could race the same
schema. The fixed `container_name` and host-port mapping already block
`docker compose up -d --scale jfstats=2` on a single host, but that is incidental, not a
guarantee — it does not hold under Swarm or behind a reverse proxy where two instances
could run without a port clash. Don't scale this service.

**Turn on `COOKIE_SECURE` and `TRUST_PROXY_HEADERS` only behind an HTTPS reverse proxy.** A
`Secure` cookie over plain HTTP is silently dropped by the browser, which looks exactly like
a broken login; trusting `X-Forwarded-For` without a proxy that overwrites it lets any
client forge a fresh rate-limit identity on every request.

**Only the variables named in the `jfstats` service's `environment:` block reach the app.**
There is no `env_file: .env` — Compose reads `.env` solely to expand `${...}` references.
`FALLBACK_ADMIN_USER` and `FALLBACK_ADMIN_PASSWORD` are deliberately not wired up, because
an empty value is not the same as an unset one and an empty one fails validation at
startup; add both to that block by hand if you need the recovery path.

### Confirming the scheduler is actually running

There is deliberately very little in `docker compose logs jfstats` once startup finishes —
by design, a healthy poll cycle logs nothing. After `migrations applied`, `startup
reconciliation complete`, and `listening`, the logs go quiet even while the app is
correctly polling Jellyfin every `SESSION_POLL_INTERVAL_MS` — that quiet is expected,
not a hang. Two ways to actually confirm it's alive:

- **The Live screen** in the web UI shows currently-playing sessions updating in
  real time; if something is actually playing on Jellyfin, watching it move is the
  fastest check.
- **Query `job_runs` directly**, which every job — including `session-poll` — updates
  on every successful run:

  ```bash
  docker compose exec jfstats-db psql -U jfstats -d jfstats \
    -c "select name, last_run_at from job_runs order by name;"
  ```

  Run it twice a few seconds apart; `session-poll`'s `last_run_at` should have moved
  forward by roughly `SESSION_POLL_INTERVAL_MS` each time. A scheduled job only logs on
  _failure_ (`"scheduled job failed"`), so silence in `docker compose logs jfstats` between
  the three startup lines is the healthy case, not a symptom.

## Configuration

| Variable                     | Default                    | Purpose                                                                                                                                                         |
| ---------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JELLYFIN_URL`               | —                          | Base URL of your Jellyfin server (required); must be reachable _from inside a container_ under `docker compose up -d` — see [Running the app](#running-the-app) |
| `JELLYFIN_API_KEY`           | —                          | Jellyfin API key used for syncing (required)                                                                                                                    |
| `DATABASE_URL`               | —                          | Postgres connection string (required)                                                                                                                           |
| `FALLBACK_ADMIN_USER`        | unset                      | Optional emergency admin username; see [Authentication](#authentication)                                                                                        |
| `FALLBACK_ADMIN_PASSWORD`    | unset                      | Optional emergency admin password; both must be set to activate                                                                                                 |
| `SESSION_POLL_INTERVAL_MS`   | `5000`                     | How often active sessions are polled                                                                                                                            |
| `REFERENCE_SYNC_INTERVAL_MS` | `900000`                   | How often users and libraries refresh                                                                                                                           |
| `COMPLETION_THRESHOLD`       | `0.9`                      | Fraction of runtime that counts as watched                                                                                                                      |
| `LOG_LEVEL`                  | `info`                     | `debug`, `info`, `warn`, or `error`                                                                                                                             |
| `PORT`                       | `3000`                     | Port the HTTP API listens on. Host-side only — under compose the container always listens on 3000; use `JFSTATS_PORT` to move the published host port           |
| `JFSTATS_PORT`               | `3000`                     | Compose only: host port the dashboard is published on                                                                                                           |
| `COOKIE_SECURE`              | `false`                    | Marks the session cookie `Secure`; see [Running the API](#running-the-api)                                                                                      |
| `SESSION_TTL_HOURS`          | `168`                      | Session lifetime (sliding); see [Running the API](#running-the-api)                                                                                             |
| `TRUST_PROXY_HEADERS`        | `false`                    | Trust `X-Forwarded-For` for rate limiting; see [Running the API](#running-the-api)                                                                              |
| `TZ`                         | unset (container runs UTC) | IANA timezone (e.g. `America/New_York`) the three nightly maintenance jobs are scheduled against; see the note below                                            |

Under `docker compose up -d`, only the variables named in the `jfstats` service's
`environment:` block are passed to the container — see
[Deploying](#deploying-docker-compose-up--d). The rest of this table applies to the
host-side dev flow, or to compose once you add the variable to that block.

**Nothing sets `TZ` for you.** `item-sync`, `rollup-recompute`, and `session-cleanup` run
at 03:00/03:30/04:00 in whatever timezone the process sees, chosen to land during quiet
viewing hours rather than peak ones (see `apps/server/src/sync/schedule.ts`). Leave `TZ`
unset and that "local time" is UTC — `node:22-alpine` has no other default — so the jobs
land at 03:00/03:30/04:00 UTC, which is peak evening viewing across most of the Americas.
Set `TZ` to your own IANA timezone name to actually get quiet-hours scheduling. It is read
from `.env` on both paths — the compose file passes it through as `${TZ:-UTC}`. (`SESSION_POLL_INTERVAL_MS` and `REFERENCE_SYNC_INTERVAL_MS`,
the two interval-based jobs, are unaffected either way — only the three daily jobs read
local time.)

## API

The HTTP API is a Hono app served by the same process as everything else —
`pnpm --filter @jfstats/server dev` in development, or the `jfstats` service under
`docker compose up -d` in production — listening on `PORT` (default `3000`).

### Authentication

Jellyfin administrators sign in with their existing Jellyfin username and password. The
API never stores the password, and revokes the Jellyfin access token it requests for
the login check immediately after using it, regardless of whether the user turns out to
be an admin. A successful login sets an opaque, httpOnly, `SameSite=Lax` session cookie
(`jfstats_session`); the session record itself lives server-side in Postgres, not in the
cookie.

| Endpoint                | Auth           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/auth/login`  | none           | Body: `{ "username": "...", "password": "..." }`. Rate-limited to 10 attempts per 15 minutes per client (see `TRUST_PROXY_HEADERS` below). On success: `200` with `{ userId, userName, isAdmin: true }`, and the session cookie is set. Otherwise: `400 invalid_request` (malformed body), `401 invalid_credentials`, `403 not_an_administrator` (a valid Jellyfin login that isn't an admin), `429 too_many_attempts`, or `503 jellyfin_unavailable`. |
| `POST /api/auth/logout` | none           | Destroys the session and clears the cookie. Always `200 { ok: true }`, even with no session present.                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/auth/me`      | session cookie | `200` with `{ userId, userName, isAdmin }` if the cookie names a live admin session, else `401 unauthenticated`. Goes through the same admin gate as the data routes below, so it re-checks admin status and refreshes both the session and the cookie — polling it keeps a session alive on both sides, not just server-side.                                                                                                                         |

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

| Endpoint                        | Query parameters                                                                               | Notes                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/stats/overview`       | `from`, `to`                                                                                   | Aggregate totals for the range.                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/stats/series`         | `from`, `to`                                                                                   | Per-day watch-time series for the range.                                                                                                                                                                                                                                                                                                                          |
| `GET /api/stats/top-items`      | `from`, `to`, `limit` (default `10`, max `100`), `libraryId`, `userId`                         | Most-watched items, optionally scoped to a library or a user.                                                                                                                                                                                                                                                                                                     |
| `GET /api/stats/users`          | `from`, `to`                                                                                   | Per-user totals.                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/stats/users/:userId`  | `from`, `to`                                                                                   | One user's detail; `404 { "error": "not_found" }` for an unknown id.                                                                                                                                                                                                                                                                                              |
| `GET /api/stats/libraries`      | `from`, `to`                                                                                   | Per-library totals.                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/history`              | `limit` (default `50`, max `200`), `offset` (default `0`), `userId`, `libraryId`, `from`, `to` | Paginated playback history. Unlike the `/api/stats/*` routes, `from`/`to` here are not defaulted: if neither is given, no date filter is applied at all. Giving one without the other fills in the missing side using the same 30-day default as the stats routes.                                                                                                |
| `GET /api/live`                 | —                                                                                              | Server-Sent Events. Emits a `sessions` event (a JSON array) immediately on connect with whatever is currently playing, then again on every change; sends a heartbeat comment roughly every 25s so idle-timeout proxies don't close the connection.                                                                                                                |
| `GET /api/images/items/:itemId` | `tag`, `maxWidth` (default `400`, max `1000`)                                                  | Proxies one item's poster art from Jellyfin, so the browser needs neither the Jellyfin API key nor direct network access to Jellyfin. `itemId` must be a 32-character hex GUID; anything else answers `400 { "error": "invalid_item_id" }` before any outbound request is made. Responses are cached `private` for 30 days, since they sit behind the admin gate. |

### Running the API

```bash
pnpm --filter @jfstats/server dev
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
  Both the Postgres-backed session and the cookie's `maxAge` are refreshed on every
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
not affect it, and a stalled app cannot inflate it.

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
