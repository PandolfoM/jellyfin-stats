# Foundation & Data Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A background worker that syncs a real Jellyfin server's users, libraries, items, and playback sessions into PostgreSQL, maintaining correct daily rollups that later power O(1) dashboard queries.

**Architecture:** A pnpm monorepo. `packages/shared` holds Zod-validated config and domain types. `packages/db` owns all SQL via Drizzle, exposed as repository functions. `packages/jellyfin` is the only code that knows Jellyfin's HTTP shape. `apps/server` contains the sync logic, built around a **pure** `diffSessions()` reducer that turns two consecutive `/Sessions` observations into events — no I/O, no clock, fully unit-testable — plus an impure applier that writes those events to Postgres and Redis.

**Tech Stack:** Node 22 LTS, TypeScript 5.7 (strict), pnpm 10 workspaces, Hono (added in Plan 2), Drizzle ORM + PostgreSQL 17, ioredis + Redis 7, BullMQ, Vitest, Testcontainers, Zod.

This plan is Plan 1 of 3. Plan 2 adds the HTTP API and authentication; Plan 3 adds the web UI and production image. Spec: [`docs/superpowers/specs/2026-08-16-jellyfin-stats-design.md`](../specs/2026-08-16-jellyfin-stats-design.md).

## Global Constraints

- **Node 22 LTS.** `engines.node` is `>=22`. Verified present: v22.14.0.
- **pnpm 10 workspaces.** Verified present: 10.27.0. Do not use npm or yarn.
- **TypeScript strict mode everywhere.** `strict: true` plus `noUncheckedIndexedAccess: true`. No `any`, no non-null assertions (`!`) in committed code.
- **ESM only.** `"type": "module"` in every package.
- **No secrets in git.** `.env` is already gitignored. Only `.env.example` with placeholder values is committed. Never paste a real `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `SESSION_SECRET`, or `POSTGRES_PASSWORD` into any tracked file, including tests and fixtures.
- **Scrub fixtures.** Recorded Jellyfin responses must have user GUIDs and names, device IDs, and `RemoteEndPoint` IPs replaced with fake values before being committed.
- **Commit messages carry no tooling attribution.** No `Co-Authored-By` trailers, no "generated with" footers.
- **All Jellyfin-issued IDs are `text`, never `uuid`.** Jellyfin returns 32-character dashless hex. Only `playback_sessions.id`, which we generate, is a real `uuid`.
- **Watch time is wall-clock accumulated, never derived from position**, and every increment is clamped to `SESSION_POLL_INTERVAL_MS * 1.5`.
- **Completion threshold default is 0.9** (`position_ticks / runtime_ticks`), configurable.
- **Every task ends with a commit.** Run the full test suite before committing.

---

### Task 1: Monorepo scaffold and tooling

Sets up the workspace so every later task has a working test command. Nothing here is app logic; the deliverable is "the toolchain runs and typechecks".

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.env.example`, `.npmrc`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/index.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the `@jfstats/shared` package name and the root scripts `pnpm test`, `pnpm typecheck`, `pnpm build`. All later packages are named `@jfstats/<dir>` and are referenced as `"@jfstats/shared": "workspace:*"`.

- [ ] **Step 1: Create the workspace root files**

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`.npmrc`:

```
strict-peer-dependencies=false
auto-install-peers=true
```

Root `package.json`:

```json
{
  "name": "jellyfin-stats",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@10.27.0",
  "scripts": {
    "typecheck": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "pnpm -r build"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "composite": true
  }
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
```

- [ ] **Step 2: Create the shared package**

`packages/shared/package.json`:

```json
{
  "name": "@jfstats/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "build": "tsc --build" },
  "dependencies": { "zod": "^3.24.1" }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"]
}
```

`packages/shared/src/index.ts`:

```ts
export const PACKAGE_NAME = "@jfstats/shared";
```

- [ ] **Step 3: Write the failing test**

`packages/shared/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("shared package", () => {
  it("is wired into the workspace", () => {
    expect(PACKAGE_NAME).toBe("@jfstats/shared");
  });
});
```

- [ ] **Step 4: Install and run the test**

```bash
pnpm install
pnpm test
```

Expected: 1 test passes. If `pnpm test` reports "No test files found", the `include` globs in `vitest.config.ts` are wrong — fix before continuing.

- [ ] **Step 5: Verify typecheck passes**

```bash
pnpm typecheck
```

Expected: exit code 0, no output.

- [ ] **Step 6: Create `.env.example` with placeholders only**

```
# Jellyfin connection — fill these in a local .env, never commit real values
JELLYFIN_URL=http://jellyfin.example.local:8096
JELLYFIN_API_KEY=replace-with-your-jellyfin-api-key

# Database
POSTGRES_PASSWORD=replace-with-a-strong-password
DATABASE_URL=postgres://jfstats:replace-with-a-strong-password@localhost:5432/jfstats

# Redis
REDIS_URL=redis://localhost:6379

# Sessions — generate with: openssl rand -hex 32
SESSION_SECRET=replace-with-64-hex-characters

# Tuning (optional; these are the defaults)
SESSION_POLL_INTERVAL_MS=5000
REFERENCE_SYNC_INTERVAL_MS=900000
COMPLETION_THRESHOLD=0.9
LOG_LEVEL=info
PORT=3000
```

- [ ] **Step 7: Confirm `.env` cannot be committed**

```bash
printf 'JELLYFIN_API_KEY=fake-local-value\n' > .env
git check-ignore -v .env
```

Expected: prints a line naming `.gitignore` as the source of the ignore rule. If it prints nothing, `.env` is NOT ignored — stop and fix `.gitignore` before any further commit.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts .npmrc .env.example packages/shared pnpm-lock.yaml
git commit -m "Set up pnpm workspace with TypeScript and Vitest"
```

---

### Task 2: Environment configuration

Config is parsed once, validated with Zod, and fails loudly at boot rather than producing `undefined` deep inside a job.

**Files:**
- Create: `packages/shared/src/env.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/env.test.ts`

**Interfaces:**
- Consumes: `@jfstats/shared` package from Task 1.
- Produces: `loadEnv(source?: NodeJS.ProcessEnv): AppEnv` and the `AppEnv` type. Every later task reads config through `loadEnv()`, never `process.env` directly.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const valid = {
  JELLYFIN_URL: "http://jellyfin.test:8096",
  JELLYFIN_API_KEY: "test-key",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "a".repeat(64),
};

describe("loadEnv", () => {
  it("applies documented defaults", () => {
    const env = loadEnv(valid);
    expect(env.SESSION_POLL_INTERVAL_MS).toBe(5000);
    expect(env.REFERENCE_SYNC_INTERVAL_MS).toBe(900_000);
    expect(env.COMPLETION_THRESHOLD).toBe(0.9);
    expect(env.PORT).toBe(3000);
  });

  it("coerces numeric strings", () => {
    const env = loadEnv({ ...valid, SESSION_POLL_INTERVAL_MS: "2000" });
    expect(env.SESSION_POLL_INTERVAL_MS).toBe(2000);
  });

  it("strips a trailing slash from JELLYFIN_URL", () => {
    const env = loadEnv({ ...valid, JELLYFIN_URL: "http://jellyfin.test:8096/" });
    expect(env.JELLYFIN_URL).toBe("http://jellyfin.test:8096");
  });

  it("throws a message naming the missing variable", () => {
    const { JELLYFIN_API_KEY: _omitted, ...missing } = valid;
    expect(() => loadEnv(missing)).toThrow(/JELLYFIN_API_KEY/);
  });

  it("rejects a session secret shorter than 32 characters", () => {
    expect(() => loadEnv({ ...valid, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });

  it("rejects a completion threshold above 1", () => {
    expect(() => loadEnv({ ...valid, COMPLETION_THRESHOLD: "1.5" })).toThrow(/COMPLETION_THRESHOLD/);
  });

  it("enables the fallback admin only when both credentials are set", () => {
    expect(loadEnv(valid).fallbackAdminEnabled).toBe(false);
    expect(loadEnv({ ...valid, FALLBACK_ADMIN_USER: "rescue" }).fallbackAdminEnabled).toBe(false);
    const both = loadEnv({
      ...valid,
      FALLBACK_ADMIN_USER: "rescue",
      FALLBACK_ADMIN_PASSWORD: "rescue-password",
    });
    expect(both.fallbackAdminEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run packages/shared/src/env.test.ts
```

Expected: FAIL — cannot resolve `./env.js`.

- [ ] **Step 3: Implement `env.ts`**

```ts
import { z } from "zod";

const schema = z.object({
  JELLYFIN_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, "")),
  JELLYFIN_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  SESSION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  REFERENCE_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(900_000),
  COMPLETION_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  FALLBACK_ADMIN_USER: z.string().min(1).optional(),
  FALLBACK_ADMIN_PASSWORD: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppEnv = z.infer<typeof schema> & {
  /** True only when BOTH fallback credentials are set, per the spec's recovery path. */
  readonly fallbackAdminEnabled: boolean;
  /** Watch-time increments are clamped to this, so a stalled worker cannot inflate stats. */
  readonly maxWatchDeltaMs: number;
  /** An open session older than this is closed by startup reconciliation. */
  readonly staleSessionAfterMs: number;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const env = parsed.data;

  return {
    ...env,
    fallbackAdminEnabled:
      env.FALLBACK_ADMIN_USER !== undefined && env.FALLBACK_ADMIN_PASSWORD !== undefined,
    maxWatchDeltaMs: Math.round(env.SESSION_POLL_INTERVAL_MS * 1.5),
    staleSessionAfterMs: env.SESSION_POLL_INTERVAL_MS * 2,
  };
}
```

- [ ] **Step 4: Export from the package index**

`packages/shared/src/index.ts`:

```ts
export const PACKAGE_NAME = "@jfstats/shared";
export { loadEnv, type AppEnv } from "./env.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm vitest run packages/shared/src/env.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "Add validated environment configuration

Parses and validates config once at boot with Zod so a missing or malformed
variable fails immediately with a message naming it, rather than surfacing as
undefined inside a running job.

Derives maxWatchDeltaMs and staleSessionAfterMs from the poll interval so the
clamp and reconciliation window cannot drift apart from it."
```

---

### Task 3: Session domain types

The vocabulary the reducer and the applier share. Types only — no runtime logic — so this task has no behavioral test; it is verified by `pnpm typecheck` and consumed immediately in Task 4.

**Files:**
- Create: `packages/shared/src/session.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `@jfstats/shared` from Task 2.
- Produces: `PlayMethod`, `LiveSession`, `SessionSnapshot`, `SessionSnapshotEntry`, `SessionEvent`. Task 4's `diffSessions` consumes and produces exactly these; Task 8's applier switches on `SessionEvent["type"]`.

- [ ] **Step 1: Create `session.ts`**

```ts
export type PlayMethod = "DirectPlay" | "DirectStream" | "Transcode";

/** One currently-playing stream as reported by Jellyfin's /Sessions endpoint. */
export interface LiveSession {
  playSessionId: string;
  userId: string;
  userName: string;
  itemId: string;
  itemName: string;
  deviceId: string;
  deviceName: string;
  client: string;
  playMethod: PlayMethod;
  positionTicks: number;
  /** Null when Jellyfin does not report a runtime (e.g. live TV). */
  runtimeTicks: number | null;
  isPaused: boolean;
  remoteEndpoint: string | null;
}

/**
 * What we remember about a stream between two polls. Deliberately minimal: it is
 * a cache, and Postgres remains the source of truth if it is lost.
 */
export interface SessionSnapshotEntry {
  playSessionId: string;
  itemId: string;
  positionTicks: number;
  isPaused: boolean;
  /** Epoch milliseconds at which this entry was observed. */
  observedAt: number;
}

/** Keyed by `${playSessionId}:${itemId}` — see snapshotKey() in Task 4. */
export type SessionSnapshot = Record<string, SessionSnapshotEntry>;

export type SessionEvent =
  | { type: "started"; key: string; session: LiveSession; at: number }
  | { type: "progressed"; key: string; positionTicks: number; watchedMs: number; at: number }
  | { type: "paused"; key: string; positionTicks: number; watchedMs: number; at: number }
  | { type: "resumed"; key: string; positionTicks: number; at: number }
  | { type: "ended"; key: string; positionTicks: number; watchedMs: number; at: number };
```

- [ ] **Step 2: Export from the package index**

`packages/shared/src/index.ts`:

```ts
export const PACKAGE_NAME = "@jfstats/shared";
export { loadEnv, type AppEnv } from "./env.js";
export type {
  LiveSession,
  PlayMethod,
  SessionEvent,
  SessionSnapshot,
  SessionSnapshotEntry,
} from "./session.js";
```

- [ ] **Step 3: Verify the types compile**

```bash
pnpm typecheck
```

Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add packages/shared
git commit -m "Add session domain types shared by the reducer and applier"
```

---

### Task 4: The `diffSessions` pure reducer

**This is the most important task in the plan.** Every reliability guarantee in the spec is decided here. It is a pure function — no I/O, no `Date.now()`, no database — so all of it can be tested exhaustively without a Jellyfin server.

Read the whole task before writing code; the tests define behavior that is easy to get subtly wrong.

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/src/sync/diff.ts`
- Test: `apps/server/src/sync/diff.test.ts`

**Interfaces:**
- Consumes: `LiveSession`, `SessionSnapshot`, `SessionEvent` from Task 3.
- Produces:
  - `snapshotKey(playSessionId: string, itemId: string): string`
  - `diffSessions(previous: SessionSnapshot, incoming: LiveSession[], options: DiffOptions): DiffResult`
  - `interface DiffOptions { now: number; maxWatchDeltaMs: number }`
  - `interface DiffResult { events: SessionEvent[]; snapshot: SessionSnapshot }`

  Task 8's applier calls `diffSessions` and persists `events`, then stores `snapshot`.

**Design notes the implementer must honor:**

1. **Sessions are keyed by `playSessionId` AND `itemId`.** Jellyfin reuses a `PlaySessionId` when a client auto-plays the next episode. Treating that as one continuous session would merge two episodes into one row. Keying on both means an item change naturally emits `ended` for the old item and `started` for the new one.
2. **Watch time is wall-clock, not position-derived.** `watchedMs` is the time elapsed since the previous observation, credited only when the stream was *not* paused at that previous observation. This is why seeking backward or forward cannot corrupt stats.
3. **Every delta is clamped to `maxWatchDeltaMs`** and floored at 0. A stalled worker or a backwards clock jump contributes nothing rather than a spurious hour.
4. **A vanished session is credited its final delta** (clamped) if it was playing when last seen. This over-credits by at most one poll interval, which is the correct trade against systematically under-counting the end of every stream.

- [ ] **Step 1: Create the server app package**

`apps/server/package.json`:

```json
{
  "name": "@jfstats/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "tsc --build" },
  "dependencies": {
    "@jfstats/shared": "workspace:*"
  }
}
```

`apps/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../../packages/shared" }]
}
```

Then run `pnpm install` to link the workspace dependency.

- [ ] **Step 2: Write the failing test**

`apps/server/src/sync/diff.test.ts`:

```ts
import type { LiveSession, SessionSnapshot } from "@jfstats/shared";
import { describe, expect, it } from "vitest";
import { diffSessions, snapshotKey } from "./diff.js";

const T0 = 1_700_000_000_000;
const OPTIONS = { now: T0 + 5_000, maxWatchDeltaMs: 7_500 };

function session(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    playSessionId: "ps-1",
    userId: "user-1",
    userName: "alice",
    itemId: "item-1",
    itemName: "The Movie",
    deviceId: "device-1",
    deviceName: "Living Room TV",
    client: "Jellyfin Web",
    playMethod: "DirectPlay",
    positionTicks: 10_000_000,
    runtimeTicks: 60_000_000_000,
    isPaused: false,
    remoteEndpoint: "10.0.0.5",
    ...overrides,
  };
}

function snapshotOf(
  live: LiveSession,
  overrides: { observedAt?: number; isPaused?: boolean; positionTicks?: number } = {},
): SessionSnapshot {
  const key = snapshotKey(live.playSessionId, live.itemId);
  return {
    [key]: {
      playSessionId: live.playSessionId,
      itemId: live.itemId,
      positionTicks: overrides.positionTicks ?? live.positionTicks,
      isPaused: overrides.isPaused ?? live.isPaused,
      observedAt: overrides.observedAt ?? T0,
    },
  };
}

describe("diffSessions", () => {
  it("emits started for a stream it has not seen before", () => {
    const live = session();
    const { events, snapshot } = diffSessions({}, [live], OPTIONS);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "started", key: snapshotKey("ps-1", "item-1") });
    expect(snapshot[snapshotKey("ps-1", "item-1")]?.observedAt).toBe(OPTIONS.now);
  });

  it("credits no watch time on the first observation", () => {
    const { events } = diffSessions({}, [session()], OPTIONS);
    const started = events[0];

    expect(started?.type).toBe("started");
    // A "started" event carries no watchedMs at all — there is no prior observation
    // to measure from, so there is nothing to credit.
    expect(started && "watchedMs" in started).toBe(false);
  });

  it("credits elapsed wall-clock time while playing", () => {
    const live = session();
    const { events } = diffSessions(snapshotOf(live), [live], OPTIONS);

    expect(events[0]).toMatchObject({ type: "progressed", watchedMs: 5_000 });
  });

  it("clamps the credit to maxWatchDeltaMs when the worker stalls", () => {
    const live = session();
    // Worker was asleep for an hour; only 7.5s may be credited.
    const { events } = diffSessions(snapshotOf(live), [live], {
      now: T0 + 3_600_000,
      maxWatchDeltaMs: 7_500,
    });

    expect(events[0]).toMatchObject({ type: "progressed", watchedMs: 7_500 });
  });

  it("credits zero when the clock jumps backwards", () => {
    const live = session();
    const { events } = diffSessions(snapshotOf(live), [live], {
      now: T0 - 60_000,
      maxWatchDeltaMs: 7_500,
    });

    expect(events[0]).toMatchObject({ type: "progressed", watchedMs: 0 });
  });

  it("credits nothing while a stream stays paused", () => {
    const live = session({ isPaused: true });
    const { events } = diffSessions(snapshotOf(live, { isPaused: true }), [live], OPTIONS);

    expect(events[0]).toMatchObject({ type: "progressed", watchedMs: 0 });
  });

  it("emits paused and credits the time played before the pause", () => {
    const previous = session();
    const live = session({ isPaused: true });
    const { events } = diffSessions(snapshotOf(previous, { isPaused: false }), [live], OPTIONS);

    expect(events[0]).toMatchObject({ type: "paused", watchedMs: 5_000 });
  });

  it("emits resumed with no watch time for the paused interval", () => {
    const live = session({ isPaused: false });
    const { events } = diffSessions(snapshotOf(live, { isPaused: true }), [live], OPTIONS);

    const resumed = events[0];
    expect(resumed?.type).toBe("resumed");
    expect(resumed && "watchedMs" in resumed).toBe(false);
  });

  it("credits wall-clock time even when the user seeks backwards", () => {
    const live = session({ positionTicks: 1_000_000 });
    const previous = snapshotOf(session(), { positionTicks: 500_000_000 });
    const { events } = diffSessions(previous, [live], OPTIONS);

    // Position went backwards; watch time is wall-clock so it is unaffected.
    expect(events[0]).toMatchObject({ type: "progressed", watchedMs: 5_000 });
  });

  it("emits ended for a stream that disappeared, crediting its final delta", () => {
    const previous = snapshotOf(session(), { isPaused: false });
    const { events, snapshot } = diffSessions(previous, [], OPTIONS);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "ended", watchedMs: 5_000 });
    expect(snapshot).toEqual({});
  });

  it("credits no final delta when the stream was paused when last seen", () => {
    const previous = snapshotOf(session(), { isPaused: true });
    const { events } = diffSessions(previous, [], OPTIONS);

    expect(events[0]).toMatchObject({ type: "ended", watchedMs: 0 });
  });

  it("treats an item change under one play session as end-then-start", () => {
    const previous = snapshotOf(session({ itemId: "episode-1" }));
    const live = session({ itemId: "episode-2" });
    const { events } = diffSessions(previous, [live], OPTIONS);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "ended", key: snapshotKey("ps-1", "episode-1") });
    expect(events[1]).toMatchObject({ type: "started", key: snapshotKey("ps-1", "episode-2") });
  });

  it("is idempotent when the identical payload is replayed at the same instant", () => {
    const live = session();
    const first = diffSessions({}, [live], OPTIONS);
    const second = diffSessions(first.snapshot, [live], OPTIONS);

    expect(second.events).toEqual([{ type: "progressed", key: snapshotKey("ps-1", "item-1"), positionTicks: live.positionTicks, watchedMs: 0, at: OPTIONS.now }]);
    expect(second.snapshot).toEqual(first.snapshot);
  });

  it("handles several concurrent streams independently", () => {
    const a = session({ playSessionId: "ps-a", itemId: "item-a" });
    const b = session({ playSessionId: "ps-b", itemId: "item-b" });
    const previous = { ...snapshotOf(a), ...snapshotOf(b) };

    const { events } = diffSessions(previous, [a], OPTIONS);

    expect(events).toHaveLength(2);
    expect(events.find((e) => e.key === snapshotKey("ps-a", "item-a"))?.type).toBe("progressed");
    expect(events.find((e) => e.key === snapshotKey("ps-b", "item-b"))?.type).toBe("ended");
  });

  it("ignores a session Jellyfin reports without a play session id", () => {
    const live = session({ playSessionId: "" });
    const { events, snapshot } = diffSessions({}, [live], OPTIONS);

    expect(events).toEqual([]);
    expect(snapshot).toEqual({});
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm vitest run apps/server/src/sync/diff.test.ts
```

Expected: FAIL — cannot resolve `./diff.js`.

- [ ] **Step 4: Implement `diff.ts`**

```ts
import type { LiveSession, SessionEvent, SessionSnapshot, SessionSnapshotEntry } from "@jfstats/shared";

export interface DiffOptions {
  /** Epoch milliseconds at which this poll was taken. Injected, never read from the clock. */
  now: number;
  /** Upper bound on a single watch-time credit. */
  maxWatchDeltaMs: number;
}

export interface DiffResult {
  events: SessionEvent[];
  snapshot: SessionSnapshot;
}

/**
 * Jellyfin reuses a PlaySessionId across an auto-played next episode, so the item
 * id is part of the identity. Without it, two episodes would merge into one row.
 */
export function snapshotKey(playSessionId: string, itemId: string): string {
  return `${playSessionId}:${itemId}`;
}

/**
 * Time credited for the interval that just elapsed. Only counts when the stream was
 * playing at the previous observation, and is clamped at both ends so neither a
 * stalled worker nor a backwards clock can corrupt the total.
 */
function creditFor(previous: SessionSnapshotEntry, options: DiffOptions): number {
  if (previous.isPaused) return 0;
  const elapsed = options.now - previous.observedAt;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.min(elapsed, options.maxWatchDeltaMs);
}

export function diffSessions(
  previous: SessionSnapshot,
  incoming: LiveSession[],
  options: DiffOptions,
): DiffResult {
  const events: SessionEvent[] = [];
  const snapshot: SessionSnapshot = {};
  const seen = new Set<string>();

  for (const live of incoming) {
    // Jellyfin occasionally reports a session with no playback identity; it carries
    // no usable history, so it is dropped rather than stored under an empty key.
    if (live.playSessionId === "" || live.itemId === "") continue;

    const key = snapshotKey(live.playSessionId, live.itemId);
    seen.add(key);

    const before = previous[key];

    if (before === undefined) {
      events.push({ type: "started", key, session: live, at: options.now });
    } else if (before.isPaused && !live.isPaused) {
      events.push({ type: "resumed", key, positionTicks: live.positionTicks, at: options.now });
    } else if (!before.isPaused && live.isPaused) {
      events.push({
        type: "paused",
        key,
        positionTicks: live.positionTicks,
        watchedMs: creditFor(before, options),
        at: options.now,
      });
    } else {
      events.push({
        type: "progressed",
        key,
        positionTicks: live.positionTicks,
        watchedMs: creditFor(before, options),
        at: options.now,
      });
    }

    snapshot[key] = {
      playSessionId: live.playSessionId,
      itemId: live.itemId,
      positionTicks: live.positionTicks,
      isPaused: live.isPaused,
      observedAt: options.now,
    };
  }

  // Anything present last poll but absent now has stopped playing. An item change
  // under one play session lands here too, which is what produces end-then-start.
  for (const [key, before] of Object.entries(previous)) {
    if (seen.has(key)) continue;
    events.push({
      type: "ended",
      key,
      positionTicks: before.positionTicks,
      watchedMs: creditFor(before, options),
      at: options.now,
    });
  }

  // Ended events must be applied before started events. When a client auto-plays the
  // next episode, the applier has to close the old row before opening the new one, or
  // the two writes race on the same play session id.
  const rank = (event: SessionEvent): number => (event.type === "ended" ? 0 : 1);
  events.sort((a, b) => rank(a) - rank(b));

  return { events, snapshot };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm vitest run apps/server/src/sync/diff.test.ts
```

Expected: PASS, 15 tests.

If the "item change" test fails on ordering, the `events.sort` above is missing or placed after the `return`.

- [ ] **Step 6: Commit**

```bash
git add apps/server pnpm-lock.yaml
git commit -m "Add pure session diff reducer

Turns two consecutive /Sessions observations into playback events with no I/O
and an injected clock, so every edge case is testable without a Jellyfin server.

Watch time is wall-clock accumulated rather than derived from playback position,
which makes seeking harmless, and every credit is clamped so a stalled worker or
a backwards clock jump cannot inflate a user's totals.

Sessions are keyed by play session id AND item id because Jellyfin reuses the
former across auto-played episodes; ended events sort ahead of started so the
applier closes the old row before opening the new one."
```

---

### Task 5: Database schema and migrations

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/drizzle.config.ts`, `packages/db/src/schema.ts`, `packages/db/src/client.ts`, `packages/db/src/index.ts`
- Create: `docker-compose.yml`
- Test: `packages/db/src/schema.test.ts`, `packages/db/src/testing/harness.ts`

**Interfaces:**
- Consumes: `@jfstats/shared` from Task 2.
- Produces:
  - Tables `jellyfinUsers`, `libraries`, `items`, `devices`, `playbackSessions`, `playbackRollupDaily` exported from `@jfstats/db`.
  - `createDb(connectionString: string): { db: Db; pool: Pool }` and `type Db = NodePgDatabase<typeof schema>`.
  - `withTestDatabase(fn: (db: Db) => Promise<void>): Promise<void>` test harness used by Tasks 6, 7 and 9.

- [ ] **Step 1: Create the package and its dependencies**

`packages/db/package.json`:

```json
{
  "name": "@jfstats/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc --build",
    "migrate:generate": "drizzle-kit generate",
    "migrate:push": "drizzle-kit migrate"
  },
  "dependencies": {
    "@jfstats/shared": "workspace:*",
    "drizzle-orm": "^0.38.2",
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^10.16.0",
    "@types/pg": "^8.11.10",
    "drizzle-kit": "^0.30.1"
  }
}
```

`packages/db/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../shared" }]
}
```

Run `pnpm install`.

- [ ] **Step 2: Write the schema**

`packages/db/src/schema.ts`:

```ts
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Jellyfin-issued identifiers are 32-character dashless hex. They are stored as
// text verbatim; converting to uuid on every read and write buys nothing.

export const jellyfinUsers = pgTable("jellyfin_users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  archived: boolean("archived").notNull().default(false),
});

export const libraries = pgTable("libraries", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  collectionType: text("collection_type"),
  itemCount: integer("item_count").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
});

export const items = pgTable(
  "items",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id"),
    type: text("type").notNull(),
    name: text("name").notNull(),
    seriesId: text("series_id"),
    seasonId: text("season_id"),
    productionYear: integer("production_year"),
    runtimeTicks: bigint("runtime_ticks", { mode: "number" }),
    imageTag: text("image_tag"),
    archived: boolean("archived").notNull().default(false),
  },
  (table) => [
    index("items_library_idx").on(table.libraryId),
    index("items_series_idx").on(table.seriesId),
  ],
);

export const devices = pgTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  client: text("client"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});

export const playbackSessions = pgTable(
  "playback_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playSessionId: text("play_session_id").notNull(),
    userId: text("user_id").notNull(),
    itemId: text("item_id").notNull(),
    deviceId: text("device_id"),
    client: text("client"),
    playMethod: text("play_method"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    positionTicks: bigint("position_ticks", { mode: "number" }).notNull().default(0),
    watchMs: bigint("watch_ms", { mode: "number" }).notNull().default(0),
    isPaused: boolean("is_paused").notNull().default(false),
    completed: boolean("completed").notNull().default(false),
    remoteEndpoint: text("remote_endpoint"),
  },
  (table) => [
    // The idempotency guarantee: a replayed poll updates this row instead of
    // inserting a phantom second stream.
    uniqueIndex("playback_sessions_identity_uniq").on(table.playSessionId, table.itemId),
    index("playback_sessions_open_idx").on(table.endedAt),
    index("playback_sessions_user_started_idx").on(table.userId, table.startedAt),
    index("playback_sessions_item_started_idx").on(table.itemId, table.startedAt),
  ],
);

export const playbackRollupDaily = pgTable(
  "playback_rollup_daily",
  {
    day: date("day").notNull(),
    userId: text("user_id").notNull(),
    itemId: text("item_id").notNull(),
    libraryId: text("library_id"),
    playCount: integer("play_count").notNull().default(0),
    watchMs: bigint("watch_ms", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.userId, table.itemId] }),
    index("rollup_day_idx").on(table.day),
    index("rollup_user_day_idx").on(table.userId, table.day),
    index("rollup_item_day_idx").on(table.itemId, table.day),
    index("rollup_library_day_idx").on(table.libraryId, table.day),
  ],
);
```

- [ ] **Step 3: Write the client and Drizzle config**

`packages/db/src/client.ts`:

```ts
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(connectionString: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}
```

`packages/db/src/index.ts`:

```ts
export * from "./schema.js";
export { createDb, type Db } from "./client.js";
```

`packages/db/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
```

- [ ] **Step 4: Generate the migration**

```bash
pnpm --filter @jfstats/db migrate:generate
```

Expected: creates `packages/db/drizzle/0000_*.sql` plus `drizzle/meta/`. Open the SQL and confirm it contains `CREATE TABLE "playback_rollup_daily"` with a three-column primary key and `CREATE UNIQUE INDEX "playback_sessions_identity_uniq"`.

- [ ] **Step 5: Write the test harness**

`packages/db/src/testing/harness.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "../client.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

let container: StartedPostgreSqlContainer | undefined;

/**
 * Starts one Postgres container for the whole file, runs migrations, and truncates
 * between cases. Real Postgres rather than a mock, because the behavior under test
 * IS the SQL — upsert arithmetic and constraint enforcement.
 */
export async function withTestDatabase(fn: (db: Db) => Promise<void>): Promise<void> {
  container ??= await new PostgreSqlContainer("postgres:17-alpine").start();
  const { db, pool } = createDb(container.getConnectionUri());

  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await pool.query(`
      TRUNCATE playback_rollup_daily, playback_sessions, items, libraries, devices, jellyfin_users
      RESTART IDENTITY CASCADE
    `);
    await fn(db);
  } finally {
    await pool.end();
  }
}

export async function stopTestDatabase(): Promise<void> {
  await container?.stop();
  container = undefined;
}
```

- [ ] **Step 6: Write the failing test**

`packages/db/src/schema.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { playbackSessions } from "./schema.js";
import { stopTestDatabase, withTestDatabase } from "./testing/harness.js";

afterAll(stopTestDatabase);

describe("schema", () => {
  it("applies migrations and creates every expected table", async () => {
    await withTestDatabase(async (db) => {
      const result = await db.execute<{ table_name: string }>(
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      const tables = result.rows.map((row) => row.table_name);

      expect(tables).toEqual(
        expect.arrayContaining([
          "jellyfin_users",
          "libraries",
          "items",
          "devices",
          "playback_sessions",
          "playback_rollup_daily",
        ]),
      );
    });
  });

  it("rejects a duplicate play session and item pair", async () => {
    await withTestDatabase(async (db) => {
      const row = {
        playSessionId: "ps-1",
        userId: "user-1",
        itemId: "item-1",
        startedAt: new Date(),
        lastSeenAt: new Date(),
      };

      await db.insert(playbackSessions).values(row);

      // This is the guarantee that makes a replayed poll harmless.
      await expect(db.insert(playbackSessions).values(row)).rejects.toThrow(
        /playback_sessions_identity_uniq/,
      );
    });
  });

  it("allows the same play session id with a different item", async () => {
    await withTestDatabase(async (db) => {
      const base = {
        playSessionId: "ps-1",
        userId: "user-1",
        startedAt: new Date(),
        lastSeenAt: new Date(),
      };

      await db.insert(playbackSessions).values({ ...base, itemId: "episode-1" });
      await db.insert(playbackSessions).values({ ...base, itemId: "episode-2" });

      const rows = await db.select().from(playbackSessions);
      expect(rows).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 7: Run the test**

```bash
pnpm vitest run packages/db/src/schema.test.ts
```

Expected: PASS, 3 tests. The first run pulls the `postgres:17-alpine` image and takes up to a minute. Docker must be running.

- [ ] **Step 8: Add the development compose file**

`docker-compose.yml` — infrastructure only for now; the `app` and `worker` services arrive in Plan 3.

```yaml
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: jfstats
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
      POSTGRES_DB: jfstats
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U jfstats -d jfstats"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  postgres-data:
  redis-data:
```

- [ ] **Step 9: Verify the stack starts healthy**

```bash
docker compose up -d && docker compose ps
```

Expected: both services show `healthy`. (`POSTGRES_PASSWORD` must be set in your local `.env`.)

- [ ] **Step 10: Commit**

```bash
git add packages/db docker-compose.yml pnpm-lock.yaml
git commit -m "Add database schema, migrations, and test harness

Adds the reference tables, the playback_sessions fact table, and the daily
rollup that dashboard queries will read instead of scanning raw sessions.

The unique index on (play_session_id, item_id) is the idempotency guarantee:
a replayed poll updates the existing row rather than inserting a phantom
stream, while still allowing an auto-played next episode its own row.

Tests run against real Postgres via testcontainers because the behavior under
test is the SQL itself."
```

---

### Task 6: Reference data repositories

Upserts for users, libraries, items, and devices. These must be idempotent — they run every 15 minutes forever.

**Files:**
- Create: `packages/db/src/repositories/reference.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/repositories/reference.test.ts`

**Interfaces:**
- Consumes: `Db`, schema tables, `withTestDatabase` from Task 5.
- Produces:
  - `upsertUsers(db: Db, rows: UserInput[]): Promise<void>`
  - `upsertLibraries(db: Db, rows: LibraryInput[]): Promise<void>`
  - `upsertItems(db: Db, rows: ItemInput[]): Promise<void>`
  - `upsertDevice(db: Db, row: DeviceInput): Promise<void>`
  - `archiveMissingItems(db: Db, presentIds: string[]): Promise<number>`
  - Input types `UserInput`, `LibraryInput`, `ItemInput`, `DeviceInput`. Task 10 calls all of these.

- [ ] **Step 1: Write the failing test**

`packages/db/src/repositories/reference.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { items, jellyfinUsers } from "../schema.js";
import { stopTestDatabase, withTestDatabase } from "../testing/harness.js";
import { archiveMissingItems, upsertItems, upsertUsers } from "./reference.js";

afterAll(stopTestDatabase);

describe("reference repositories", () => {
  it("inserts users on first sync", async () => {
    await withTestDatabase(async (db) => {
      await upsertUsers(db, [{ id: "u1", name: "alice", isAdmin: true }]);

      const rows = await db.select().from(jellyfinUsers);
      expect(rows).toEqual([
        expect.objectContaining({ id: "u1", name: "alice", isAdmin: true, archived: false }),
      ]);
    });
  });

  it("updates rather than duplicating on repeat sync", async () => {
    await withTestDatabase(async (db) => {
      await upsertUsers(db, [{ id: "u1", name: "alice", isAdmin: false }]);
      await upsertUsers(db, [{ id: "u1", name: "alice-renamed", isAdmin: true }]);

      const rows = await db.select().from(jellyfinUsers);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: "alice-renamed", isAdmin: true });
    });
  });

  it("un-archives a user who reappears in Jellyfin", async () => {
    await withTestDatabase(async (db) => {
      await upsertUsers(db, [{ id: "u1", name: "alice", isAdmin: false }]);
      await db.update(jellyfinUsers).set({ archived: true }).where(eq(jellyfinUsers.id, "u1"));

      await upsertUsers(db, [{ id: "u1", name: "alice", isAdmin: false }]);

      const rows = await db.select().from(jellyfinUsers);
      expect(rows[0]?.archived).toBe(false);
    });
  });

  it("accepts an empty batch without error", async () => {
    await withTestDatabase(async (db) => {
      await expect(upsertUsers(db, [])).resolves.toBeUndefined();
      await expect(upsertItems(db, [])).resolves.toBeUndefined();
    });
  });

  it("archives items that vanished from Jellyfin instead of deleting them", async () => {
    await withTestDatabase(async (db) => {
      await upsertItems(db, [
        { id: "i1", type: "Movie", name: "Kept", libraryId: "lib1" },
        { id: "i2", type: "Movie", name: "Deleted From Disk", libraryId: "lib1" },
      ]);

      const archived = await archiveMissingItems(db, ["i1"]);

      expect(archived).toBe(1);
      const rows = await db.select().from(items).orderBy(items.id);
      // History for a removed file must survive, so the row stays.
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ id: "i2", archived: true });
    });
  });

  it("archives nothing when Jellyfin reports no items, to survive a failed sync", async () => {
    await withTestDatabase(async (db) => {
      await upsertItems(db, [{ id: "i1", type: "Movie", name: "Kept", libraryId: "lib1" }]);

      const archived = await archiveMissingItems(db, []);

      expect(archived).toBe(0);
      const rows = await db.select().from(items);
      expect(rows[0]?.archived).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run packages/db/src/repositories/reference.test.ts
```

Expected: FAIL — cannot resolve `./reference.js`.

- [ ] **Step 3: Implement `reference.ts`**

```ts
import { inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { devices, items, jellyfinUsers, libraries } from "../schema.js";

export interface UserInput {
  id: string;
  name: string;
  isAdmin: boolean;
  lastSeenAt?: Date;
}

export interface LibraryInput {
  id: string;
  name: string;
  collectionType?: string | null;
  itemCount?: number;
}

export interface ItemInput {
  id: string;
  type: string;
  name: string;
  libraryId?: string | null;
  seriesId?: string | null;
  seasonId?: string | null;
  productionYear?: number | null;
  runtimeTicks?: number | null;
  imageTag?: string | null;
}

export interface DeviceInput {
  id: string;
  name: string;
  client?: string | null;
  lastSeenAt?: Date;
}

export async function upsertUsers(db: Db, rows: UserInput[]): Promise<void> {
  if (rows.length === 0) return;

  await db
    .insert(jellyfinUsers)
    .values(rows.map((row) => ({ ...row, archived: false })))
    .onConflictDoUpdate({
      target: jellyfinUsers.id,
      set: {
        name: sql`excluded.name`,
        isAdmin: sql`excluded.is_admin`,
        lastSeenAt: sql`excluded.last_seen_at`,
        // Reappearing in Jellyfin un-archives the row.
        archived: sql`false`,
      },
    });
}

export async function upsertLibraries(db: Db, rows: LibraryInput[]): Promise<void> {
  if (rows.length === 0) return;

  await db
    .insert(libraries)
    .values(rows.map((row) => ({ ...row, archived: false })))
    .onConflictDoUpdate({
      target: libraries.id,
      set: {
        name: sql`excluded.name`,
        collectionType: sql`excluded.collection_type`,
        itemCount: sql`excluded.item_count`,
        archived: sql`false`,
      },
    });
}

export async function upsertItems(db: Db, rows: ItemInput[]): Promise<void> {
  if (rows.length === 0) return;

  // Chunked because a full library sync can exceed Postgres' parameter limit.
  const CHUNK_SIZE = 500;

  for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + CHUNK_SIZE);

    await db
      .insert(items)
      .values(chunk.map((row) => ({ ...row, archived: false })))
      .onConflictDoUpdate({
        target: items.id,
        set: {
          libraryId: sql`excluded.library_id`,
          type: sql`excluded.type`,
          name: sql`excluded.name`,
          seriesId: sql`excluded.series_id`,
          seasonId: sql`excluded.season_id`,
          productionYear: sql`excluded.production_year`,
          runtimeTicks: sql`excluded.runtime_ticks`,
          imageTag: sql`excluded.image_tag`,
          archived: sql`false`,
        },
      });
  }
}

export async function upsertDevice(db: Db, row: DeviceInput): Promise<void> {
  await db
    .insert(devices)
    .values(row)
    .onConflictDoUpdate({
      target: devices.id,
      set: {
        name: sql`excluded.name`,
        client: sql`excluded.client`,
        lastSeenAt: sql`excluded.last_seen_at`,
      },
    });
}

/**
 * Marks items no longer present in Jellyfin as archived. Rows are never deleted, so
 * watch history for a removed file survives.
 *
 * An empty `presentIds` is treated as a failed sync rather than an emptied server —
 * archiving the entire catalogue because one API call returned nothing would be far
 * worse than skipping a cycle.
 */
export async function archiveMissingItems(db: Db, presentIds: string[]): Promise<number> {
  if (presentIds.length === 0) return 0;

  const archived = await db
    .update(items)
    .set({ archived: true })
    .where(notInArray(items.id, presentIds))
    .returning({ id: items.id });

  return archived.length;
}

export async function findItemsByIds(db: Db, ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(items).where(inArray(items.id, ids));
}
```

- [ ] **Step 4: Export from the package index**

`packages/db/src/index.ts`:

```ts
export * from "./schema.js";
export { createDb, type Db } from "./client.js";
export * from "./repositories/reference.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm vitest run packages/db/src/repositories/reference.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "Add idempotent reference data repositories

Upserts for users, libraries, items, and devices, chunked so a full library
sync cannot exceed Postgres' parameter limit.

Missing items are archived rather than deleted so history for a removed file
survives, and an empty result from Jellyfin is treated as a failed sync rather
than an emptied server — archiving the whole catalogue on one bad API response
would be far worse than skipping a cycle."
```

---

### Task 7: Playback session and rollup repositories

The write path for playback, and the rollup arithmetic that makes dashboards fast.

**Files:**
- Create: `packages/db/src/repositories/playback.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/repositories/playback.test.ts`

**Interfaces:**
- Consumes: `Db`, schema, `withTestDatabase` from Task 5.
- Produces:
  - `openSession(db, input: OpenSessionInput): Promise<void>`
  - `touchSession(db, input: TouchSessionInput): Promise<void>`
  - `closeSession(db, input: CloseSessionInput): Promise<void>`
  - `findStaleOpenSessions(db, olderThan: Date): Promise<StaleSession[]>`
  - `applyRollupDelta(db, input: RollupDelta): Promise<void>`
  - `recomputeRollupRange(db, from: Date, to: Date): Promise<void>`

  Task 8's applier calls the first four; Task 9's nightly job calls `recomputeRollupRange`.

- [ ] **Step 1: Write the failing test**

`packages/db/src/repositories/playback.test.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { playbackRollupDaily, playbackSessions } from "../schema.js";
import { stopTestDatabase, withTestDatabase } from "../testing/harness.js";
import {
  applyRollupDelta,
  closeSession,
  findStaleOpenSessions,
  openSession,
  recomputeRollupRange,
  touchSession,
} from "./playback.js";

afterAll(stopTestDatabase);

const START = new Date("2026-08-16T20:00:00Z");

const OPEN = {
  playSessionId: "ps-1",
  itemId: "item-1",
  userId: "user-1",
  deviceId: "device-1",
  client: "Jellyfin Web",
  playMethod: "DirectPlay" as const,
  positionTicks: 0,
  remoteEndpoint: "10.0.0.5",
  at: START,
};

describe("playback repositories", () => {
  it("opens a session as not yet ended", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);

      const rows = await db.select().from(playbackSessions);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ playSessionId: "ps-1", endedAt: null, watchMs: 0 });
    });
  });

  it("is idempotent when the same session is opened twice", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      await openSession(db, OPEN);

      const rows = await db.select().from(playbackSessions);
      expect(rows).toHaveLength(1);
    });
  });

  it("accumulates watch time across successive touches", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      await touchSession(db, {
        playSessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 50_000_000,
        watchedMs: 5_000,
        isPaused: false,
        at: new Date(START.getTime() + 5_000),
      });
      await touchSession(db, {
        playSessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 100_000_000,
        watchedMs: 5_000,
        isPaused: false,
        at: new Date(START.getTime() + 10_000),
      });

      const rows = await db.select().from(playbackSessions);
      expect(rows[0]?.watchMs).toBe(10_000);
    });
  });

  it("marks a session completed when position passes the threshold", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      await closeSession(db, {
        playSessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 95,
        runtimeTicks: 100,
        watchedMs: 1_000,
        completionThreshold: 0.9,
        at: new Date(START.getTime() + 60_000),
      });

      const rows = await db.select().from(playbackSessions);
      expect(rows[0]).toMatchObject({ completed: true });
      expect(rows[0]?.endedAt).not.toBeNull();
    });
  });

  it("leaves a session incomplete below the threshold", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      await closeSession(db, {
        playSessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 10,
        runtimeTicks: 100,
        watchedMs: 1_000,
        completionThreshold: 0.9,
        at: new Date(START.getTime() + 60_000),
      });

      const rows = await db.select().from(playbackSessions);
      expect(rows[0]?.completed).toBe(false);
    });
  });

  it("treats an unknown runtime as incomplete rather than dividing by zero", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      await closeSession(db, {
        playSessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 500,
        runtimeTicks: null,
        watchedMs: 1_000,
        completionThreshold: 0.9,
        at: new Date(START.getTime() + 60_000),
      });

      const rows = await db.select().from(playbackSessions);
      expect(rows[0]?.completed).toBe(false);
    });
  });

  it("finds only open sessions older than the cutoff", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      await openSession(db, { ...OPEN, playSessionId: "ps-2", itemId: "item-2", at: new Date(START.getTime() + 60_000) });

      const stale = await findStaleOpenSessions(db, new Date(START.getTime() + 30_000));

      expect(stale).toHaveLength(1);
      expect(stale[0]).toMatchObject({ playSessionId: "ps-1", itemId: "item-1" });
    });
  });

  it("adds to an existing rollup row rather than replacing it", async () => {
    await withTestDatabase(async (db) => {
      const delta = { day: "2026-08-16", userId: "user-1", itemId: "item-1", libraryId: "lib-1", playCount: 1, watchMs: 5_000 };

      await applyRollupDelta(db, delta);
      await applyRollupDelta(db, delta);

      const rows = await db.select().from(playbackRollupDaily);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ playCount: 2, watchMs: 10_000 });
    });
  });

  it("recomputes a range to match what incremental writes produced", async () => {
    await withTestDatabase(async (db) => {
      // Two real sessions on the same day for the same user and item.
      await db.insert(playbackSessions).values([
        { playSessionId: "ps-1", itemId: "item-1", userId: "user-1", startedAt: START, lastSeenAt: START, endedAt: new Date(START.getTime() + 60_000), watchMs: 6_000 },
        { playSessionId: "ps-2", itemId: "item-1", userId: "user-1", startedAt: START, lastSeenAt: START, endedAt: new Date(START.getTime() + 120_000), watchMs: 4_000 },
      ]);
      // A drifted rollup row, as if an incremental write had been lost.
      await applyRollupDelta(db, { day: "2026-08-16", userId: "user-1", itemId: "item-1", libraryId: null, playCount: 1, watchMs: 999 });

      await recomputeRollupRange(db, new Date("2026-08-16T00:00:00Z"), new Date("2026-08-17T00:00:00Z"));

      const rows = await db
        .select()
        .from(playbackRollupDaily)
        .where(and(eq(playbackRollupDaily.userId, "user-1"), eq(playbackRollupDaily.itemId, "item-1")));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ playCount: 2, watchMs: 10_000 });
    });
  });

  it("removes rollup rows in range that no longer have sessions", async () => {
    await withTestDatabase(async (db) => {
      await applyRollupDelta(db, { day: "2026-08-16", userId: "ghost", itemId: "item-x", libraryId: null, playCount: 3, watchMs: 300 });

      await recomputeRollupRange(db, new Date("2026-08-16T00:00:00Z"), new Date("2026-08-17T00:00:00Z"));

      const rows = await db.select().from(playbackRollupDaily);
      expect(rows).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run packages/db/src/repositories/playback.test.ts
```

Expected: FAIL — cannot resolve `./playback.js`.

- [ ] **Step 3: Implement `playback.ts`**

```ts
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { items, playbackRollupDaily, playbackSessions } from "../schema.js";

export interface OpenSessionInput {
  playSessionId: string;
  itemId: string;
  userId: string;
  deviceId: string | null;
  client: string | null;
  playMethod: string | null;
  positionTicks: number;
  remoteEndpoint: string | null;
  at: Date;
}

export interface TouchSessionInput {
  playSessionId: string;
  itemId: string;
  positionTicks: number;
  watchedMs: number;
  isPaused: boolean;
  at: Date;
}

export interface CloseSessionInput {
  playSessionId: string;
  itemId: string;
  positionTicks: number;
  runtimeTicks: number | null;
  watchedMs: number;
  completionThreshold: number;
  at: Date;
}

export interface StaleSession {
  playSessionId: string;
  itemId: string;
  userId: string;
  positionTicks: number;
  lastSeenAt: Date;
}

export interface RollupDelta {
  /** ISO date, `YYYY-MM-DD`. */
  day: string;
  userId: string;
  itemId: string;
  libraryId: string | null;
  playCount: number;
  watchMs: number;
}

export async function openSession(db: Db, input: OpenSessionInput): Promise<void> {
  await db
    .insert(playbackSessions)
    .values({
      playSessionId: input.playSessionId,
      itemId: input.itemId,
      userId: input.userId,
      deviceId: input.deviceId,
      client: input.client,
      playMethod: input.playMethod,
      positionTicks: input.positionTicks,
      remoteEndpoint: input.remoteEndpoint,
      startedAt: input.at,
      lastSeenAt: input.at,
    })
    // A replayed poll must not create a second row, and must not reset watch time.
    .onConflictDoUpdate({
      target: [playbackSessions.playSessionId, playbackSessions.itemId],
      set: { lastSeenAt: input.at },
    });
}

export async function touchSession(db: Db, input: TouchSessionInput): Promise<void> {
  await db
    .update(playbackSessions)
    .set({
      positionTicks: input.positionTicks,
      isPaused: input.isPaused,
      lastSeenAt: input.at,
      watchMs: sql`${playbackSessions.watchMs} + ${input.watchedMs}`,
    })
    .where(
      and(
        eq(playbackSessions.playSessionId, input.playSessionId),
        eq(playbackSessions.itemId, input.itemId),
      ),
    );
}

export async function closeSession(db: Db, input: CloseSessionInput): Promise<void> {
  // An unknown runtime cannot be a completion — never divide by a missing value.
  const completed =
    input.runtimeTicks !== null &&
    input.runtimeTicks > 0 &&
    input.positionTicks / input.runtimeTicks >= input.completionThreshold;

  await db
    .update(playbackSessions)
    .set({
      positionTicks: input.positionTicks,
      endedAt: input.at,
      lastSeenAt: input.at,
      isPaused: false,
      completed,
      watchMs: sql`${playbackSessions.watchMs} + ${input.watchedMs}`,
    })
    .where(
      and(
        eq(playbackSessions.playSessionId, input.playSessionId),
        eq(playbackSessions.itemId, input.itemId),
        isNull(playbackSessions.endedAt),
      ),
    );
}

export async function findStaleOpenSessions(db: Db, olderThan: Date): Promise<StaleSession[]> {
  return db
    .select({
      playSessionId: playbackSessions.playSessionId,
      itemId: playbackSessions.itemId,
      userId: playbackSessions.userId,
      positionTicks: playbackSessions.positionTicks,
      lastSeenAt: playbackSessions.lastSeenAt,
    })
    .from(playbackSessions)
    .where(and(isNull(playbackSessions.endedAt), lt(playbackSessions.lastSeenAt, olderThan)));
}

export async function applyRollupDelta(db: Db, input: RollupDelta): Promise<void> {
  await db
    .insert(playbackRollupDaily)
    .values(input)
    .onConflictDoUpdate({
      target: [playbackRollupDaily.day, playbackRollupDaily.userId, playbackRollupDaily.itemId],
      set: {
        playCount: sql`${playbackRollupDaily.playCount} + ${input.playCount}`,
        watchMs: sql`${playbackRollupDaily.watchMs} + ${input.watchMs}`,
        libraryId: sql`coalesce(excluded.library_id, ${playbackRollupDaily.libraryId})`,
      },
    });
}

/**
 * Rebuilds the rollup for `[from, to)` directly from playback_sessions, correcting any
 * drift from lost or double-applied incremental writes. Deleting the range first is
 * what lets it remove rows whose sessions no longer exist.
 */
export async function recomputeRollupRange(db: Db, from: Date, to: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM ${playbackRollupDaily}
      WHERE ${playbackRollupDaily.day} >= ${from.toISOString().slice(0, 10)}
        AND ${playbackRollupDaily.day} <  ${to.toISOString().slice(0, 10)}
    `);

    await tx.execute(sql`
      INSERT INTO ${playbackRollupDaily} (day, user_id, item_id, library_id, play_count, watch_ms)
      SELECT
        (${playbackSessions.startedAt} AT TIME ZONE 'UTC')::date AS day,
        ${playbackSessions.userId},
        ${playbackSessions.itemId},
        max(${items.libraryId}) AS library_id,
        count(*)::int AS play_count,
        coalesce(sum(${playbackSessions.watchMs}), 0) AS watch_ms
      FROM ${playbackSessions}
      LEFT JOIN ${items} ON ${items.id} = ${playbackSessions.itemId}
      WHERE ${playbackSessions.startedAt} >= ${from}
        AND ${playbackSessions.startedAt} <  ${to}
      GROUP BY 1, 2, 3
    `);
  });
}
```

- [ ] **Step 4: Export from the package index**

`packages/db/src/index.ts`:

```ts
export * from "./schema.js";
export { createDb, type Db } from "./client.js";
export * from "./repositories/reference.js";
export * from "./repositories/playback.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm vitest run packages/db/src/repositories/playback.test.ts
```

Expected: PASS, 10 tests. Pay particular attention to the last two — they are the proof that the nightly recompute genuinely corrects drift rather than compounding it.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "Add playback session and rollup repositories

Session writes accumulate watch time with SQL addition rather than assignment,
so concurrent touches cannot clobber each other, and opening an existing
session updates it instead of resetting its accumulated time.

A session with unknown runtime is never marked complete rather than dividing
by a missing value.

The rollup recompute deletes and rebuilds its date range inside a transaction,
which is what lets it drop rows whose sessions no longer exist instead of only
correcting rows that still do. Tests assert recomputed totals match what the
incremental path produced."
```

---

### Task 8: Jellyfin API client

The only module that knows Jellyfin's HTTP shape. Every response is validated with Zod, so a Jellyfin upgrade that changes a field fails loudly here instead of writing nulls into the database.

**Files:**
- Create: `packages/jellyfin/package.json`, `packages/jellyfin/tsconfig.json`, `packages/jellyfin/src/client.ts`, `packages/jellyfin/src/schemas.ts`, `packages/jellyfin/src/index.ts`
- Create: `packages/jellyfin/src/fixtures/sessions.json`, `packages/jellyfin/src/fixtures/users.json`
- Test: `packages/jellyfin/src/client.test.ts`

**Interfaces:**
- Consumes: `LiveSession`, `PlayMethod` from Task 3.
- Produces: `createJellyfinClient(options: JellyfinClientOptions): JellyfinClient` with methods `getSessions(): Promise<LiveSession[]>`, `getUsers(): Promise<JellyfinUser[]>`, `getLibraries(): Promise<JellyfinLibrary[]>`, `getItems(): Promise<JellyfinItem[]>`. Tasks 9 and 10 consume these. Plan 2 adds `authenticateByName` and `revokeToken` to this same client.

- [ ] **Step 1: Create the package**

`packages/jellyfin/package.json`:

```json
{
  "name": "@jfstats/jellyfin",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "build": "tsc --build" },
  "dependencies": {
    "@jfstats/shared": "workspace:*",
    "zod": "^3.24.1"
  }
}
```

`packages/jellyfin/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../shared" }]
}
```

Run `pnpm install`.

- [ ] **Step 2: Add scrubbed fixtures**

These contain **no real data** — fake GUIDs, fake names, RFC 5737 documentation IPs.

`packages/jellyfin/src/fixtures/sessions.json`:

```json
[
  {
    "Id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "PlaySessionId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "UserId": "11111111111111111111111111111111",
    "UserName": "test-user-one",
    "DeviceId": "cccccccccccccccccccccccccccccccc",
    "DeviceName": "Test Device",
    "Client": "Jellyfin Web",
    "RemoteEndPoint": "192.0.2.10",
    "PlayState": { "PositionTicks": 12000000000, "IsPaused": false, "PlayMethod": "DirectPlay" },
    "NowPlayingItem": {
      "Id": "22222222222222222222222222222222",
      "Name": "Test Episode",
      "Type": "Episode",
      "SeriesId": "33333333333333333333333333333333",
      "SeasonId": "44444444444444444444444444444444",
      "RunTimeTicks": 24000000000,
      "ProductionYear": 2024,
      "ImageTags": { "Primary": "abc123" }
    }
  },
  {
    "Id": "dddddddddddddddddddddddddddddddd",
    "PlaySessionId": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "UserId": "55555555555555555555555555555555",
    "UserName": "test-user-two",
    "DeviceId": "ffffffffffffffffffffffffffffffff",
    "DeviceName": "Test Phone",
    "Client": "Jellyfin Android",
    "RemoteEndPoint": "192.0.2.11",
    "PlayState": { "PositionTicks": 500000000, "IsPaused": true, "PlayMethod": "Transcode" }
  },
  {
    "Id": "99999999999999999999999999999999",
    "UserId": "55555555555555555555555555555555",
    "UserName": "test-user-two",
    "DeviceId": "88888888888888888888888888888888",
    "DeviceName": "Idle Browser",
    "Client": "Jellyfin Web",
    "PlayState": { "PositionTicks": 0, "IsPaused": false }
  }
]
```

The second entry is playing but has no `NowPlayingItem` in the payload — it must be dropped. The third is an idle session with no playback at all — also dropped.

`packages/jellyfin/src/fixtures/users.json`:

```json
[
  { "Id": "11111111111111111111111111111111", "Name": "test-user-one", "Policy": { "IsAdministrator": true } },
  { "Id": "55555555555555555555555555555555", "Name": "test-user-two", "Policy": { "IsAdministrator": false } }
]
```

- [ ] **Step 3: Write the failing test**

`packages/jellyfin/src/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionsFixture from "./fixtures/sessions.json" with { type: "json" };
import usersFixture from "./fixtures/users.json" with { type: "json" };
import { createJellyfinClient } from "./client.js";

function clientWith(payload: unknown, status = 200) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

  const client = createJellyfinClient({
    baseUrl: "http://jellyfin.test:8096",
    apiKey: "test-key",
    fetch: fetchMock as unknown as typeof fetch,
  });

  return { client, fetchMock };
}

afterEach(() => vi.restoreAllMocks());

describe("createJellyfinClient", () => {
  it("sends the api key as a header, never in the query string", async () => {
    const { client, fetchMock } = clientWith(sessionsFixture);
    await client.getSessions();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("test-key");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'MediaBrowser Token="test-key"',
    });
  });

  it("maps a playing session to the LiveSession shape", async () => {
    const { client } = clientWith(sessionsFixture);
    const sessions = await client.getSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      playSessionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      userId: "11111111111111111111111111111111",
      userName: "test-user-one",
      itemId: "22222222222222222222222222222222",
      itemName: "Test Episode",
      deviceId: "cccccccccccccccccccccccccccccccc",
      deviceName: "Test Device",
      client: "Jellyfin Web",
      playMethod: "DirectPlay",
      positionTicks: 12_000_000_000,
      runtimeTicks: 24_000_000_000,
      isPaused: false,
      remoteEndpoint: "192.0.2.10",
    });
  });

  it("drops sessions with no now-playing item", async () => {
    const { client } = clientWith(sessionsFixture);
    const sessions = await client.getSessions();

    expect(sessions.map((s) => s.userName)).toEqual(["test-user-one"]);
  });

  it("defaults an unrecognised play method to DirectPlay", async () => {
    const payload = [
      {
        ...sessionsFixture[0],
        PlayState: { PositionTicks: 1, IsPaused: false, PlayMethod: "SomethingNew" },
      },
    ];
    const { client } = clientWith(payload);

    expect((await client.getSessions())[0]?.playMethod).toBe("DirectPlay");
  });

  it("maps users including their administrator flag", async () => {
    const { client } = clientWith(usersFixture);
    const users = await client.getUsers();

    expect(users).toEqual([
      { id: "11111111111111111111111111111111", name: "test-user-one", isAdmin: true },
      { id: "55555555555555555555555555555555", name: "test-user-two", isAdmin: false },
    ]);
  });

  it("throws a message naming the status and endpoint on a failed request", async () => {
    const { client } = clientWith({ error: "nope" }, 401);

    await expect(client.getSessions()).rejects.toThrow(/401.*\/Sessions/);
  });

  it("throws when the response shape is not what we expect", async () => {
    const { client } = clientWith({ unexpected: true });

    await expect(client.getSessions()).rejects.toThrow(/Unexpected Jellyfin response/);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
pnpm vitest run packages/jellyfin/src/client.test.ts
```

Expected: FAIL — cannot resolve `./client.js`.

- [ ] **Step 5: Implement `schemas.ts`**

```ts
import { z } from "zod";

const playMethodSchema = z.enum(["DirectPlay", "DirectStream", "Transcode"]);

const nowPlayingItemSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Type: z.string(),
  SeriesId: z.string().nullish(),
  SeasonId: z.string().nullish(),
  RunTimeTicks: z.number().nullish(),
  ProductionYear: z.number().nullish(),
  ImageTags: z.object({ Primary: z.string().nullish() }).nullish(),
});

export const sessionSchema = z.object({
  PlaySessionId: z.string().nullish(),
  UserId: z.string().nullish(),
  UserName: z.string().nullish(),
  DeviceId: z.string().nullish(),
  DeviceName: z.string().nullish(),
  Client: z.string().nullish(),
  RemoteEndPoint: z.string().nullish(),
  PlayState: z
    .object({
      PositionTicks: z.number().nullish(),
      IsPaused: z.boolean().nullish(),
      // Unknown values are tolerated here and normalised by the client, so a new
      // Jellyfin play method does not break session capture entirely.
      PlayMethod: z.string().nullish(),
    })
    .nullish(),
  NowPlayingItem: nowPlayingItemSchema.nullish(),
});

export const sessionsSchema = z.array(sessionSchema);

export const userSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Policy: z.object({ IsAdministrator: z.boolean().nullish() }).nullish(),
});

export const usersSchema = z.array(userSchema);

export const librarySchema = z.object({
  ItemId: z.string(),
  Name: z.string(),
  CollectionType: z.string().nullish(),
});

export const librariesSchema = z.array(librarySchema);

export const itemsSchema = z.object({
  Items: z.array(nowPlayingItemSchema.extend({ ParentId: z.string().nullish() })),
  TotalRecordCount: z.number(),
});

export function normalisePlayMethod(value: string | null | undefined) {
  const parsed = playMethodSchema.safeParse(value);
  return parsed.success ? parsed.data : ("DirectPlay" as const);
}
```

- [ ] **Step 6: Implement `client.ts`**

```ts
import type { LiveSession } from "@jfstats/shared";
import type { z } from "zod";
import {
  itemsSchema,
  librariesSchema,
  normalisePlayMethod,
  sessionsSchema,
  usersSchema,
} from "./schemas.js";

export interface JellyfinClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Injected so tests never touch the network. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface JellyfinUser {
  id: string;
  name: string;
  isAdmin: boolean;
}

export interface JellyfinLibrary {
  id: string;
  name: string;
  collectionType: string | null;
}

export interface JellyfinItem {
  id: string;
  name: string;
  type: string;
  libraryId: string | null;
  seriesId: string | null;
  seasonId: string | null;
  productionYear: number | null;
  runtimeTicks: number | null;
  imageTag: string | null;
}

export interface JellyfinClient {
  getSessions(): Promise<LiveSession[]>;
  getUsers(): Promise<JellyfinUser[]>;
  getLibraries(): Promise<JellyfinLibrary[]>;
  getItems(): Promise<JellyfinItem[]>;
}

export function createJellyfinClient(options: JellyfinClientOptions): JellyfinClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function request<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.infer<S>> {
    const response = await doFetch(`${options.baseUrl}${path}`, {
      headers: {
        // The key goes in a header, never the query string, so it cannot leak
        // into access logs or browser history.
        Authorization: `MediaBrowser Token="${options.apiKey}"`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Jellyfin request failed: ${response.status} ${path}`);
    }

    const parsed = schema.safeParse(await response.json());

    if (!parsed.success) {
      throw new Error(`Unexpected Jellyfin response from ${path}: ${parsed.error.message}`);
    }

    return parsed.data;
  }

  return {
    async getSessions() {
      const raw = await request("/Sessions", sessionsSchema);

      return raw.flatMap((entry): LiveSession[] => {
        const item = entry.NowPlayingItem;
        // Idle sessions and sessions missing playback identity carry no history.
        if (!item || !entry.PlaySessionId || !entry.UserId) return [];

        return [
          {
            playSessionId: entry.PlaySessionId,
            userId: entry.UserId,
            userName: entry.UserName ?? "unknown",
            itemId: item.Id,
            itemName: item.Name,
            deviceId: entry.DeviceId ?? "unknown",
            deviceName: entry.DeviceName ?? "unknown",
            client: entry.Client ?? "unknown",
            playMethod: normalisePlayMethod(entry.PlayState?.PlayMethod),
            positionTicks: entry.PlayState?.PositionTicks ?? 0,
            runtimeTicks: item.RunTimeTicks ?? null,
            isPaused: entry.PlayState?.IsPaused ?? false,
            remoteEndpoint: entry.RemoteEndPoint ?? null,
          },
        ];
      });
    },

    async getUsers() {
      const raw = await request("/Users", usersSchema);
      return raw.map((user) => ({
        id: user.Id,
        name: user.Name,
        isAdmin: user.Policy?.IsAdministrator ?? false,
      }));
    },

    async getLibraries() {
      const raw = await request("/Library/VirtualFolders", librariesSchema);
      return raw.map((library) => ({
        id: library.ItemId,
        name: library.Name,
        collectionType: library.CollectionType ?? null,
      }));
    },

    async getItems() {
      const raw = await request(
        "/Items?Recursive=true&IncludeItemTypes=Movie,Episode,Audio&Fields=ParentId,ProductionYear&EnableImages=true",
        itemsSchema,
      );

      return raw.Items.map((item) => ({
        id: item.Id,
        name: item.Name,
        type: item.Type,
        libraryId: item.ParentId ?? null,
        seriesId: item.SeriesId ?? null,
        seasonId: item.SeasonId ?? null,
        productionYear: item.ProductionYear ?? null,
        runtimeTicks: item.RunTimeTicks ?? null,
        imageTag: item.ImageTags?.Primary ?? null,
      }));
    },
  };
}
```

`packages/jellyfin/src/index.ts`:

```ts
export {
  createJellyfinClient,
  type JellyfinClient,
  type JellyfinClientOptions,
  type JellyfinItem,
  type JellyfinLibrary,
  type JellyfinUser,
} from "./client.js";
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
pnpm vitest run packages/jellyfin/src/client.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 8: Verify against the real server**

Ask Matt for `JELLYFIN_URL` and `JELLYFIN_API_KEY` and put them in your local `.env` (already gitignored). Then:

```bash
node --env-file=.env -e "const {createJellyfinClient}=await import('./packages/jellyfin/src/client.ts');const c=createJellyfinClient({baseUrl:process.env.JELLYFIN_URL,apiKey:process.env.JELLYFIN_API_KEY});console.log(JSON.stringify(await c.getLibraries(),null,2))"
```

Expected: your real library list. If Zod throws `Unexpected Jellyfin response`, the server's shape differs from the schema — **update the schema to match the real server, then re-record the fixture with all identifiers and IPs scrubbed.** Do not commit real values.

- [ ] **Step 9: Commit**

```bash
git add packages/jellyfin pnpm-lock.yaml
git commit -m "Add validated Jellyfin API client

Isolates all knowledge of Jellyfin's HTTP shape behind one module and validates
every response with Zod, so an upgrade that changes a field fails loudly here
rather than writing nulls into the database.

The API key travels in an Authorization header rather than the query string so
it cannot leak into access logs. Idle sessions and sessions missing playback
identity are dropped, and an unrecognised play method degrades to DirectPlay
rather than failing the whole poll.

Fixtures use fabricated identifiers and RFC 5737 documentation addresses."
```

---

### Task 9: The session applier

The impure shell around Task 4's reducer: takes events, writes them to Postgres, maintains the Redis snapshot, and publishes live updates.

**Files:**
- Create: `apps/server/src/sync/applier.ts`, `apps/server/src/sync/snapshot-store.ts`
- Modify: `apps/server/package.json`
- Test: `apps/server/src/sync/applier.test.ts`

**Interfaces:**
- Consumes: `diffSessions`, `snapshotKey` (Task 4); `openSession`, `touchSession`, `closeSession`, `applyRollupDelta`, `upsertDevice` (Tasks 6–7); `Db` (Task 5).
- Produces:
  - `createSnapshotStore(redis: Redis): SnapshotStore` with `load(): Promise<SessionSnapshot>`, `save(snapshot: SessionSnapshot): Promise<void>`, `publish(sessions: LiveSession[]): Promise<void>`
  - `applyEvents(deps: ApplierDeps, events: SessionEvent[], liveById: Map<string, LiveSession>): Promise<void>`
  - `runSessionPoll(deps: PollDeps): Promise<void>` — the whole cycle. Task 11's scheduler calls this.

- [ ] **Step 1: Add runtime dependencies**

Add to `apps/server/package.json` dependencies, then run `pnpm install`:

```json
{
  "@jfstats/db": "workspace:*",
  "@jfstats/jellyfin": "workspace:*",
  "@jfstats/shared": "workspace:*",
  "bullmq": "^5.34.2",
  "ioredis": "^5.4.2"
}
```

Add `{ "path": "../../packages/db" }` and `{ "path": "../../packages/jellyfin" }` to the `references` array in `apps/server/tsconfig.json`.

- [ ] **Step 2: Implement the snapshot store**

`apps/server/src/sync/snapshot-store.ts`:

```ts
import type { LiveSession, SessionSnapshot } from "@jfstats/shared";
import type Redis from "ioredis";

const SNAPSHOT_KEY = "jfstats:sessions:snapshot";
export const LIVE_CHANNEL = "jfstats:sessions:live";

export interface SnapshotStore {
  load(): Promise<SessionSnapshot>;
  save(snapshot: SessionSnapshot): Promise<void>;
  publish(sessions: LiveSession[]): Promise<void>;
}

/**
 * Redis holds the between-poll snapshot purely as a cache. Losing it costs at most
 * one poll interval of watch time, because Postgres remains the source of truth and
 * startup reconciliation repairs anything left open.
 */
export function createSnapshotStore(redis: Redis, ttlSeconds = 3600): SnapshotStore {
  return {
    async load() {
      const raw = await redis.get(SNAPSHOT_KEY);
      if (raw === null) return {};

      try {
        return JSON.parse(raw) as SessionSnapshot;
      } catch {
        // A corrupt cache must not stop playback capture.
        return {};
      }
    },

    async save(snapshot) {
      await redis.set(SNAPSHOT_KEY, JSON.stringify(snapshot), "EX", ttlSeconds);
    },

    async publish(sessions) {
      await redis.publish(LIVE_CHANNEL, JSON.stringify(sessions));
    },
  };
}
```

- [ ] **Step 3: Write the failing test**

`apps/server/src/sync/applier.test.ts`:

```ts
import type { LiveSession } from "@jfstats/shared";
import { describe, expect, it, vi } from "vitest";
import { applyEvents, type ApplierDeps } from "./applier.js";
import { snapshotKey } from "./diff.js";

const AT = new Date("2026-08-16T20:00:00Z");

function live(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    playSessionId: "ps-1",
    userId: "user-1",
    userName: "alice",
    itemId: "item-1",
    itemName: "The Movie",
    deviceId: "device-1",
    deviceName: "Living Room TV",
    client: "Jellyfin Web",
    playMethod: "DirectPlay",
    positionTicks: 90,
    runtimeTicks: 100,
    isPaused: false,
    remoteEndpoint: "192.0.2.10",
    ...overrides,
  };
}

function deps() {
  const calls: ApplierDeps = {
    db: {} as ApplierDeps["db"],
    completionThreshold: 0.9,
    openSession: vi.fn(async () => {}),
    touchSession: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
    applyRollupDelta: vi.fn(async () => {}),
    upsertDevice: vi.fn(async () => {}),
  };
  return calls;
}

describe("applyEvents", () => {
  it("opens a session and registers its device on started", async () => {
    const d = deps();
    const session = live();
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(d, [{ type: "started", key, session, at: AT.getTime() }], new Map([[key, session]]));

    expect(d.openSession).toHaveBeenCalledWith(d.db, expect.objectContaining({
      playSessionId: "ps-1",
      itemId: "item-1",
      userId: "user-1",
      playMethod: "DirectPlay",
    }));
    expect(d.upsertDevice).toHaveBeenCalledWith(d.db, expect.objectContaining({ id: "device-1" }));
  });

  it("writes no rollup on started, because nothing has been watched yet", async () => {
    const d = deps();
    const session = live();
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(d, [{ type: "started", key, session, at: AT.getTime() }], new Map([[key, session]]));

    expect(d.applyRollupDelta).not.toHaveBeenCalled();
  });

  it("accumulates watch time and rolls it up on progressed", async () => {
    const d = deps();
    const session = live();
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(
      d,
      [{ type: "progressed", key, positionTicks: 50, watchedMs: 5_000, at: AT.getTime() }],
      new Map([[key, session]]),
    );

    expect(d.touchSession).toHaveBeenCalledWith(d.db, expect.objectContaining({ watchedMs: 5_000, isPaused: false }));
    expect(d.applyRollupDelta).toHaveBeenCalledWith(d.db, expect.objectContaining({
      day: "2026-08-16",
      userId: "user-1",
      itemId: "item-1",
      playCount: 0,
      watchMs: 5_000,
    }));
  });

  it("skips the rollup write when no time was credited", async () => {
    const d = deps();
    const session = live();
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(
      d,
      [{ type: "progressed", key, positionTicks: 50, watchedMs: 0, at: AT.getTime() }],
      new Map([[key, session]]),
    );

    // A paused stream polled every 5 seconds must not generate a write per poll.
    expect(d.applyRollupDelta).not.toHaveBeenCalled();
  });

  it("counts the play exactly once, on ended", async () => {
    const d = deps();
    const session = live();
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(
      d,
      [{ type: "ended", key, positionTicks: 95, watchedMs: 2_000, at: AT.getTime() }],
      new Map([[key, session]]),
    );

    expect(d.closeSession).toHaveBeenCalledWith(d.db, expect.objectContaining({
      runtimeTicks: 100,
      completionThreshold: 0.9,
    }));
    expect(d.applyRollupDelta).toHaveBeenCalledWith(d.db, expect.objectContaining({ playCount: 1, watchMs: 2_000 }));
  });

  it("still closes a session whose live details are already gone", async () => {
    const d = deps();
    const key = snapshotKey("ps-1", "item-1");

    // The stream vanished, so it is absent from the incoming payload — the common case.
    await applyEvents(d, [{ type: "ended", key, positionTicks: 95, watchedMs: 2_000, at: AT.getTime() }], new Map());

    expect(d.closeSession).toHaveBeenCalledWith(d.db, expect.objectContaining({
      playSessionId: "ps-1",
      itemId: "item-1",
      runtimeTicks: null,
    }));
  });

  it("marks the session paused without crediting time", async () => {
    const d = deps();
    const session = live({ isPaused: true });
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(
      d,
      [{ type: "paused", key, positionTicks: 60, watchedMs: 5_000, at: AT.getTime() }],
      new Map([[key, session]]),
    );

    expect(d.touchSession).toHaveBeenCalledWith(d.db, expect.objectContaining({ isPaused: true, watchedMs: 5_000 }));
  });

  it("attributes watch time to the UTC day the poll occurred", async () => {
    const d = deps();
    const session = live();
    const key = snapshotKey("ps-1", "item-1");
    const justBeforeMidnight = new Date("2026-08-16T23:59:59Z").getTime();

    await applyEvents(
      d,
      [{ type: "progressed", key, positionTicks: 50, watchedMs: 5_000, at: justBeforeMidnight }],
      new Map([[key, session]]),
    );

    expect(d.applyRollupDelta).toHaveBeenCalledWith(d.db, expect.objectContaining({ day: "2026-08-16" }));
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
pnpm vitest run apps/server/src/sync/applier.test.ts
```

Expected: FAIL — cannot resolve `./applier.js`.

- [ ] **Step 5: Implement `applier.ts`**

```ts
import type {
  applyRollupDelta as ApplyRollupDelta,
  closeSession as CloseSession,
  Db,
  openSession as OpenSession,
  touchSession as TouchSession,
  upsertDevice as UpsertDevice,
} from "@jfstats/db";
import type { JellyfinClient } from "@jfstats/jellyfin";
import type { LiveSession, SessionEvent } from "@jfstats/shared";
import { diffSessions, snapshotKey } from "./diff.js";
import type { SnapshotStore } from "./snapshot-store.js";

export interface ApplierDeps {
  db: Db;
  completionThreshold: number;
  openSession: typeof OpenSession;
  touchSession: typeof TouchSession;
  closeSession: typeof CloseSession;
  applyRollupDelta: typeof ApplyRollupDelta;
  upsertDevice: typeof UpsertDevice;
}

/** Splits `${playSessionId}:${itemId}` back into its parts. */
function parseKey(key: string): { playSessionId: string; itemId: string } {
  const separator = key.lastIndexOf(":");
  return { playSessionId: key.slice(0, separator), itemId: key.slice(separator + 1) };
}

function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export async function applyEvents(
  deps: ApplierDeps,
  events: SessionEvent[],
  liveByKey: Map<string, LiveSession>,
): Promise<void> {
  for (const event of events) {
    const { playSessionId, itemId } = parseKey(event.key);
    const live = liveByKey.get(event.key);
    const at = new Date(event.at);

    switch (event.type) {
      case "started": {
        await deps.upsertDevice(deps.db, {
          id: event.session.deviceId,
          name: event.session.deviceName,
          client: event.session.client,
          lastSeenAt: at,
        });
        await deps.openSession(deps.db, {
          playSessionId,
          itemId,
          userId: event.session.userId,
          deviceId: event.session.deviceId,
          client: event.session.client,
          playMethod: event.session.playMethod,
          positionTicks: event.session.positionTicks,
          remoteEndpoint: event.session.remoteEndpoint,
          at,
        });
        // No rollup here: the play is counted once, when the session ends.
        break;
      }

      case "resumed": {
        await deps.touchSession(deps.db, {
          playSessionId,
          itemId,
          positionTicks: event.positionTicks,
          watchedMs: 0,
          isPaused: false,
          at,
        });
        break;
      }

      case "progressed":
      case "paused": {
        await deps.touchSession(deps.db, {
          playSessionId,
          itemId,
          positionTicks: event.positionTicks,
          watchedMs: event.watchedMs,
          isPaused: event.type === "paused",
          at,
        });

        if (event.watchedMs > 0 && live) {
          await deps.applyRollupDelta(deps.db, {
            day: utcDay(event.at),
            userId: live.userId,
            itemId,
            libraryId: null,
            playCount: 0,
            watchMs: event.watchedMs,
          });
        }
        break;
      }

      case "ended": {
        await deps.closeSession(deps.db, {
          playSessionId,
          itemId,
          positionTicks: event.positionTicks,
          // The stream is usually already absent from the payload by the time it ends,
          // so runtime is unknown and the session is simply not marked complete.
          runtimeTicks: live?.runtimeTicks ?? null,
          watchedMs: event.watchedMs,
          completionThreshold: deps.completionThreshold,
          at,
        });

        if (live) {
          await deps.applyRollupDelta(deps.db, {
            day: utcDay(event.at),
            userId: live.userId,
            itemId,
            libraryId: null,
            playCount: 1,
            watchMs: event.watchedMs,
          });
        }
        break;
      }
    }
  }
}

export interface PollDeps extends ApplierDeps {
  jellyfin: JellyfinClient;
  snapshots: SnapshotStore;
  maxWatchDeltaMs: number;
  now?: () => number;
}

export async function runSessionPoll(deps: PollDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const incoming = await deps.jellyfin.getSessions();
  const previous = await deps.snapshots.load();

  const { events, snapshot } = diffSessions(previous, incoming, {
    now,
    maxWatchDeltaMs: deps.maxWatchDeltaMs,
  });

  const liveByKey = new Map(
    incoming.map((session) => [snapshotKey(session.playSessionId, session.itemId), session]),
  );

  await applyEvents(deps, events, liveByKey);

  // Snapshot is saved only after the writes land, so a crash mid-apply replays the
  // same interval rather than skipping it.
  await deps.snapshots.save(snapshot);
  await deps.snapshots.publish(incoming);
}
```

**Note on `ended` rollups:** when a stream vanishes, `live` is `undefined`, so the `playCount: 1` rollup is skipped. That looks like a bug but is not — Task 10's reconciliation and the nightly `recomputeRollupRange` both rebuild from `playback_sessions`, which always has the closed row. The incremental path is an optimisation; the recompute is the correctness guarantee. The two tests in Task 7 asserting they agree are what proves it.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm vitest run apps/server/src/sync/applier.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/server pnpm-lock.yaml
git commit -m "Add session applier and Redis snapshot store

Wraps the pure reducer in the impure shell that writes events to Postgres,
maintains the between-poll snapshot, and publishes live sessions for the SSE
feed added in Plan 2.

Rollup writes are skipped when no time was credited, so a paused stream polled
every five seconds does not generate a database write per poll. A play is
counted once, when the session ends, never on start.

The snapshot is saved only after writes land, so a crash mid-apply replays the
interval rather than silently skipping it. A corrupt snapshot degrades to empty
rather than halting playback capture."
```

---

### Task 10: Startup reconciliation and reference sync

Two jobs: repairing sessions left open by a crash, and refreshing users/libraries/items.

**Files:**
- Create: `apps/server/src/sync/reconcile.ts`, `apps/server/src/sync/reference-sync.ts`
- Test: `apps/server/src/sync/reconcile.test.ts`

**Interfaces:**
- Consumes: `findStaleOpenSessions`, `closeSession` (Task 7); `upsertUsers`, `upsertLibraries`, `upsertItems`, `archiveMissingItems` (Task 6); `JellyfinClient` (Task 8).
- Produces:
  - `reconcileOpenSessions(deps: ReconcileDeps): Promise<number>` — returns how many were closed.
  - `runReferenceSync(deps: ReferenceSyncDeps): Promise<void>`

  Task 11's worker calls `reconcileOpenSessions` once at boot and schedules `runReferenceSync`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/sync/reconcile.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { reconcileOpenSessions, type ReconcileDeps } from "./reconcile.js";

const NOW = new Date("2026-08-16T20:00:00Z").getTime();

function deps(stale: Awaited<ReturnType<ReconcileDeps["findStaleOpenSessions"]>>): ReconcileDeps {
  return {
    db: {} as ReconcileDeps["db"],
    staleAfterMs: 10_000,
    completionThreshold: 0.9,
    now: () => NOW,
    findStaleOpenSessions: vi.fn(async () => stale),
    closeSession: vi.fn(async () => {}),
  };
}

describe("reconcileOpenSessions", () => {
  it("closes a session left open by a crash, at the time it was last seen", async () => {
    const lastSeenAt = new Date(NOW - 60_000);
    const d = deps([
      { playSessionId: "ps-1", itemId: "item-1", userId: "user-1", positionTicks: 42, lastSeenAt },
    ]);

    const closed = await reconcileOpenSessions(d);

    expect(closed).toBe(1);
    expect(d.closeSession).toHaveBeenCalledWith(d.db, expect.objectContaining({
      playSessionId: "ps-1",
      itemId: "item-1",
      // Ending at lastSeenAt, not now, keeps the record honest — we have no evidence
      // playback continued past the last observation.
      at: lastSeenAt,
      watchedMs: 0,
    }));
  });

  it("queries using the stale cutoff derived from the poll interval", async () => {
    const d = deps([]);
    await reconcileOpenSessions(d);

    expect(d.findStaleOpenSessions).toHaveBeenCalledWith(d.db, new Date(NOW - 10_000));
  });

  it("does nothing when no sessions are stale", async () => {
    const d = deps([]);

    expect(await reconcileOpenSessions(d)).toBe(0);
    expect(d.closeSession).not.toHaveBeenCalled();
  });

  it("credits no extra watch time when closing a stale session", async () => {
    const d = deps([
      { playSessionId: "ps-1", itemId: "item-1", userId: "user-1", positionTicks: 42, lastSeenAt: new Date(NOW - 3_600_000) },
    ]);

    await reconcileOpenSessions(d);

    // An hour passed with the worker down; none of it was observed playback.
    expect(d.closeSession).toHaveBeenCalledWith(d.db, expect.objectContaining({ watchedMs: 0 }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run apps/server/src/sync/reconcile.test.ts
```

Expected: FAIL — cannot resolve `./reconcile.js`.

- [ ] **Step 3: Implement `reconcile.ts`**

```ts
import type {
  closeSession as CloseSession,
  Db,
  findStaleOpenSessions as FindStaleOpenSessions,
} from "@jfstats/db";

export interface ReconcileDeps {
  db: Db;
  staleAfterMs: number;
  completionThreshold: number;
  now?: () => number;
  findStaleOpenSessions: typeof FindStaleOpenSessions;
  closeSession: typeof CloseSession;
}

/**
 * Closes sessions left open by a crash or restart. Postgres is the source of truth,
 * so this runs at boot before any polling and repairs whatever the previous process
 * left behind.
 */
export async function reconcileOpenSessions(deps: ReconcileDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const cutoff = new Date(now - deps.staleAfterMs);
  const stale = await deps.findStaleOpenSessions(deps.db, cutoff);

  for (const session of stale) {
    await deps.closeSession(deps.db, {
      playSessionId: session.playSessionId,
      itemId: session.itemId,
      positionTicks: session.positionTicks,
      // Runtime is unknown here, so the session is never marked complete by
      // reconciliation — we are repairing a record, not inferring a viewing.
      runtimeTicks: null,
      watchedMs: 0,
      completionThreshold: deps.completionThreshold,
      at: session.lastSeenAt,
    });
  }

  return stale.length;
}
```

- [ ] **Step 4: Implement `reference-sync.ts`**

```ts
import type {
  archiveMissingItems as ArchiveMissingItems,
  Db,
  upsertItems as UpsertItems,
  upsertLibraries as UpsertLibraries,
  upsertUsers as UpsertUsers,
} from "@jfstats/db";
import type { JellyfinClient } from "@jfstats/jellyfin";

export interface ReferenceSyncDeps {
  db: Db;
  jellyfin: JellyfinClient;
  upsertUsers: typeof UpsertUsers;
  upsertLibraries: typeof UpsertLibraries;
  upsertItems: typeof UpsertItems;
  archiveMissingItems: typeof ArchiveMissingItems;
  /** Item sync is expensive; the 15-minute cycle skips it. */
  includeItems: boolean;
}

export async function runReferenceSync(deps: ReferenceSyncDeps): Promise<void> {
  const [users, libraries] = await Promise.all([
    deps.jellyfin.getUsers(),
    deps.jellyfin.getLibraries(),
  ]);

  await deps.upsertUsers(deps.db, users);
  await deps.upsertLibraries(
    deps.db,
    libraries.map((library) => ({
      id: library.id,
      name: library.name,
      collectionType: library.collectionType,
    })),
  );

  if (!deps.includeItems) return;

  const items = await deps.jellyfin.getItems();
  await deps.upsertItems(deps.db, items);
  await deps.archiveMissingItems(
    deps.db,
    items.map((item) => item.id),
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm vitest run apps/server/src/sync/reconcile.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "Add startup reconciliation and reference sync

Sessions left open by a crash are closed at their last observed time rather
than the current time, since there is no evidence playback continued past the
last observation, and no watch time is credited for the unobserved gap.

Reconciliation never marks a session complete — it repairs a record rather than
inferring a viewing that was not seen.

Reference sync refreshes users and libraries on the frequent cycle and defers
the expensive item sync to the nightly run."
```

---

### Task 11: Worker entrypoint and job scheduling

Wires everything into a running process with BullMQ, ensuring only one poller runs even if the worker is scaled.

**Files:**
- Create: `apps/server/src/worker.ts`, `apps/server/src/logger.ts`, `apps/server/src/context.ts`
- Modify: `apps/server/package.json`
- Test: `apps/server/src/context.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–10.
- Produces: `createContext(env: AppEnv): AppContext` holding `{ env, db, pool, redis, jellyfin, snapshots, logger }`, and a runnable worker via `pnpm --filter @jfstats/server dev:worker`. Plan 2's API entrypoint reuses `createContext`.

- [ ] **Step 1: Add dependencies and scripts**

Add `"pino": "^9.5.0"` and `"pino-pretty": "^13.0.0"` to `apps/server` dependencies, plus scripts:

```json
{
  "scripts": {
    "build": "tsc --build",
    "dev:worker": "node --env-file=../../.env --experimental-strip-types src/worker.ts"
  }
}
```

Run `pnpm install`.

- [ ] **Step 2: Implement the logger**

`apps/server/src/logger.ts`:

```ts
import pino, { type DestinationStream } from "pino";

/**
 * `destination` is injected only so tests can assert against the bytes actually
 * written. Production callers pass nothing and get stdout.
 */
export function createLogger(level: string, destination?: DestinationStream) {
  const options = {
    level,
    // Never let a Jellyfin key reach the logs, whatever object gets logged.
    redact: {
      paths: ["apiKey", "JELLYFIN_API_KEY", "SESSION_SECRET", "*.apiKey", "headers.authorization"],
      censor: "[redacted]",
    },
  };

  return destination === undefined ? pino(options) : pino(options, destination);
}

export type Logger = ReturnType<typeof createLogger>;
```

- [ ] **Step 3: Write the failing test**

`apps/server/src/context.test.ts` — redaction is asserted by capturing pino's output
stream, because the only thing worth proving is that the key never reaches the bytes
that get written:

```ts
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });

  // The real factory, not a copy of its config — otherwise this test would pass
  // even if logger.ts had no redaction at all.
  return { logger: createLogger("info", destination), lines };
}

describe("logger redaction", () => {
  it("never writes a Jellyfin api key to the log", () => {
    const { logger, lines } = captureLogger();

    logger.info({ apiKey: "super-secret-key" }, "connecting");

    expect(lines.join("")).not.toContain("super-secret-key");
    expect(lines.join("")).toContain("[redacted]");
  });

  it("redacts a nested api key", () => {
    const { logger, lines } = captureLogger();

    logger.info({ jellyfin: { apiKey: "super-secret-key" } }, "connecting");

    expect(lines.join("")).not.toContain("super-secret-key");
  });

  it("redacts an authorization header", () => {
    const { logger, lines } = captureLogger();

    logger.info({ headers: { authorization: 'MediaBrowser Token="super-secret-key"' } }, "request");

    expect(lines.join("")).not.toContain("super-secret-key");
  });
});
```

- [ ] **Step 4: Run the test**

```bash
pnpm vitest run apps/server/src/context.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Implement the context**

`apps/server/src/context.ts`:

```ts
import { createDb, type Db } from "@jfstats/db";
import { createJellyfinClient, type JellyfinClient } from "@jfstats/jellyfin";
import type { AppEnv } from "@jfstats/shared";
import Redis from "ioredis";
import type pg from "pg";
import { createLogger, type Logger } from "./logger.js";
import { createSnapshotStore, type SnapshotStore } from "./sync/snapshot-store.js";

export interface AppContext {
  env: AppEnv;
  db: Db;
  pool: pg.Pool;
  redis: Redis;
  jellyfin: JellyfinClient;
  snapshots: SnapshotStore;
  logger: Logger;
}

export function createContext(env: AppEnv): AppContext {
  const { db, pool } = createDb(env.DATABASE_URL);
  // BullMQ requires this setting on its connections.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  return {
    env,
    db,
    pool,
    redis,
    jellyfin: createJellyfinClient({ baseUrl: env.JELLYFIN_URL, apiKey: env.JELLYFIN_API_KEY }),
    snapshots: createSnapshotStore(redis),
    logger: createLogger(env.LOG_LEVEL),
  };
}

export async function closeContext(context: AppContext): Promise<void> {
  await context.redis.quit();
  await context.pool.end();
}
```

- [ ] **Step 6: Implement the worker entrypoint**

`apps/server/src/worker.ts`:

```ts
import {
  applyRollupDelta,
  archiveMissingItems,
  closeSession,
  findStaleOpenSessions,
  openSession,
  recomputeRollupRange,
  touchSession,
  upsertDevice,
  upsertItems,
  upsertLibraries,
  upsertUsers,
} from "@jfstats/db";
import { loadEnv } from "@jfstats/shared";
import { Queue, Worker } from "bullmq";
import { closeContext, createContext, type AppContext } from "./context.js";
import { runSessionPoll } from "./sync/applier.js";
import { reconcileOpenSessions } from "./sync/reconcile.js";
import { runReferenceSync } from "./sync/reference-sync.js";

const QUEUE_NAME = "jfstats-sync";

type JobName = "session-poll" | "reference-sync" | "item-sync" | "rollup-recompute";

async function handle(context: AppContext, name: JobName): Promise<void> {
  switch (name) {
    case "session-poll":
      await runSessionPoll({
        db: context.db,
        jellyfin: context.jellyfin,
        snapshots: context.snapshots,
        completionThreshold: context.env.COMPLETION_THRESHOLD,
        maxWatchDeltaMs: context.env.maxWatchDeltaMs,
        openSession,
        touchSession,
        closeSession,
        applyRollupDelta,
        upsertDevice,
      });
      return;

    case "reference-sync":
    case "item-sync":
      await runReferenceSync({
        db: context.db,
        jellyfin: context.jellyfin,
        upsertUsers,
        upsertLibraries,
        upsertItems,
        archiveMissingItems,
        includeItems: name === "item-sync",
      });
      return;

    case "rollup-recompute": {
      // Trailing 7 days, per the spec's drift correction.
      const to = new Date();
      const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
      await recomputeRollupRange(context.db, from, to);
      return;
    }
  }
}

async function main(): Promise<void> {
  const context = createContext(loadEnv());
  const { logger, env } = context;

  logger.info({ pollIntervalMs: env.SESSION_POLL_INTERVAL_MS }, "worker starting");

  const repaired = await reconcileOpenSessions({
    db: context.db,
    staleAfterMs: env.staleSessionAfterMs,
    completionThreshold: env.COMPLETION_THRESHOLD,
    findStaleOpenSessions,
    closeSession,
  });
  logger.info({ repaired }, "startup reconciliation complete");

  const queue = new Queue(QUEUE_NAME, { connection: context.redis });

  // Repeatable jobs are keyed by name, so re-registering on every boot replaces the
  // schedule rather than stacking duplicates.
  await queue.upsertJobScheduler("session-poll", { every: env.SESSION_POLL_INTERVAL_MS });
  await queue.upsertJobScheduler("reference-sync", { every: env.REFERENCE_SYNC_INTERVAL_MS });
  await queue.upsertJobScheduler("item-sync", { pattern: "0 3 * * *" });
  await queue.upsertJobScheduler("rollup-recompute", { pattern: "30 3 * * *" });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => handle(context, job.name as JobName),
    {
      connection: context.redis,
      // One poll at a time. Concurrent polls would diff against the same snapshot
      // and double-count the interval.
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error({ job: job?.name, err: error }, "sync job failed");
  });

  const shutdown = async (): Promise<void> => {
    logger.info("worker shutting down");
    await worker.close();
    await queue.close();
    await closeContext(context);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

await main();
```

- [ ] **Step 7: Run the worker against the real server**

With `docker compose up -d` running and a local `.env` containing Matt's real Jellyfin URL and key:

```bash
pnpm --filter @jfstats/db migrate:push
pnpm --filter @jfstats/server dev:worker
```

Expected: logs `worker starting` then `startup reconciliation complete`. Start playing something on Jellyfin, wait 15 seconds, then in another terminal:

```bash
docker compose exec postgres psql -U jfstats -d jfstats -c "SELECT play_session_id, user_id, item_id, watch_ms, is_paused FROM playback_sessions ORDER BY started_at DESC LIMIT 5;"
```

Expected: a row for what you are playing, with `watch_ms` increasing on repeat queries. Pause playback and confirm `watch_ms` stops growing while `is_paused` becomes true.

- [ ] **Step 8: Commit**

```bash
git add apps/server pnpm-lock.yaml
git commit -m "Add worker entrypoint with scheduled sync jobs

Runs startup reconciliation before any polling so a previous crash is repaired
first, then registers repeatable jobs for session polling, reference sync,
nightly item sync, and the nightly rollup recompute.

Poll concurrency is pinned to one: concurrent polls would diff against the same
snapshot and double-count the interval. Job schedulers are upserted by name so
restarting replaces the schedule rather than stacking duplicates.

Logs redact the Jellyfin api key and session secret."
```

---

### Task 12: Seed script

Generates plausible fake history so the dashboard in Plan 3 is demoable and testable without touching a live server.

**Files:**
- Create: `apps/server/src/seed.ts`
- Modify: `apps/server/package.json`
- Test: `apps/server/src/seed.test.ts`

**Interfaces:**
- Consumes: repositories from Tasks 6–7.
- Produces: `generateSeedData(options: SeedOptions): SeedData` (pure), and `pnpm --filter @jfstats/server seed`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/seed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateSeedData } from "./seed.js";

describe("generateSeedData", () => {
  it("is deterministic for a given seed", () => {
    const a = generateSeedData({ days: 30, users: 4, items: 50, seed: 42 });
    const b = generateSeedData({ days: 30, users: 4, items: 50, seed: 42 });

    expect(a).toEqual(b);
  });

  it("produces the requested number of users and items", () => {
    const data = generateSeedData({ days: 10, users: 4, items: 25, seed: 1 });

    expect(data.users).toHaveLength(4);
    expect(data.items).toHaveLength(25);
  });

  it("generates sessions only within the requested window", () => {
    const data = generateSeedData({ days: 7, users: 2, items: 10, seed: 1 });
    const earliest = Math.min(...data.sessions.map((s) => s.startedAt.getTime()));

    expect(Date.now() - earliest).toBeLessThanOrEqual(8 * 24 * 60 * 60 * 1000);
  });

  it("gives every session a unique play session and item pair", () => {
    const data = generateSeedData({ days: 30, users: 4, items: 50, seed: 7 });
    const keys = data.sessions.map((s) => `${s.playSessionId}:${s.itemId}`);

    // The unique index would reject duplicates, so the generator must not emit any.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("closes every generated session", () => {
    const data = generateSeedData({ days: 7, users: 2, items: 10, seed: 3 });

    expect(data.sessions.every((s) => s.endedAt !== null)).toBe(true);
  });

  it("never generates negative watch time", () => {
    const data = generateSeedData({ days: 30, users: 4, items: 50, seed: 9 });

    expect(data.sessions.every((s) => s.watchMs >= 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run apps/server/src/seed.test.ts
```

Expected: FAIL — cannot resolve `./seed.js`.

- [ ] **Step 3: Implement `seed.ts`**

```ts
import { createDb, playbackSessions, recomputeRollupRange, upsertItems, upsertLibraries, upsertUsers } from "@jfstats/db";
import { loadEnv } from "@jfstats/shared";

export interface SeedOptions {
  days: number;
  users: number;
  items: number;
  seed: number;
}

export interface SeedData {
  users: { id: string; name: string; isAdmin: boolean }[];
  libraries: { id: string; name: string; collectionType: string }[];
  items: { id: string; name: string; type: string; libraryId: string; runtimeTicks: number }[];
  sessions: {
    playSessionId: string;
    itemId: string;
    userId: string;
    deviceId: string;
    client: string;
    playMethod: string;
    startedAt: Date;
    endedAt: Date;
    lastSeenAt: Date;
    watchMs: number;
    positionTicks: number;
    completed: boolean;
  }[];
}

/** Deterministic PRNG so a given seed always produces the same dataset. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLIENTS = ["Jellyfin Web", "Jellyfin Android", "Jellyfin Roku", "Infuse"];
const PLAY_METHODS = ["DirectPlay", "DirectStream", "Transcode"];

export function generateSeedData(options: SeedOptions): SeedData {
  const random = mulberry32(options.seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;

  const libraries = [
    { id: "seed-lib-movies", name: "Movies", collectionType: "movies" },
    { id: "seed-lib-shows", name: "TV Shows", collectionType: "tvshows" },
  ];

  const users = Array.from({ length: options.users }, (_, index) => ({
    id: `seed-user-${index}`,
    name: `demo-user-${index}`,
    isAdmin: index === 0,
  }));

  const items = Array.from({ length: options.items }, (_, index) => {
    const library = libraries[index % libraries.length] as (typeof libraries)[number];
    return {
      id: `seed-item-${index}`,
      name: `${library.collectionType === "movies" ? "Demo Movie" : "Demo Episode"} ${index + 1}`,
      type: library.collectionType === "movies" ? "Movie" : "Episode",
      libraryId: library.id,
      // 20 to 140 minutes, in ticks (10,000 ticks per millisecond).
      runtimeTicks: Math.floor((20 + random() * 120) * 60 * 1000 * 10_000),
    };
  });

  const sessions: SeedData["sessions"] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  let counter = 0;

  for (let dayOffset = options.days; dayOffset > 0; dayOffset -= 1) {
    // Weekends get more viewing, so the trend charts have visible shape.
    const dayStart = Date.now() - dayOffset * dayMs;
    const isWeekend = [0, 6].includes(new Date(dayStart).getUTCDay());
    const playsToday = Math.floor(random() * (isWeekend ? 12 : 6));

    for (let play = 0; play < playsToday; play += 1) {
      const user = pick(users);
      const item = pick(items);
      const startedAt = new Date(dayStart + Math.floor(random() * dayMs));
      const runtimeMs = item.runtimeTicks / 10_000;
      // Most plays finish; some are abandoned early.
      const fraction = random() < 0.7 ? 0.9 + random() * 0.1 : random() * 0.6;
      const watchMs = Math.floor(runtimeMs * fraction);

      counter += 1;
      sessions.push({
        playSessionId: `seed-ps-${counter}`,
        itemId: item.id,
        userId: user.id,
        deviceId: `seed-device-${user.id}`,
        client: pick(CLIENTS),
        playMethod: pick(PLAY_METHODS),
        startedAt,
        endedAt: new Date(startedAt.getTime() + watchMs),
        lastSeenAt: new Date(startedAt.getTime() + watchMs),
        watchMs,
        positionTicks: Math.floor(item.runtimeTicks * fraction),
        completed: fraction >= 0.9,
      });
    }
  }

  return { users, libraries, items, sessions };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);
  const data = generateSeedData({ days: 90, users: 4, items: 60, seed: 42 });

  try {
    await upsertUsers(db, data.users);
    await upsertLibraries(db, data.libraries);
    await upsertItems(db, data.items);
    await db.insert(playbackSessions).values(data.sessions).onConflictDoNothing();

    // Build the rollup from the sessions we just wrote, using the same code path
    // the nightly job uses — so seeded data exercises the real aggregation.
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const from = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    await recomputeRollupRange(db, from, to);

    console.log(`Seeded ${data.sessions.length} sessions across ${data.users.length} users.`);
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly, so importing this module in tests is side-effect free.
if (process.argv[1]?.endsWith("seed.ts")) {
  await main();
}
```

- [ ] **Step 4: Add the script**

Add to `apps/server/package.json` scripts:

```json
{ "seed": "node --env-file=../../.env --experimental-strip-types src/seed.ts" }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm vitest run apps/server/src/seed.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Run the seed against the local database**

```bash
pnpm --filter @jfstats/server seed
docker compose exec postgres psql -U jfstats -d jfstats -c "SELECT count(*) AS rollup_rows, sum(watch_ms)/3600000 AS watch_hours FROM playback_rollup_daily;"
```

Expected: a non-zero row count and a plausible total watch time.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "Add deterministic seed script

Generates 90 days of plausible playback history with a seeded PRNG so the same
seed always produces the same dataset, making UI work and query tuning
reproducible without touching a live Jellyfin server.

Weekend viewing is heavier than weekday so trend charts have visible shape, and
most plays complete while some are abandoned early.

The rollup is built by calling the same recompute the nightly job uses, so
seeded data exercises the real aggregation path rather than a parallel one."
```

---

### Task 13: End-to-end pipeline verification

Proves the whole pipeline agrees with itself. This is the task that would catch a rollup that silently diverges from its sessions.

**Files:**
- Test: `apps/server/src/sync/pipeline.test.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: everything.
- Produces: nothing new — this is the gate on Plan 1.

- [ ] **Step 1: Write the integration test**

`apps/server/src/sync/pipeline.test.ts`:

```ts
import {
  applyRollupDelta,
  closeSession,
  openSession,
  playbackRollupDaily,
  playbackSessions,
  recomputeRollupRange,
  touchSession,
  upsertDevice,
  upsertItems,
} from "@jfstats/db";
import { stopTestDatabase, withTestDatabase } from "@jfstats/db/testing";
import type { LiveSession, SessionSnapshot } from "@jfstats/shared";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { runSessionPoll } from "./applier.js";
import type { SnapshotStore } from "./snapshot-store.js";

afterAll(stopTestDatabase);

const START = new Date("2026-08-16T20:00:00Z").getTime();

function memorySnapshotStore(): SnapshotStore {
  let snapshot: SessionSnapshot = {};
  return {
    load: async () => snapshot,
    save: async (next) => void (snapshot = next),
    publish: async () => {},
  };
}

function liveSession(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    playSessionId: "ps-1",
    userId: "user-1",
    userName: "alice",
    itemId: "item-1",
    itemName: "Demo Movie",
    deviceId: "device-1",
    deviceName: "Living Room TV",
    client: "Jellyfin Web",
    playMethod: "DirectPlay",
    positionTicks: 0,
    runtimeTicks: 60_000 * 10_000,
    isPaused: false,
    remoteEndpoint: "192.0.2.10",
    ...overrides,
  };
}

describe("sync pipeline", () => {
  it("records a full stream and agrees with the nightly recompute", async () => {
    await withTestDatabase(async (db) => {
      await upsertItems(db, [
        { id: "item-1", type: "Movie", name: "Demo Movie", libraryId: "lib-1", runtimeTicks: 60_000 * 10_000 },
      ]);

      const snapshots = memorySnapshotStore();
      let clock = START;

      const deps = {
        db,
        jellyfin: { getSessions: async () => current } as never,
        snapshots,
        completionThreshold: 0.9,
        maxWatchDeltaMs: 7_500,
        now: () => clock,
        openSession,
        touchSession,
        closeSession,
        applyRollupDelta,
        upsertDevice,
      };

      // Three polls of playback, five seconds apart, then the stream disappears.
      let current: LiveSession[] = [liveSession({ positionTicks: 0 })];
      await runSessionPoll(deps);

      clock = START + 5_000;
      current = [liveSession({ positionTicks: 5_000 * 10_000 })];
      await runSessionPoll(deps);

      clock = START + 10_000;
      current = [liveSession({ positionTicks: 10_000 * 10_000 })];
      await runSessionPoll(deps);

      clock = START + 15_000;
      current = [];
      await runSessionPoll(deps);

      const sessions = await db.select().from(playbackSessions);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.endedAt).not.toBeNull();
      // Three five-second intervals were observed.
      expect(sessions[0]?.watchMs).toBe(15_000);

      const before = await db.select().from(playbackRollupDaily);
      const incrementalWatchMs = before.reduce((total, row) => total + row.watchMs, 0);

      await recomputeRollupRange(db, new Date(START - 86_400_000), new Date(START + 86_400_000));

      const after = await db.select().from(playbackRollupDaily);
      const recomputedWatchMs = after.reduce((total, row) => total + row.watchMs, 0);

      // The whole point: the fast incremental path and the authoritative recompute
      // must not disagree.
      expect(recomputedWatchMs).toBe(incrementalWatchMs);
      expect(recomputedWatchMs).toBe(15_000);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ userId: "user-1", itemId: "item-1", playCount: 1 });
    });
  });

  it("does not double count when the same poll is replayed", async () => {
    await withTestDatabase(async (db) => {
      await upsertItems(db, [{ id: "item-1", type: "Movie", name: "Demo Movie", libraryId: "lib-1" }]);

      const snapshots = memorySnapshotStore();
      const current = [liveSession()];
      const deps = {
        db,
        jellyfin: { getSessions: async () => current } as never,
        snapshots,
        completionThreshold: 0.9,
        maxWatchDeltaMs: 7_500,
        now: () => START,
        openSession,
        touchSession,
        closeSession,
        applyRollupDelta,
        upsertDevice,
      };

      await runSessionPoll(deps);
      await runSessionPoll(deps);
      await runSessionPoll(deps);

      const sessions = await db.select().from(playbackSessions);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.watchMs).toBe(0);
    });
  });

  it("keeps rollup totals equal to session totals for seeded data", async () => {
    await withTestDatabase(async (db) => {
      const { generateSeedData } = await import("../seed.js");
      const data = generateSeedData({ days: 30, users: 3, items: 20, seed: 5 });

      await upsertItems(db, data.items);
      await db.insert(playbackSessions).values(data.sessions);
      await recomputeRollupRange(db, new Date(Date.now() - 31 * 86_400_000), new Date(Date.now() + 86_400_000));

      const totals = await db.execute<{ sessions: string; rollup: string }>(sql`
        SELECT
          (SELECT coalesce(sum(watch_ms), 0) FROM playback_sessions)::text     AS sessions,
          (SELECT coalesce(sum(watch_ms), 0) FROM playback_rollup_daily)::text AS rollup
      `);

      expect(totals.rows[0]?.rollup).toBe(totals.rows[0]?.sessions);
    });
  });
});
```

- [ ] **Step 2: Export the test harness from the db package**

The test above imports `@jfstats/db/testing`. Add the subpath export to `packages/db/package.json`:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing/harness.ts"
  }
}
```

Run `pnpm install`.

- [ ] **Step 3: Run the full suite**

```bash
pnpm test
```

Expected: every test in every package passes. Do not proceed until it is green — record the actual counts rather than assuming.

- [ ] **Step 4: Verify typecheck across the workspace**

```bash
pnpm typecheck
```

Expected: exit code 0.

- [ ] **Step 5: Write the README**

`README.md`:

````markdown
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

To populate the database with 90 days of fake history instead of a live server:

```bash
pnpm --filter @jfstats/server seed
```

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

## Development

```bash
pnpm test        # full suite; Docker must be running for integration tests
pnpm typecheck   # workspace-wide
```

## How watch time is measured

Watch time is accumulated from wall-clock intervals between polls, counted only while a
stream is unpaused, and each increment is capped at 1.5× the poll interval. Seeking does
not affect it, and a stalled worker cannot inflate it.

Daily totals live in `playback_rollup_daily`, written incrementally as sessions end. A
nightly job rebuilds the trailing seven days from `playback_sessions` to correct any drift.
````

- [ ] **Step 6: Commit**

```bash
git add apps/server packages/db README.md
git commit -m "Add end-to-end pipeline tests and README

Drives the full poll cycle against real Postgres and asserts the incremental
rollup and the authoritative recompute produce identical totals — the check
that would catch aggregation silently diverging from its source data.

Also asserts a replayed poll changes nothing, proving idempotency end to end
rather than only at the repository level."
```

---

## Self-Review

**Spec coverage.** Every Plan 1 requirement maps to a task: monorepo and boundaries → Tasks 1, 4, 5, 8; config → Task 2; reference and fact tables and the rollup → Task 5; `TEXT` ids for Jellyfin identifiers → Task 5; idempotent writes → Tasks 5, 7, 13; the diff reducer and its three reliability guarantees → Tasks 4, 9, 10; wall-clock clamped watch time → Tasks 2, 4; completion threshold → Task 7; startup reconciliation → Task 10; job intervals → Task 11; Redis snapshot and pub/sub → Task 9; seed script → Task 12; compose infrastructure → Task 5; secret hygiene → Tasks 1, 8, 11.

**Deferred to later plans, by design:** authentication and the fallback admin (Plan 2), SSE endpoint and image proxy (Plan 2), all UI and the three-layer component architecture (Plan 3), the production multi-stage Dockerfile and the `app`/`worker` compose services (Plan 3), Playwright smoke test (Plan 3).

**Known deliberate gap.** `applyEvents` skips the `playCount` rollup when an ended stream is already absent from the payload — which is the normal case. The nightly `recomputeRollupRange` is the authority for play counts; the incremental path optimises watch time. Task 13's first test asserts the two agree. Flagged here so a reviewer does not read it as an oversight.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-16-foundation-and-data-pipeline.md`.
