# Jellyfin Stats

A self-hosted statistics dashboard for Jellyfin. Tracks playback sessions, watch history,
and per-user and per-library statistics, with a live view of active streams.

Jellyfin administrators sign in with their existing Jellyfin credentials.

## Status

Plan 1 of 3 is complete: the data pipeline runs. The HTTP API (Plan 2) and web UI
(Plan 3) are not built yet.

## Requirements

- Docker and Docker Compose
- Node 22+ and pnpm 10+ for development
- A Jellyfin server and an API key (Jellyfin: Dashboard → API Keys)

## Setup

```bash
cp .env.example .env
# Fill in JELLYFIN_URL, JELLYFIN_API_KEY, POSTGRES_PASSWORD, and SESSION_SECRET.
# Generate a secret with: openssl rand -hex 32
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
whole UTC days; passing the same date for both rebuilds exactly that day. This touches
only `playback_rollup_daily` and reads `playback_sessions`, so unlike the seed it adds
no fake data.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `JELLYFIN_URL` | — | Base URL of your Jellyfin server (required) |
| `JELLYFIN_API_KEY` | — | Jellyfin API key used for syncing (required) |
| `DATABASE_URL` | — | Postgres connection string (required) |
| `REDIS_URL` | — | Redis connection string (required) |
| `SESSION_SECRET` | — | 32+ characters, used in Plan 2 (required) |
| `SESSION_POLL_INTERVAL_MS` | `5000` | How often active sessions are polled |
| `REFERENCE_SYNC_INTERVAL_MS` | `900000` | How often users and libraries refresh |
| `COMPLETION_THRESHOLD` | `0.9` | Fraction of runtime that counts as watched |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `PORT` | `3000` | Reserved for the HTTP API (Plan 2); unused so far |
| `POSTGRES_PORT` | `5432` | Host port docker-compose publishes Postgres on |
| `REDIS_PORT` | `6379` | Host port docker-compose publishes Redis on |

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
