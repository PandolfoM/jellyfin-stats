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
(`5432`/`6379`). If something on your machine already uses one of those ports,
override `POSTGRES_PORT` and/or `REDIS_PORT` in `.env` before running
`docker compose up -d` — the container's internal port is unaffected, so
`DATABASE_URL`/`REDIS_URL` only need updating if you also changed the host
you connect from.

To populate the database with 90 days of fake history instead of a live server:

```bash
pnpm --filter @jfstats/server seed
```

The seed script is idempotent: it deletes only the `seed-`-prefixed rows it
previously wrote before inserting a fresh batch, so re-running it is safe and
it never touches data synced from a real Jellyfin server.

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
and end. A nightly job rebuilds the trailing days from `playback_sessions` to correct any
drift, so the two paths always agree — including for sessions that cross midnight, which
are attributed entirely to the day the stream started.
