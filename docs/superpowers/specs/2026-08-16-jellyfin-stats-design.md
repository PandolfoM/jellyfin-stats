# Jellyfin Stats — Design

**Date:** 2026-08-16
**Status:** Approved

A Jellyfin statistics dashboard, rebuilt from scratch in the spirit of
[Jellystat](https://github.com/CyferShepard/Jellystat) on a typed, fast stack. Deploys with
`docker compose up -d`. Jellyfin administrators sign in with their Jellyfin credentials.

## Goals

Four drivers, all weighted equally:

1. **Fast** — dashboards must not scan the raw event table.
2. **Modern UI** — clean and spacious, not a dated admin theme.
3. **Ownable** — types end to end, clear module boundaries, real tests.
4. **Reliable sync** — no missed sessions, no double counting, no drift from Jellyfin.

## Scope

**In scope (v1):**

- Playback session capture from the live Jellyfin API
- Live "now playing" view
- Watch history with filtering
- Per-user statistics
- Per-library statistics
- Most-watched items
- Activity timeline / trends
- Jellyfin-backed authentication, admin accounts only

**Explicitly out of scope for v1:**

- Backup/restore of the stats database
- Import from the Jellyfin Playback Reporting plugin (dashboard starts empty and fills forward)
- Multi-server support
- Client IP geolocation (MaxMind)
- Emby compatibility

Out-of-scope items must not shape the v1 schema or architecture beyond what costs nothing.
The one concession: `playback_sessions` retains `remote_endpoint`, so geolocation remains
possible later without backfill.

## Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node 22 LTS | Stable; BullMQ and Drizzle are well-exercised on it |
| API | Hono | Very fast router; its RPC client gives the SPA end-to-end types with no codegen |
| Jobs | BullMQ (Redis-backed) | Repeatable jobs, distributed locks, retries with backoff |
| DB | PostgreSQL 17 + Drizzle ORM | SQL-first; migrations are readable files; query plans stay visible |
| Cache/bus | Redis 7 | Live-session snapshots, pub/sub fan-out, sessions, rate limiting |
| UI | Vite + React 19, TanStack Router + Query, Tailwind v4, shadcn/ui, Recharts | Fast dev loop; a clean component base without hand-rolling a design system |
| Tests | Vitest, testcontainers, Playwright | Unit / integration / one smoke test |

Rejected alternatives: **Next.js** (the background poller doesn't fit a request-scoped
runtime, so a separate worker process is needed anyway — the weight without the benefit);
**Go** (fastest raw throughput and a great poller, but two languages and OpenAPI codegen to
keep types in sync, which taxes goal 3 — and at this scale the bottleneck is Postgres query
design and Jellyfin API latency, not the HTTP layer).

## Architecture

A pnpm monorepo. The API and worker are one codebase with two entrypoints, built into **one
Docker image**, run as two compose services with different commands. They share domain code
and models with no duplication, while a hung Jellyfin poll cannot stall a dashboard request.

```
apps/
  server/          # src/api.ts (Hono) + src/worker.ts (BullMQ); shared domain code
  web/             # Vite React SPA
packages/
  db/              # Drizzle schema, migrations, client
  jellyfin/        # Typed Jellyfin API client
  shared/          # Zod schemas and constants used by both sides
docker-compose.yml
```

`apps/web` imports the Hono `AppType` from `apps/server`. That is what buys end-to-end type
safety with no generation step: change a route's response shape and the UI fails to compile.

**Compose services:** `app` (Hono; also serves the built SPA as static files — one exposed
port, no CORS, no nginx), `worker`, `postgres:17-alpine`, `redis:7-alpine`. Health checks
with `depends_on: condition: service_healthy`; named volumes for Postgres and Redis.
Migrations run automatically on `app` boot.

### Module boundaries

- `packages/jellyfin` — the only code that knows Jellyfin's HTTP shape. Returns validated
  domain types. Swappable and mockable.
- `packages/db` — the only code that writes SQL. Exposes repository functions, not raw
  queries, to callers.
- `apps/server/src/sync` — owns session diffing and rollup writes. Depends on both packages
  above; nothing depends on it except the worker entrypoint.
- `apps/server/src/api` — reads through repositories only. Never talks to Jellyfin directly
  except for the image proxy.

## Data model

### Reference tables

Mirrored from Jellyfin, cheap to refresh.

- `jellyfin_users` — `id` (Jellyfin GUID, PK), `name`, `is_admin`, `last_seen_at`, `archived`

All Jellyfin-issued identifiers (`jellyfin_users.id`, `items.id`, `libraries.id`) are stored
as `TEXT`, not `uuid` — Jellyfin returns them as 32-character dashless hex, and storing them
verbatim avoids a lossy conversion on every read and write. Only `playback_sessions.id`,
which we generate ourselves, is a real `uuid`.

- `libraries` — `id`, `name`, `collection_type`, `item_count`
- `items` — `id` (GUID, PK), `library_id`, `type`, `name`, `series_id`, `season_id`,
  `production_year`, `runtime_ticks`, `image_tag`, `archived`
- `devices` — `id`, `name`, `client`, `last_seen_at`

`items.series_id` / `season_id` let episodes roll up to shows. Removed media sets
`archived = true` rather than deleting, so history for a deleted file survives.

### Fact table

`playback_sessions` — one row per stream:

`id` (uuid PK), `session_id` (Jellyfin's session id, **partially unique-indexed** — see
below), `user_id`,
`item_id`, `device_id`, `client`, `started_at`, `ended_at` (nullable), `last_seen_at`,
`play_method` (`DirectPlay` | `DirectStream` | `Transcode`), `position_ticks`, `watch_ms`,
`is_paused`, `completed`, `remote_endpoint`.

### Rollup table — the performance decision

Dashboards never scan `playback_sessions`. On session close the worker upserts into:

```sql
playback_rollup_daily(
  day DATE, user_id TEXT, item_id TEXT, library_id TEXT,
  play_count INT, watch_ms BIGINT,
  PRIMARY KEY (day, user_id, item_id)
)
```

```sql
ON CONFLICT (day, user_id, item_id) DO UPDATE
  SET watch_ms   = playback_rollup_daily.watch_ms   + excluded.watch_ms,
      play_count = playback_rollup_daily.play_count + excluded.play_count
```

Every dashboard query — per user, per library, per item, top content, watch time over any
range — is a small aggregate over this one table joined up to `items`. Grain is
days × distinct (user, item) per day: thousands of rows on a home server, not millions.
Indexes on `(day)`, `(user_id, day)`, `(item_id, day)`, `(library_id, day)`.

**Drift correction:** a nightly job recomputes the trailing 7 days directly from
`playback_sessions` and overwrites those rows. Self-healing without a full rebuild. An
integration test asserts that incremental and recomputed totals agree.

## Sync

All sync runs as BullMQ repeatable jobs, each holding a distributed lock so two workers
never double-count.

| Job | Default interval | Configurable |
|---|---|---|
| Session poll | 5s | yes |
| User + library sync | 15m | yes |
| Full item sync | nightly | yes |
| Rollup recompute (trailing 7d) | nightly | no |

### The diff reducer

The core is a pure function with no I/O, no clock access, and no DB:

```ts
diff(previous: SessionSnapshot, incoming: JellyfinSession[]): SessionEvent[]
```

It emits `started` / `progressed` / `paused` / `resumed` / `ended`. An impure shell applies
the events. This makes every difficult case exhaustively unit-testable without a Jellyfin
server.

### Reliability guarantees

1. **Watch time is accumulated, never derived.** Each poll adds the elapsed delta only while
   the stream is unpaused, **clamped to 1.5× the poll interval**. A worker stall or paused
   container cannot inflate a user's stats.
2. **Idempotent writes.** `session_id` is unique-indexed *among open rows only*, so a replayed poll or
   double-delivered job updates the existing row rather than creating a phantom stream.
3. **Startup reconciliation.** Postgres is the source of truth. On worker start, any session
   with `ended_at IS NULL` and `last_seen_at` older than 2× the poll interval is closed at
   `last_seen_at`. A crash mid-stream leaves a correct record, not an eternal open session.

Redis holds the live snapshot (TTL'd) purely as a fast cache; losing it costs nothing
because state rebuilds from Postgres.

A play counts as **completed** when `position_ticks / runtime_ticks >= 0.9` (configurable).

### Verified behavior of the real Jellyfin API

Measured against a live Jellyfin **10.11.11** server during implementation. Every item here
contradicted an assumption in the original spec, and each one produced a silent bug that unit
tests could not catch, because the fixtures were hand-written from the same wrong assumption.
Treat this section as the authority over anything inferred from the docs.

- **`/Sessions` does not return `PlaySessionId`.** It is absent entirely, even on an actively
  playing session. The identity of a stream is the session's **`Id`** (32-char hex) combined
  with `NowPlayingItem.Id`. Dropping sessions that lack `PlaySessionId` means recording
  nothing at all.
- **A session `Id` is stable across items** for the lifetime of a client connection. So
  `(session_id, item_id)` repeats when someone re-watches the same episode in one sitting.
  The identity index is therefore **partial** — `UNIQUE (session_id, item_id) WHERE ended_at
  IS NULL` — so completed rows stop constraining, and a re-watch opens a new row instead of
  merging into the old one.
- **An item's `ParentId` is not its library.** For an Episode it is the Season; for a Movie it
  is a collection folder. Neither matches the `ItemId` values from `/Library/VirtualFolders`.
  An item's library must come from **querying per library** (`ParentId=<libraryId>&Recursive=true`)
  and tagging results with the library that was queried.
- `SeriesId` and `SeasonId` *are* returned on episodes by default and need no `Fields` request.
  `ParentId` does require `Fields=ParentId`; `ImageTags` requires `EnableImages=true`.
- **Paused state must be read from the payload every poll**, not inferred from a state
  transition. A stream stays paused across many polls while only reporting the transition once.

The general lesson, for Plans 2 and 3: **a fixture written from an assumption will confirm that
assumption forever.** Any new Jellyfin endpoint this project consumes gets verified against a
real server before code depends on its shape.

### Live updates

The worker publishes session changes to a Redis channel. The API subscribes and pushes to
browsers over **Server-Sent Events** — one-directional data, automatic browser reconnect, no
WebSocket lifecycle to manage.

## Authentication

Admin-only, backed entirely by Jellyfin.

1. Browser posts username + password to `POST /api/auth/login`.
2. API forwards to Jellyfin `/Users/AuthenticateByName`. Jellyfin is the sole authority —
   **no password is ever stored or hashed, and there is no local user table.**
3. If `Policy.IsAdministrator !== true`, respond 403.
4. The Jellyfin access token we were issued is **immediately revoked**. The app already
   holds `JELLYFIN_API_KEY` for syncing; a second credential is pure liability.
5. The browser receives an **httpOnly, SameSite=Lax, Secure** cookie carrying an opaque
   session ID. The session record lives in Redis with a 7-day sliding TTL.

Not a JWT in localStorage: an opaque cookie session means XSS cannot read the token and
logout revokes server-side rather than trusting the client to discard it. Mutating routes
require `Content-Type: application/json`, which together with `SameSite=Lax` blocks
cross-site form posts.

Login attempts are rate-limited per IP in Redis (10 attempts / 15 minutes).

**Recovery path:** if Jellyfin is unreachable, nobody can log in. An optional
`FALLBACK_ADMIN_USER` / `FALLBACK_ADMIN_PASSWORD` pair enables a local login, **disabled
unless both are explicitly set**, so an unconfigured deployment exposes no static credential.

## UI

Clean and spacious: generous whitespace, restrained palette, two or three well-chosen charts
per view. Dark mode from the start — this dashboard will live on a TV or second monitor.

| Route | Content |
|---|---|
| `/login` | Jellyfin credentials, single card |
| `/` | Overview — active streams, plays and watch time today/week, watch-time trend, recent activity |
| `/live` | Active streams with progress bars and transcode badges, updating over SSE |
| `/history` | Paginated table, filterable by user, library, and date range |
| `/users`, `/users/:id` | Per-user watch time, top content, device breakdown |
| `/libraries`, `/libraries/:id` | Per-library totals, most-watched items |
| `/settings` | Sync intervals, completion threshold, manual re-sync trigger |

Poster art appears as accent in top-content lists, **proxied through the API** so browsers
need neither direct Jellyfin network access nor a second auth context.

Chart palette and chart-form selection follow the `dataviz` skill so both themes stay
readable, rather than accepting Recharts defaults.

### Component architecture

Components are built to be reused across routes, in three layers with a strict dependency
direction — each layer may import from the one above it, never below.

1. **`components/ui/`** — shadcn/ui primitives (Button, Card, Table, Dialog, Badge, Skeleton).
   Generic, no knowledge of this app's domain.
2. **`components/domain/`** — presentational, domain-aware, **props-in only**. No hooks that
   fetch, no route awareness, no access to router params. `StatCard`, `StatCardRow`,
   `WatchTimeChart`, `TopContentList`, `ActiveStreamCard`, `PlaybackHistoryTable`,
   `UserAvatar`, `PosterImage`, `EmptyState`.
3. **`routes/`** — containers. These own the TanStack Query calls and route params, and pass
   plain data down. They hold no presentation logic beyond layout.

Because layer 2 never fetches, the same component genuinely serves several screens rather
than being copied:

| Component | Used by |
|---|---|
| `StatCardRow` | Overview, user detail, library detail |
| `TopContentList` | Overview, user detail, library detail |
| `WatchTimeChart` | Overview, user detail, library detail |
| `PlaybackHistoryTable` | `/history`, user detail, library detail |
| `ActiveStreamCard` | Overview (compact), `/live` (full) |

**The anti-pattern to avoid:** route-specific branching inside a shared component
(`if (context === "userPage")`). Variation is expressed through props and composition —
a `variant` prop for genuinely presentational differences like compact vs full, and
children/slots for structural differences. If a component starts needing to know which page
it is on, that is the signal to split it.

Two consequences worth stating: shared components take **loading and empty states as part of
their contract** (each renders its own skeleton and `EmptyState`), so no caller reimplements
them; and colors, spacing, and radii come from **Tailwind theme tokens**, never hardcoded
values, so cards and charts stay visually consistent as the app grows.

Since layer 2 is pure, it is testable by rendering with props — Vitest plus Testing Library,
no Storybook and no running API.

## Testing

Weighted toward the places where bugs are silent and expensive.

- **Unit (Vitest)** — the `diff()` reducer: paused/resumed, session vanishing mid-stream,
  clock jumps, duplicate payloads, item swapped within one session, watch-time clamping.
  This is where reliability is won.
- **Integration (testcontainers: real Postgres + Redis)** — rollup upsert math, the nightly
  recompute, and startup reconciliation. Asserts incremental totals equal recomputed totals.
- **Jellyfin client (fixtures)** — recorded from Matt's actual server, so the client is
  coded against what his version really returns rather than the docs.
- **E2E (Playwright)** — one smoke test: login → dashboard renders.

## Deployment

`docker compose up -d` plus a `.env`.

**Required:** `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `SESSION_SECRET`, `POSTGRES_PASSWORD`.
Everything else has working defaults.

Multi-stage image build: pnpm workspace install and build, then a slim runtime layer with
production dependencies only, for a small image and fast cold start.

A `seed` script generates plausible fake history so the dashboard is demoable and testable
without hammering a live server.

## Security and repository hygiene

- `.gitignore` excludes `.env` **before the first commit**. Only `.env.example`, with
  placeholder values, is tracked.
- Real Jellyfin URLs, API keys, and secrets never appear in specs, plans, README examples,
  or test files.
- Recorded Jellyfin fixtures are scrubbed of user GUIDs and names, device IDs, and
  `RemoteEndPoint` IP addresses before being committed.
- Commit messages carry no tooling attribution or co-author trailers.

## Open items for implementation

- Jellyfin server URL and API key — Matt supplies these at implementation time; they go into
  a local, untracked `.env`.
- Confirm the Jellyfin server version so the client is built against its actual API surface.
