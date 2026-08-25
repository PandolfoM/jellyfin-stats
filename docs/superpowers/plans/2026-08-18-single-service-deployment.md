# Single-Service Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the deployment from five services to two — `postgres` and `app` — by removing Redis and BullMQ entirely and merging the API, worker, and migration entrypoints into one process.

**Architecture:** Redis currently does five jobs. Three of them (the live-session cache, the worker→API pub/sub channel, and BullMQ's job transport) exist _only_ because the API and worker are separate processes; merging the processes replaces them with an `EventEmitter` and a plain object. The remaining two — session storage and login rate limiting — become Postgres tables. BullMQ's four repeatable jobs become a Postgres-backed scheduler that stores each job's last-run timestamp and ticks against it, which also makes a daily job missed during downtime run on the next boot rather than being skipped.

**Tech Stack:** Node 22, TypeScript strict, Drizzle ORM + PostgreSQL 17, Hono, `node:events`. **Removes** `ioredis`, `bullmq`, and `@testcontainers/redis`.

**Spec:** [`docs/superpowers/specs/2026-08-16-jellyfin-stats-design.md`](../specs/2026-08-16-jellyfin-stats-design.md). This plan changes that spec's deployment topology — the spec describes App + Postgres + Redis; the outcome here is App + Postgres. Everything the spec says about _behavior_ still holds and must not regress.

This is Plan 4. Plans 1–3 are complete; Plan 3 is on `feat/web-ui-and-packaging` awaiting merge. **This plan builds on Plan 3 and must start from it, not from `main`.**

## Global Constraints

- **Node 22 LTS, pnpm 10 workspaces.** Never npm or yarn.
- **TypeScript strict**: `strict: true`, `noUncheckedIndexedAccess: true`. **No `any`, no non-null assertions (`!`) in production code.**
- **ESM only.** Relative imports in `apps/server` and `packages/*` carry a `.js` extension; **`apps/web` does not.**
- **`packages/db` remains the only code that constructs SQL.** The new session and rate-limit queries live in `packages/db/src/repositories/`, not in `apps/server`. `packages/jellyfin` remains the only code aware of Jellyfin's HTTP shape.
- **No secrets or real data in git.** No real hostnames, credentials, Jellyfin ids, usernames, or IPs in any tracked file — including fixtures, tests, and documentation examples.
- **The browser never receives the Jellyfin API key.**
- **Commit messages carry no tooling attribution** — no `Co-Authored-By` trailers, no "generated with" footers.
- **Every task ends with a commit**, after `pnpm test && pnpm typecheck` both pass from the repo root.
- Baseline at plan start: **537 tests across 63 files**, `pnpm typecheck` exit 0.

## What must not regress

These are behaviors the current Redis implementation has that reviewers should check for explicitly. Each was a deliberate decision, several were bug fixes, and losing one silently is the main risk of this plan.

| Behavior                                          | Where it lives now                                                | Why it exists                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Session ids are random, not derived               | `sessions.ts` `randomBytes(32)`                                   | A guessable id is a login bypass.                                                                |
| Sliding expiry on read                            | `sessions.ts` `redis.expire` on `get`                             | An admin using the dashboard is not logged out mid-session.                                      |
| Rate limiter **fails closed**                     | `rate-limit.ts` returns `{ allowed: false }` on a malformed reply | A datastore fault must not silently switch login throttling off.                                 |
| Rate limit window does not slide                  | `expire(..., "NX")`                                               | Otherwise every attempt resets the TTL and the limit never triggers.                             |
| Corrupt snapshot cache does not stop capture      | `snapshot-store.ts` `catch { return {} }`                         | Playback capture outranks the cache.                                                             |
| A late SSE subscriber still sees current sessions | `LIVE_CACHE_KEY` alongside `publish`                              | The channel message only reaches clients subscribed at publish time.                             |
| The live unsubscribe **must not reject**          | `createLiveSubscriber`                                            | Hono invokes it via `forEach` with no error handling; an unobserved rejection kills the process. |
| Nightly jobs run at **local** 03:00/03:30         | BullMQ cron `0 3 * * *`                                           | The container sets `TZ`. In UTC these would fire at 23:00 Eastern — peak viewing.                |

---

## File Structure

```
packages/db/src/
  schema.ts                      # + sessions, rateLimits, jobRuns tables
  repositories/auth.ts           # NEW — all session + rate-limit SQL
  repositories/jobs.ts           # NEW — job last-run read/write
packages/db/drizzle/
  0002_*.sql                     # generated migration

apps/server/src/
  main.ts                        # NEW — the single entrypoint
  scheduler.ts                   # NEW — tick loop runtime
  sync/schedule.ts               # NEW — pure due-ness logic, no I/O
  api/sessions.ts                # rewritten: thin wrapper over repositories/auth
  api/rate-limit.ts              # rewritten: thin wrapper over repositories/auth
  sync/snapshot-store.ts         # rewritten: in-memory + EventEmitter
  api/app.ts                     # modified: in-process subscriber
  context.ts                     # modified: drop redis
  api.ts                         # DELETED (folded into main.ts)
  worker.ts                      # DELETED (folded into main.ts + scheduler.ts)
  migrate.ts                     # DELETED (folded into main.ts)
```

**Why `sync/schedule.ts` is separate from `scheduler.ts`:** the due-ness decision is pure arithmetic over `(schedule, lastRunAt, now)` and is where the timezone bug would live. Keeping it free of I/O means it can be tested exhaustively with a pinned `TZ` and an injected clock, which the tick loop cannot.

---

### Task 1: Schema for sessions, rate limits, and job runs

**Files:**

- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0002_*.sql` (generated)
- Test: `packages/db/src/schema.test.ts` (extend the existing table-list assertion)

**Interfaces:**

- Produces: `sessions`, `rateLimits`, `jobRuns` Drizzle tables, exported from `@jfstats/db`.

- [ ] **Step 1: Add the tables**

Append to `packages/db/src/schema.ts`:

```ts
/**
 * Opaque session ids issued at login. The id is the primary key and is the
 * value in the cookie, so it must stay unguessable — it is generated with
 * randomBytes(32), never derived from the user.
 *
 * `expiresAt` is pushed forward on every authenticated read (sliding expiry),
 * so an admin actively using the dashboard is not logged out mid-session.
 * Expired rows are ignored on read and swept by the session-cleanup job
 * rather than deleted inline, so a read stays a single statement.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    userName: text("user_name").notNull(),
    isAdmin: boolean("is_admin").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("sessions_expires_at_idx").on(table.expiresAt)],
);

/**
 * Fixed-window login throttling. One row per key (an IP, or a constant when
 * proxy headers are not trusted). `windowStartedAt` is what makes the window
 * fixed rather than sliding: it is set once when a window opens and left alone
 * by subsequent attempts, so a burst of attempts cannot keep pushing the
 * window out and prevent the limit from ever triggering.
 */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
});

/**
 * One row per scheduled job, holding when it last completed. This is what
 * replaces BullMQ's repeatable jobs: the scheduler reads these, decides what
 * is due, and writes back. Storing it rather than keeping it in memory is what
 * lets a nightly job missed during downtime run on the next boot.
 */
export const jobRuns = pgTable("job_runs", {
  name: text("name").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
});
```

- [ ] **Step 2: Generate the migration**

```bash
pnpm --filter @jfstats/db migrate:generate
```

Expected: a new `packages/db/drizzle/0002_*.sql`. Read it before continuing and confirm it creates exactly three tables and one index, and alters nothing existing. A generated migration that touches `playback_sessions` or `playback_rollup_daily` means the schema drifted — stop and report.

- [ ] **Step 3: Extend the schema test**

`packages/db/src/schema.test.ts` already asserts the full table list after migrating. Add the three new names to that expected list. The test runs against a real Postgres via testcontainers, so it proves the migration applies.

- [ ] **Step 4: Run**

```bash
pnpm vitest run packages/db/src/schema.test.ts
```

Expected: PASS. If it fails naming a missing table, the migration did not generate — do not hand-write it, fix the generate step.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle packages/db/src/schema.test.ts
git commit -m "feat: add sessions, rate_limits, and job_runs tables"
```

---

### Task 2: Postgres session and rate-limit repositories

**Files:**

- Create: `packages/db/src/repositories/auth.ts`
- Modify: `packages/db/src/index.ts` (export it)
- Test: `packages/db/src/repositories/auth.test.ts`

**Interfaces:**

- Consumes: `sessions`, `rateLimits` from Task 1.
- Produces, all taking `db: Db` as the first argument:
  - `insertSession(db, row: { id, userId, userName, isAdmin, createdAt: Date, expiresAt: Date }): Promise<void>`
  - `selectLiveSession(db, id: string, now: Date, nextExpiresAt: Date): Promise<{ userId: string; userName: string; isAdmin: boolean; createdAt: Date } | null>` — returns `null` for a missing **or expired** row, and pushes `expiresAt` forward when it returns a row
  - `deleteSession(db, id: string): Promise<void>`
  - `deleteExpiredSessions(db, now: Date): Promise<number>` — returns rows deleted
  - `bumpRateLimit(db, key: string, now: Date, windowMs: number): Promise<number>` — returns the attempt count within the current window

**This is the only file in the plan that may write SQL for these tables.** `apps/server` consumes these functions.

- [ ] **Step 1: Write the failing tests**

`packages/db/src/repositories/auth.test.ts`. This uses the existing Postgres testcontainer harness — follow the setup in `packages/db/src/repositories/reference.test.ts`.

```ts
import { describe, expect, it } from "vitest";
// Harness import and beforeAll/afterAll: copy the shape used by
// packages/db/src/repositories/reference.test.ts in this same directory.

const HOUR = 60 * 60 * 1000;

describe("session repository", () => {
  it("round-trips a live session", async () => {
    const now = new Date("2026-08-18T12:00:00Z");
    await insertSession(db, {
      id: "sess-alpha",
      userId: "user-1",
      userName: "ada",
      isAdmin: true,
      createdAt: now,
      expiresAt: new Date(now.getTime() + HOUR),
    });

    const found = await selectLiveSession(db, "sess-alpha", now, new Date(now.getTime() + HOUR));
    expect(found).toEqual({ userId: "user-1", userName: "ada", isAdmin: true, createdAt: now });
  });

  it("returns null for an unknown id", async () => {
    const now = new Date("2026-08-18T12:00:00Z");
    expect(
      await selectLiveSession(db, "sess-nope", now, new Date(now.getTime() + HOUR)),
    ).toBeNull();
  });

  // The row EXISTS and is expired. A fixture that never expires would let a
  // implementation that ignores expiresAt entirely pass this whole file.
  it("returns null for a row that exists but has expired", async () => {
    const issued = new Date("2026-08-18T12:00:00Z");
    await insertSession(db, {
      id: "sess-stale",
      userId: "user-2",
      userName: "grace",
      isAdmin: true,
      createdAt: issued,
      expiresAt: new Date(issued.getTime() + HOUR),
    });

    const later = new Date(issued.getTime() + 2 * HOUR);
    expect(
      await selectLiveSession(db, "sess-stale", later, new Date(later.getTime() + HOUR)),
    ).toBeNull();
  });

  // Sliding expiry: reading at T pushes the deadline out, so a read at
  // T + 90min still succeeds even though the original 1h deadline has passed.
  it("pushes expiry forward on read, so an active session outlives its original deadline", async () => {
    const issued = new Date("2026-08-18T12:00:00Z");
    await insertSession(db, {
      id: "sess-active",
      userId: "user-3",
      userName: "linus",
      isAdmin: true,
      createdAt: issued,
      expiresAt: new Date(issued.getTime() + HOUR),
    });

    const midway = new Date(issued.getTime() + 30 * 60 * 1000);
    await selectLiveSession(db, "sess-active", midway, new Date(midway.getTime() + HOUR));

    const past = new Date(issued.getTime() + 90 * 60 * 1000);
    expect(
      await selectLiveSession(db, "sess-active", past, new Date(past.getTime() + HOUR)),
    ).not.toBeNull();
  });

  it("destroys a session", async () => {
    const now = new Date("2026-08-18T12:00:00Z");
    await insertSession(db, {
      id: "sess-bye",
      userId: "user-4",
      userName: "edsger",
      isAdmin: true,
      createdAt: now,
      expiresAt: new Date(now.getTime() + HOUR),
    });
    await deleteSession(db, "sess-bye");
    expect(await selectLiveSession(db, "sess-bye", now, new Date(now.getTime() + HOUR))).toBeNull();
  });

  it("sweeps only expired rows", async () => {
    const now = new Date("2026-08-18T12:00:00Z");
    await insertSession(db, {
      id: "keep",
      userId: "u",
      userName: "n",
      isAdmin: true,
      createdAt: now,
      expiresAt: new Date(now.getTime() + HOUR),
    });
    await insertSession(db, {
      id: "sweep",
      userId: "u",
      userName: "n",
      isAdmin: true,
      createdAt: now,
      expiresAt: new Date(now.getTime() - HOUR),
    });

    expect(await deleteExpiredSessions(db, now)).toBe(1);
    expect(await selectLiveSession(db, "keep", now, new Date(now.getTime() + HOUR))).not.toBeNull();
  });
});

describe("rate limit repository", () => {
  it("counts attempts within one window", async () => {
    const now = new Date("2026-08-18T12:00:00Z");
    expect(await bumpRateLimit(db, "ip-a", now, HOUR)).toBe(1);
    expect(await bumpRateLimit(db, "ip-a", now, HOUR)).toBe(2);
    expect(await bumpRateLimit(db, "ip-a", now, HOUR)).toBe(3);
  });

  it("keeps separate keys separate", async () => {
    const now = new Date("2026-08-18T12:00:00Z");
    await bumpRateLimit(db, "ip-b", now, HOUR);
    await bumpRateLimit(db, "ip-b", now, HOUR);
    expect(await bumpRateLimit(db, "ip-c", now, HOUR)).toBe(1);
  });

  // The window is FIXED, not sliding: later attempts inside the window must not
  // push the window's start forward. If they did, a steady stream of attempts
  // would never trip the limit.
  it("does not slide the window when attempts continue inside it", async () => {
    const start = new Date("2026-08-18T12:00:00Z");
    await bumpRateLimit(db, "ip-d", start, HOUR);
    const later = new Date(start.getTime() + 50 * 60 * 1000);
    expect(await bumpRateLimit(db, "ip-d", later, HOUR)).toBe(2);

    // 61 minutes after the ORIGINAL start — past the window even though an
    // attempt happened 11 minutes ago.
    const afterWindow = new Date(start.getTime() + 61 * 60 * 1000);
    expect(await bumpRateLimit(db, "ip-d", afterWindow, HOUR)).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm vitest run packages/db/src/repositories/auth.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/db/src/repositories/auth.ts`:

```ts
import { and, eq, lt, lte, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { rateLimits, sessions } from "../schema.js";

export interface SessionRow {
  id: string;
  userId: string;
  userName: string;
  isAdmin: boolean;
  createdAt: Date;
  expiresAt: Date;
}

export async function insertSession(db: Db, row: SessionRow): Promise<void> {
  await db.insert(sessions).values(row);
}

/**
 * One statement, not a read-then-write: the UPDATE's WHERE clause enforces
 * "exists AND not expired" and the RETURNING clause hands back the row it just
 * refreshed. A read followed by a separate update would let a session expire
 * between the two.
 */
export async function selectLiveSession(
  db: Db,
  id: string,
  now: Date,
  nextExpiresAt: Date,
): Promise<Pick<SessionRow, "userId" | "userName" | "isAdmin" | "createdAt"> | null> {
  const rows = await db
    .update(sessions)
    .set({ expiresAt: nextExpiresAt })
    .where(and(eq(sessions.id, id), sql`${sessions.expiresAt} > ${now}`))
    .returning({
      userId: sessions.userId,
      userName: sessions.userName,
      isAdmin: sessions.isAdmin,
      createdAt: sessions.createdAt,
    });

  return rows[0] ?? null;
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

export async function deleteExpiredSessions(db: Db, now: Date): Promise<number> {
  const rows = await db
    .delete(sessions)
    .where(lte(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return rows.length;
}

/**
 * Returns the attempt count inside the current window.
 *
 * The upsert is what makes this atomic under concurrent logins: two requests
 * racing here both hit the same primary key, and Postgres serialises them, so
 * neither can read a stale count and write it back. The DO UPDATE branch resets
 * the counter when the stored window has aged out, and otherwise increments
 * WITHOUT touching window_started_at — that is the fixed-window guarantee.
 */
export async function bumpRateLimit(
  db: Db,
  key: string,
  now: Date,
  windowMs: number,
): Promise<number> {
  const windowStart = new Date(now.getTime() - windowMs);

  const rows = await db
    .insert(rateLimits)
    .values({ key, count: 1, windowStartedAt: now })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`CASE WHEN ${rateLimits.windowStartedAt} <= ${windowStart} THEN 1 ELSE ${rateLimits.count} + 1 END`,
        windowStartedAt: sql`CASE WHEN ${rateLimits.windowStartedAt} <= ${windowStart} THEN ${now} ELSE ${rateLimits.windowStartedAt} END`,
      },
    })
    .returning({ count: rateLimits.count });

  return rows[0]?.count ?? 1;
}
```

Add to `packages/db/src/index.ts`:

```ts
export * from "./repositories/auth.js";
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm vitest run packages/db/src/repositories/auth.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the expiry and fixed-window guards are load-bearing**

Two mutations, each restored after:

1. Delete the `sql\`${sessions.expiresAt} > ${now}\``term from`selectLiveSession`'s WHERE. The "exists but has expired" test must go **red**.
2. Change `bumpRateLimit`'s `windowStartedAt` set-expression to always write `now`. The "does not slide the window" test must go **red** (it will report 3, not 1, on the final assertion).

Report both red outputs and the restored green. If either stays green, the test is not testing what it claims.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/auth.ts packages/db/src/repositories/auth.test.ts packages/db/src/index.ts
git commit -m "feat: add Postgres session and rate-limit repositories"
```

---

### Task 3: Point the session store and rate limiter at Postgres

**Files:**

- Modify: `apps/server/src/api/sessions.ts`, `apps/server/src/api/rate-limit.ts`
- Test: `apps/server/src/api/sessions.test.ts`, `apps/server/src/api/rate-limit.test.ts` (both exist and currently use a Redis testcontainer)

**Interfaces:**

- Consumes: Task 2's repository functions.
- Produces: the **same** `SessionStore` and `RateLimiter` interfaces as today, so no caller changes:
  - `createSessionStore(db: Db, ttlSeconds?: number): SessionStore` — was `(redis: Redis, ttlSeconds?)`
  - `createRateLimiter(db: Db, options: { limit: number; windowSeconds: number }): RateLimiter` — was `(redis: Redis, options)`

`SessionRecord`, `SessionStore`, and `RateLimiter` keep their exact current shapes. `createSessionStore` still generates the id with `randomBytes(32).toString("base64url")`.

**The fail-closed requirement carries over.** The current rate limiter returns `{ allowed: false, remaining: 0 }` when it cannot read a count, with a comment explaining that a datastore fault must not switch throttling off. Postgres throwing must produce the same outcome — a rejected attempt, not an allowed one. Wrap the repository call and return the closed result on error.

- [ ] **Step 1: Rewrite the two existing test files against Postgres**

Both files currently spin a Redis container. Switch them to the Postgres harness (`packages/db`'s testing harness, the same one Task 2 used). **Keep every existing assertion** — they encode the behaviors in the "What must not regress" table. Add one the current suite lacks:

```ts
it("fails closed when the datastore errors", async () => {
  const broken = {/* a Db whose insert/update rejects */} as unknown as Db;
  const limiter = createRateLimiter(broken, { limit: 10, windowSeconds: 900 });
  expect(await limiter.check("ip-x")).toEqual({ allowed: false, remaining: 0 });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm vitest run apps/server/src/api/sessions.test.ts apps/server/src/api/rate-limit.test.ts
```

Expected: FAIL — the factories still want a Redis client.

- [ ] **Step 3: Implement**

`apps/server/src/api/sessions.ts`:

```ts
import { randomBytes } from "node:crypto";
import { deleteSession, insertSession, selectLiveSession, type Db } from "@jfstats/db";

export interface SessionRecord {
  userId: string;
  userName: string;
  isAdmin: boolean;
  createdAt: number;
}

export interface SessionStore {
  create(record: SessionRecord): Promise<string>;
  get(id: string): Promise<SessionRecord | null>;
  destroy(id: string): Promise<void>;
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createSessionStore(db: Db, ttlSeconds = DEFAULT_TTL_SECONDS): SessionStore {
  const ttlMs = ttlSeconds * 1000;

  return {
    async create(record) {
      // Random, not derived from the user — a guessable id would be a login bypass.
      const id = randomBytes(32).toString("base64url");
      const now = new Date();
      await insertSession(db, {
        id,
        userId: record.userId,
        userName: record.userName,
        isAdmin: record.isAdmin,
        createdAt: new Date(record.createdAt),
        expiresAt: new Date(now.getTime() + ttlMs),
      });
      return id;
    },

    async get(id) {
      const now = new Date();
      // Sliding expiry: an admin using the dashboard is not logged out mid-session.
      const row = await selectLiveSession(db, id, now, new Date(now.getTime() + ttlMs));
      if (row === null) return null;

      return {
        userId: row.userId,
        userName: row.userName,
        isAdmin: row.isAdmin,
        createdAt: row.createdAt.getTime(),
      };
    },

    async destroy(id) {
      await deleteSession(db, id);
    },
  };
}
```

`apps/server/src/api/rate-limit.ts`:

```ts
import { bumpRateLimit, type Db } from "@jfstats/db";

export interface RateLimiter {
  check(key: string): Promise<{ allowed: boolean; remaining: number }>;
}

export function createRateLimiter(
  db: Db,
  options: { limit: number; windowSeconds: number },
): RateLimiter {
  const windowMs = options.windowSeconds * 1000;

  return {
    async check(key) {
      let used: number;
      try {
        used = await bumpRateLimit(db, key, new Date(), windowMs);
      } catch {
        // Fail closed. Reading a failure as "0 attempts so far" would have
        // ALLOWED the request, silently switching login throttling off exactly
        // when an attacker would most like it off. The cost is that a database
        // outage blocks logins — already true regardless, since sessions live
        // in the same database and no login could be issued anyway.
        return { allowed: false, remaining: 0 };
      }

      return { allowed: used <= options.limit, remaining: Math.max(0, options.limit - used) };
    },
  };
}
```

- [ ] **Step 4: Update the two call sites**

In `apps/server/src/api/app.ts`, `createSessionStore(context.redis, ...)` becomes `createSessionStore(context.db, ...)` and `createRateLimiter(context.redis, ...)` becomes `createRateLimiter(context.db, ...)`.

- [ ] **Step 5: Run**

```bash
pnpm vitest run apps/server/src/api
```

Expected: PASS.

- [ ] **Step 6: Prove fail-closed is load-bearing**

Change the `catch` to `return { allowed: true, remaining: options.limit }`. The new fail-closed test must go **red**. Restore, confirm green. Report both.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/api/sessions.ts apps/server/src/api/rate-limit.ts apps/server/src/api/sessions.test.ts apps/server/src/api/rate-limit.test.ts apps/server/src/api/app.ts
git commit -m "feat: back sessions and rate limiting with Postgres"
```

---

### Task 4: In-process snapshot store and live event bus

**Files:**

- Modify: `apps/server/src/sync/snapshot-store.ts`
- Modify: `apps/server/src/api/app.ts` (`createLiveSubscriber`)
- Test: `apps/server/src/sync/snapshot-store.test.ts` (exists, currently Redis-backed)

**Interfaces:**

- Produces: `createSnapshotStore(): SnapshotStore` — no arguments now. The `SnapshotStore` interface is **unchanged**: `load()`, `save(snapshot)`, `publish(sessions)`, `loadLive()`. Plus one addition for the API side:
  - `subscribe(listener: (sessions: LiveSession[]) => void): () => void` — returns an unsubscribe function.

**Why this is safe now:** the only reason `publish` crossed a process boundary was the separate worker. With one process, `publish` is a method call. The Redis version's own comment says the snapshot is "purely as a cache. Losing it costs at most one poll interval of watch time, because Postgres remains the source of truth and startup reconciliation repairs anything left open" — that reasoning is exactly as true for an in-memory object, which is why no persistence replacement is needed.

**Two guarantees to preserve, both easy to lose here:**

1. A subscriber that attaches _after_ a publish must still see the current sessions — that is what `loadLive()` is for, and the SSE route calls it on connect. Do not delete it.
2. The unsubscribe function **must not reject**. Hono invokes it from the stream abort path via `forEach` with no error handling; an unobserved rejection terminates the process under Node's default `--unhandled-rejections=throw`. An `EventEmitter` `off()` does not throw, so returning a synchronous unsubscribe is naturally safe — but `LiveDeps.subscribe` is typed as returning `Promise<() => Promise<void>>`, so keep the async shape and make sure the body cannot throw.

- [ ] **Step 1: Write the failing tests**

Replace `apps/server/src/sync/snapshot-store.test.ts` — no container needed now, so this becomes a fast unit test.

```ts
import { describe, expect, it, vi } from "vitest";
import type { LiveSession } from "@jfstats/shared";
import { createSnapshotStore } from "./snapshot-store.js";

function session(id: string): LiveSession {
  return {
    sessionId: id,
    userId: "user-1",
    userName: "ada",
    itemId: "item-1",
    itemName: "Example Movie",
    deviceId: "device-1",
    deviceName: "Living Room",
    client: "Jellyfin Web",
    playMethod: "DirectPlay",
    positionTicks: 0,
    runtimeTicks: null,
    isPaused: false,
    remoteEndpoint: null,
  };
}

describe("snapshot store", () => {
  it("round-trips the diff snapshot", async () => {
    const store = createSnapshotStore();
    await store.save({
      "a:b": { sessionId: "a", itemId: "b", positionTicks: 5, isPaused: false, observedAt: 1 },
    });
    expect(await store.load()).toEqual({
      "a:b": { sessionId: "a", itemId: "b", positionTicks: 5, isPaused: false, observedAt: 1 },
    });
  });

  it("starts empty", async () => {
    expect(await createSnapshotStore().load()).toEqual({});
  });

  it("delivers a publish to an attached subscriber", async () => {
    const store = createSnapshotStore();
    const seen: LiveSession[][] = [];
    store.subscribe((s) => seen.push(s));

    await store.publish([session("s1")]);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]?.sessionId).toBe("s1");
  });

  // The reason loadLive() exists. A client attaching after the publish gets
  // nothing from the event, so without the cache its first render is blank.
  it("gives a late subscriber the current sessions via loadLive", async () => {
    const store = createSnapshotStore();
    await store.publish([session("s2")]);

    const seen: LiveSession[][] = [];
    store.subscribe((s) => seen.push(s));

    expect(seen).toHaveLength(0);
    expect((await store.loadLive())[0]?.sessionId).toBe("s2");
  });

  it("stops delivering after unsubscribe", async () => {
    const store = createSnapshotStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);

    await store.publish([session("s3")]);
    off();
    await store.publish([session("s4")]);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("delivers to every attached subscriber, and unsubscribing one leaves the other", async () => {
    const store = createSnapshotStore();
    const a = vi.fn();
    const b = vi.fn();
    const offA = store.subscribe(a);
    store.subscribe(b);

    offA();
    await store.publish([session("s5")]);

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  // A throwing listener is one dashboard tab misbehaving. It must not stop the
  // other tabs from getting the update, and must not reject publish() — which
  // is awaited on the poll path and would fail the whole poll.
  it("isolates a throwing subscriber from the others and from publish", async () => {
    const store = createSnapshotStore();
    store.subscribe(() => {
      throw new Error("boom");
    });
    const healthy = vi.fn();
    store.subscribe(healthy);

    await expect(store.publish([session("s6")])).resolves.toBeUndefined();
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm vitest run apps/server/src/sync/snapshot-store.test.ts
```

Expected: FAIL — `createSnapshotStore` still requires a Redis client, and `subscribe` does not exist.

- [ ] **Step 3: Implement**

```ts
import { EventEmitter } from "node:events";
import type { LiveSession, SessionSnapshot } from "@jfstats/shared";

export interface SnapshotStore {
  load(): Promise<SessionSnapshot>;
  save(snapshot: SessionSnapshot): Promise<void>;
  publish(sessions: LiveSession[]): Promise<void>;
  /**
   * The full LiveSession list from the most recent publish() — not the minimal
   * SessionSnapshot load() returns. Intended for a freshly-opened SSE stream, which
   * needs to render the current sessions immediately rather than wait for the next
   * poll's publish.
   */
  loadLive(): Promise<LiveSession[]>;
  /** Returns an unsubscribe function. Never throws. */
  subscribe(listener: (sessions: LiveSession[]) => void): () => void;
}

const LIVE_EVENT = "live";

/**
 * Held in memory. This was Redis-backed only because the poller and the HTTP
 * server were separate processes; in one process it is a plain object.
 *
 * Losing it on restart costs at most one poll interval of watch time: Postgres
 * remains the source of truth, and startup reconciliation repairs anything left
 * open. That was true of the Redis cache too — it carried a TTL and no
 * persistence guarantee.
 */
export function createSnapshotStore(): SnapshotStore {
  let snapshot: SessionSnapshot = {};
  let live: LiveSession[] = [];
  const emitter = new EventEmitter();
  // One listener per attached dashboard tab. The default cap of 10 would print
  // a spurious leak warning on the eleventh, and there is no leak here —
  // registerLiveRoute removes its listener on abort.
  emitter.setMaxListeners(0);

  return {
    async load() {
      return snapshot;
    },

    async save(next) {
      snapshot = next;
    },

    async publish(sessions) {
      // Cached before emitting: a subscriber attaching a moment later reads
      // this rather than waiting for the next poll.
      live = sessions;
      // EventEmitter rethrows a listener's error synchronously to the emitting
      // caller, which here is the poll loop — one broken dashboard tab would
      // fail the poll and stop capture for everyone. Each listener is isolated.
      for (const listener of emitter.listeners(LIVE_EVENT)) {
        try {
          (listener as (sessions: LiveSession[]) => void)(sessions);
        } catch {
          // A subscriber that throws is one misbehaving stream, not a reason to
          // drop the update for the others or to fail the poll.
        }
      }
    },

    async loadLive() {
      return live;
    },

    subscribe(listener) {
      emitter.on(LIVE_EVENT, listener);
      return () => {
        emitter.off(LIVE_EVENT, listener);
      };
    },
  };
}
```

- [ ] **Step 4: Rewrite `createLiveSubscriber` in `apps/server/src/api/app.ts`**

The Redis version duplicated a connection and had a large comment about why. All of that goes. It becomes:

```ts
/**
 * Adapts the in-process snapshot store to LiveDeps.subscribe.
 *
 * The returned unsubscribe must not reject: registerLiveRoute invokes it from
 * the stream's abort path, where Hono runs subscribers through `forEach` with
 * no error handling, and an unobserved rejection terminates the process under
 * Node's default --unhandled-rejections=throw. `off()` is synchronous and
 * cannot throw, so the async wrapper here has nothing that can fail.
 */
export function createLiveSubscriber(snapshots: SnapshotStore): LiveDeps["subscribe"] {
  return async (onMessage) => {
    const off = snapshots.subscribe((sessions) => onMessage(JSON.stringify(sessions)));
    return async () => {
      off();
    };
  };
}
```

Update its call site in `createApp` — it currently receives `(context.redis, context.logger)` and now receives `(context.snapshots)`. Delete the now-unused `attachRedisErrorLogger` import if nothing else in the file uses it.

- [ ] **Step 5: Run**

```bash
pnpm vitest run apps/server/src
```

Expected: PASS.

- [ ] **Step 6: Prove the late-subscriber guarantee is load-bearing**

Make `publish` stop assigning `live` (delete the `live = sessions;` line). The "gives a late subscriber the current sessions via loadLive" test must go **red**. Restore, confirm green. This is the guarantee that keeps a freshly-opened dashboard from rendering blank, and it is invisible in every other test.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/sync/snapshot-store.ts apps/server/src/sync/snapshot-store.test.ts apps/server/src/api/app.ts
git commit -m "feat: move the live session cache and event bus in-process"
```

---

### Task 5: Pure scheduling logic

**Files:**

- Create: `apps/server/src/sync/schedule.ts`
- Test: `apps/server/src/sync/schedule.test.ts`

**Interfaces:**

- Produces:
  - `type Schedule = { type: "interval"; everyMs: number } | { type: "daily"; hour: number; minute: number }`
  - `isDue(schedule: Schedule, lastRunAt: number | null, now: number): boolean`
  - `JOB_NAMES: readonly ["session-poll", "reference-sync", "item-sync", "rollup-recompute", "session-cleanup"]`
  - `type JobName = (typeof JOB_NAMES)[number]`

**This file must contain no I/O.** It is where the timezone bug would live, and pure functions are the only way to test it exhaustively.

**The timezone requirement, stated precisely.** BullMQ's `0 3 * * *` fires at 03:00 **in the process's local timezone**, and the container sets `TZ` (the repo owner's is `America/New_York`). Interpreting `hour` as UTC would move nightly maintenance to 23:00 Eastern — peak viewing. `daily` therefore uses **local** accessors (`getFullYear`, `getMonth`, `getDate`), not `Date.UTC`. This project has shipped two timezone defects; the test below pins `TZ` so the guarantee does not depend on the machine.

- [ ] **Step 1: Write the failing tests**

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isDue, type Schedule } from "./schedule.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Pinned, and pinned to a NEGATIVE-offset zone specifically. With TZ unset this
// file passes on a UTC runner even if `daily` were implemented with Date.UTC,
// because local and UTC would agree — the bug this pins only appears off UTC.
beforeAll(() => vi.stubEnv("TZ", "America/New_York"));
afterAll(() => vi.unstubAllEnvs());

const daily3am: Schedule = { type: "daily", hour: 3, minute: 0 };

describe("isDue — interval", () => {
  const every5s: Schedule = { type: "interval", everyMs: 5000 };

  it("is due when it has never run", () => {
    expect(isDue(every5s, null, Date.now())).toBe(true);
  });

  it("is not due before the interval has elapsed", () => {
    const now = Date.now();
    expect(isDue(every5s, now - 4999, now)).toBe(false);
  });

  it("is due once the interval has elapsed exactly", () => {
    const now = Date.now();
    expect(isDue(every5s, now - 5000, now)).toBe(true);
  });
});

describe("isDue — daily, in local time", () => {
  it("is due when it has never run", () => {
    expect(isDue(daily3am, null, new Date("2026-08-18T12:00:00-04:00").getTime())).toBe(true);
  });

  it("is not due just before the local target time", () => {
    const now = new Date("2026-08-18T02:59:00-04:00").getTime();
    const yesterdayRun = new Date("2026-08-17T03:00:00-04:00").getTime();
    expect(isDue(daily3am, yesterdayRun, now)).toBe(false);
  });

  it("is due just after the local target time", () => {
    const now = new Date("2026-08-18T03:01:00-04:00").getTime();
    const yesterdayRun = new Date("2026-08-17T03:00:00-04:00").getTime();
    expect(isDue(daily3am, yesterdayRun, now)).toBe(true);
  });

  it("is not due again later the same day once it has run", () => {
    const now = new Date("2026-08-18T20:00:00-04:00").getTime();
    const ranToday = new Date("2026-08-18T03:00:30-04:00").getTime();
    expect(isDue(daily3am, ranToday, now)).toBe(false);
  });

  // The improvement over BullMQ's repeatable jobs, which simply skip a missed
  // occurrence. The container was down at 03:00 and boots at 09:00 — the job
  // should run now rather than wait until tomorrow.
  it("catches up a run missed while the process was down", () => {
    const now = new Date("2026-08-18T09:00:00-04:00").getTime();
    const ranTwoDaysAgo = new Date("2026-08-16T03:00:00-04:00").getTime();
    expect(isDue(daily3am, ranTwoDaysAgo, now)).toBe(true);
  });

  // The load-bearing timezone case. 2026-08-18T05:00Z is 01:00 EDT — BEFORE the
  // local 03:00 target, so it is NOT due. An implementation using Date.UTC
  // would compute a UTC target of 03:00Z, see 05:00Z as past it, and answer
  // true. Under TZ=America/New_York this test distinguishes them.
  it("uses local time, not UTC, to decide the day boundary", () => {
    const now = new Date("2026-08-18T05:00:00Z").getTime();
    const ranYesterdayLocal = new Date("2026-08-17T03:00:00-04:00").getTime();
    expect(isDue(daily3am, ranYesterdayLocal, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm vitest run apps/server/src/sync/schedule.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export type Schedule =
  { type: "interval"; everyMs: number } | { type: "daily"; hour: number; minute: number };

export const JOB_NAMES = [
  "session-poll",
  "reference-sync",
  "item-sync",
  "rollup-recompute",
  "session-cleanup",
] as const;

export type JobName = (typeof JOB_NAMES)[number];

/**
 * The most recent moment at or before `now` when a daily schedule should have
 * fired, in LOCAL time.
 *
 * Local, not UTC, deliberately: this replaces BullMQ cron patterns that fired
 * at 03:00 in the process's own timezone, and the container sets TZ. Computing
 * the target with Date.UTC would move nightly maintenance to 23:00 for an
 * Eastern deployment — peak viewing rather than the quiet hours it was chosen
 * for. The Date constructor used here reads local fields.
 */
function mostRecentDailyTarget(now: number, hour: number, minute: number): number {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime();
  return today <= now ? today : today - 24 * 60 * 60 * 1000;
}

/**
 * Whether a job should run on this tick.
 *
 * A daily job compares its last run against the most recent target rather than
 * against a fixed "today", so a run missed while the process was down is picked
 * up on the next boot instead of being skipped — which is what BullMQ's
 * repeatable jobs did.
 */
export function isDue(schedule: Schedule, lastRunAt: number | null, now: number): boolean {
  if (lastRunAt === null) return true;

  if (schedule.type === "interval") {
    return now - lastRunAt >= schedule.everyMs;
  }

  return lastRunAt < mostRecentDailyTarget(now, schedule.hour, schedule.minute);
}
```

- [ ] **Step 4: Run**

```bash
pnpm vitest run apps/server/src/sync/schedule.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Prove the timezone guard is load-bearing**

Replace `mostRecentDailyTarget`'s local `new Date(y, m, d, h, min)` with `Date.UTC(...)`. The "uses local time, not UTC" test must go **red**. Restore, confirm green. Report both — and note explicitly that this redness comes from the pinned `TZ` in the test file, not from the machine's own timezone.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/sync/schedule.ts apps/server/src/sync/schedule.test.ts
git commit -m "feat: add pure scheduling logic with local-time daily jobs"
```

---

### Task 6: Job-run repository and the scheduler runtime

**Files:**

- Create: `packages/db/src/repositories/jobs.ts`, `apps/server/src/scheduler.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/repositories/jobs.test.ts`, `apps/server/src/scheduler.test.ts`

**Interfaces:**

- Consumes: `isDue`, `JobName`, `JOB_NAMES` (Task 5); `jobRuns` (Task 1); `handle(context, name, now?)` — the existing job dispatcher, currently in `apps/server/src/worker.ts`. **Move `handle` and its `JobName` switch into `scheduler.ts`** and extend it with a `session-cleanup` case calling `deleteExpiredSessions`.
- Produces:
  - `readJobRuns(db): Promise<Map<string, Date>>`
  - `writeJobRun(db, name: string, at: Date): Promise<void>`
  - `startScheduler(context, options?): { stop(): Promise<void> }`

**Two runtime guarantees the tests must pin:**

1. **No overlapping runs of the same job.** A poll that takes longer than the interval must not stack — the next tick skips a job already in flight. Without this, a slow Jellyfin turns a 5-second interval into unbounded concurrency.
2. **A failing job does not stop the scheduler.** It logs and the loop continues. It also must **not** write a last-run timestamp on failure, so a transient error retries on the next tick rather than waiting a full interval.

- [ ] **Step 1: Write the job repository and its test**

`packages/db/src/repositories/jobs.ts`:

```ts
import type { Db } from "../client.js";
import { jobRuns } from "../schema.js";

export async function readJobRuns(db: Db): Promise<Map<string, Date>> {
  const rows = await db.select().from(jobRuns);
  return new Map(rows.map((row) => [row.name, row.lastRunAt]));
}

export async function writeJobRun(db: Db, name: string, at: Date): Promise<void> {
  await db
    .insert(jobRuns)
    .values({ name, lastRunAt: at })
    .onConflictDoUpdate({ target: jobRuns.name, set: { lastRunAt: at } });
}
```

`packages/db/src/repositories/jobs.test.ts` — using the Postgres harness:

```ts
it("returns an empty map before anything has run", async () => {
  expect((await readJobRuns(db)).size).toBe(0);
});

it("writes and reads back a run time", async () => {
  const at = new Date("2026-08-18T03:00:00Z");
  await writeJobRun(db, "item-sync", at);
  expect((await readJobRuns(db)).get("item-sync")).toEqual(at);
});

it("overwrites a previous run time rather than inserting a second row", async () => {
  await writeJobRun(db, "session-poll", new Date("2026-08-18T03:00:00Z"));
  const later = new Date("2026-08-18T04:00:00Z");
  await writeJobRun(db, "session-poll", later);

  const runs = await readJobRuns(db);
  expect(runs.get("session-poll")).toEqual(later);
  expect(runs.size).toBe(1);
});
```

Export from `packages/db/src/index.ts`:

```ts
export * from "./repositories/jobs.js";
```

- [ ] **Step 2: Write the scheduler test**

`apps/server/src/scheduler.test.ts`. The scheduler takes injectable seams so this needs no timers and no container:

```ts
it("skips a job that is already running rather than starting it twice", async () => {
  // Drive two ticks while the first session-poll is still pending, and assert
  // the job function was entered exactly once. Resolve it, tick again, assert
  // twice. Without an in-flight guard the first assertion sees 2.
});

it("keeps ticking after a job throws", async () => {
  // First tick's job rejects. Second tick must still invoke it.
});

it("does not record a last-run time for a job that failed", async () => {
  // A rejected job must leave the stored timestamp untouched, so the next tick
  // retries instead of waiting a full interval.
});

it("records a last-run time for a job that succeeded", async () => {});
```

Design `startScheduler` so these are writable: accept `{ now?: () => number; runJob?: (name: JobName) => Promise<void>; tickMs?: number }` and expose a way to advance a tick without wall-clock waiting — an exported `runDueJobs(deps, runs, now)` that the interval calls is the simplest seam, and it keeps the timer out of the tests entirely.

- [ ] **Step 3: Run to verify both fail**

```bash
pnpm vitest run packages/db/src/repositories/jobs.test.ts apps/server/src/scheduler.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the scheduler**

`apps/server/src/scheduler.ts` holds the schedule table, the moved `handle` dispatcher, the in-flight set, and the tick loop:

```ts
const SCHEDULES: Record<JobName, Schedule> = {
  "session-poll": { type: "interval", everyMs: env.SESSION_POLL_INTERVAL_MS },
  "reference-sync": { type: "interval", everyMs: env.REFERENCE_SYNC_INTERVAL_MS },
  "item-sync": { type: "daily", hour: 3, minute: 0 },
  "rollup-recompute": { type: "daily", hour: 3, minute: 30 },
  "session-cleanup": { type: "daily", hour: 4, minute: 0 },
};
```

The tick: read runs, for each job `isDue(...)` and not in-flight → mark in-flight, await it, on success `writeJobRun`, on failure log, always clear in-flight. `stop()` clears the interval and awaits everything still in flight.

Keep `handle`'s existing switch exactly as it is — including the exhaustiveness guard — and add the `session-cleanup` case:

```ts
case "session-cleanup": {
  const removed = await deleteExpiredSessions(context.db, new Date(now()));
  context.logger.debug({ removed }, "swept expired sessions");
  break;
}
```

- [ ] **Step 5: Run**

```bash
pnpm vitest run packages/db/src/repositories/jobs.test.ts apps/server/src/scheduler.test.ts
```

Expected: PASS.

- [ ] **Step 6: Prove the overlap guard is load-bearing**

Remove the in-flight check. The "skips a job that is already running" test must go **red**. Restore, confirm green. Report both.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/repositories/jobs.ts packages/db/src/repositories/jobs.test.ts packages/db/src/index.ts apps/server/src/scheduler.ts apps/server/src/scheduler.test.ts
git commit -m "feat: replace BullMQ with a Postgres-backed scheduler"
```

---

### Task 7: The single entrypoint

**Files:**

- Create: `apps/server/src/main.ts`
- Delete: `apps/server/src/api.ts`, `apps/server/src/worker.ts`, `apps/server/src/migrate.ts`
- Modify: `apps/server/package.json` (scripts), `apps/server/src/context.ts`
- Test: `apps/server/src/api.test.ts` and `apps/server/src/worker.test.ts` exist — fold whatever still applies into a new `apps/server/src/main.test.ts` and delete the rest.

**Interfaces:**

- Produces: `apps/server/src/main.ts` as the only entrypoint. `createContext(env)` no longer builds a Redis client; `AppContext` loses its `redis` field and `snapshots` becomes `createSnapshotStore()`.

**Startup order matters and is not arbitrary:**

1. Apply migrations. Nothing else can touch the database first — and with one process there is no second migrator to race, which is why the separate `migrate` service can go.
2. Reconcile open sessions (`reconcileOpenSessions`) — this is existing startup behavior from Plan 1 that repairs sessions left open by an unclean shutdown. **Do not drop it.**
3. Start the scheduler.
4. Start the HTTP server.

**Shutdown order matters more.** The existing `closeApiServer` comment explains it: `server.close()`'s callback does not fire until every in-flight connection has ended, and an attached SSE stream never ends on its own — so the streams must be ended _before_ awaiting the server close, or shutdown hangs forever. Preserve that. The order is: stop the scheduler (and await in-flight jobs) → end SSE streams → close the HTTP server → close the context.

- [ ] **Step 1: Write `main.ts`**

```ts
import { serve, type ServerType } from "@hono/node-server";
import { loadEnv } from "@jfstats/shared";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./api/app.js";
import { closeContext, createContext } from "./context.js";
import { startScheduler } from "./scheduler.js";
import { createShutdownHandler } from "./shutdown.js";
import { reconcileOpenSessions } from "./sync/reconcile.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/drizzle",
);

async function main(): Promise<void> {
  const context = createContext(loadEnv());

  // Before anything reads or writes. One process means no second migrator to
  // race, which is what let the separate migrate service go away.
  await migrate(context.db, { migrationsFolder });
  context.logger.info("migrations applied");

  // Repairs sessions left open by an unclean shutdown. Startup behavior from
  // the original pipeline — dropping it silently loses watch time.
  const repaired = await reconcileOpenSessions({
    db: context.db,
    jellyfin: context.jellyfin,
    completionThreshold: context.env.COMPLETION_THRESHOLD,
  });
  if (repaired > 0) context.logger.info({ repaired }, "reconciled open sessions at startup");

  const scheduler = startScheduler(context);
  const { app, liveStreams } = createApp(context);

  const server = serve({ fetch: app.fetch, port: context.env.PORT }, (info) => {
    context.logger.info({ port: info.port }, "listening");
  });

  const shutdown = createShutdownHandler({
    logger: context.logger,
    exit: process.exit,
    startMessage: "shutting down",
    failureMessage: "shutdown failed",
    onShutdown: async () => {
      // Scheduler first: no new work starts while the rest is torn down.
      await scheduler.stop();
      // SSE streams before the server close. server.close()'s callback waits
      // for every in-flight connection, and an attached stream never ends on
      // its own — closing the server first waits forever.
      await closeApiServer(server, liveStreams);
      await closeContext(context);
    },
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

await main();
```

`closeApiServer` moves over from the deleted `api.ts` unchanged, including its comment.

**Two things about `createShutdownHandler` that the code above depends on** — check them against `apps/server/src/shutdown.ts` rather than trusting this plan, because an earlier plan in this project fabricated an API here:

- It returns a bare `() => void`, not an object. There is no `attach()` method; the caller wires `process.on` itself, exactly as the deleted `api.ts` and `worker.ts` both did.
- `exit`, `startMessage`, and `failureMessage` are part of its options. Copy the signal wiring from whichever of the two deleted entrypoints registered the most signals, so nothing regresses.

Note that Windows cannot deliver a catchable `SIGTERM` to Node — recorded during Plan 1. The handler is still correct and is what Docker uses on Linux; do not "fix" it if a local Windows test appears not to fire.

- [ ] **Step 2: Update `context.ts`**

Drop the `redis` field from `AppContext`, delete the `Redis` import and the client construction, and change `snapshots` to `createSnapshotStore()`. `closeContext` no longer quits Redis. Keep `attachRedisErrorLogger` **only if** something still imports it — if nothing does, delete it and its tests.

- [ ] **Step 3: Update `apps/server/package.json` scripts**

```json
"dev": "tsx --env-file=../../.env src/main.ts",
"seed": "tsx --env-file=../../.env src/seed.ts",
"backfill": "tsx --env-file=../../.env src/backfill.ts"
```

Remove `dev:api` and `dev:worker`.

- [ ] **Step 4: Run the full suite and typecheck**

```bash
pnpm test && pnpm typecheck
```

Both must pass. Deleting three entrypoints will break their test files — fold the still-relevant assertions into `main.test.ts` rather than deleting coverage wholesale, and say in your report exactly which assertions you carried over and which you dropped as no longer applicable.

- [ ] **Step 5: Verify it actually runs**

With Postgres reachable, run `pnpm --filter @jfstats/server dev` and confirm from the logs, in order: migrations applied, reconciliation (if any), listening on the port, and at least one `session-poll` completing. Then `curl localhost:3000/api/health`. Report the real output.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/main.ts apps/server/src/context.ts apps/server/package.json apps/server/src
git rm apps/server/src/api.ts apps/server/src/worker.ts apps/server/src/migrate.ts
git commit -m "feat: merge the api, worker, and migration entrypoints"
```

---

### Task 8: Remove Redis from the dependency tree and configuration

**Files:**

- Modify: `packages/shared/src/env.ts` (drop `REDIS_URL`), `apps/server/package.json`, root `package.json` if needed
- Delete: any remaining Redis-only test harness (`apps/server/src/testing/redis-harness.ts`) and its consumers

**Interfaces:**

- Produces: an `AppEnv` with no `REDIS_URL`. This is a **breaking config change** — a deployment that still sets `REDIS_URL` will not fail (unknown keys are ignored by the schema), but one relying on it will silently lose nothing, since nothing reads it.

- [ ] **Step 1: Remove the config key**

Delete `REDIS_URL` from the Zod schema in `packages/shared/src/env.ts`. Run `pnpm typecheck` and fix every resulting error — those are the remaining readers.

- [ ] **Step 2: Drop the dependencies**

```bash
pnpm --filter @jfstats/server remove ioredis bullmq @testcontainers/redis
```

- [ ] **Step 3: Confirm nothing references them**

```bash
grep -rn "ioredis\|bullmq\|REDIS_URL\|redis" apps packages --include=*.ts --include=*.json | grep -v node_modules
```

Expected: no matches outside comments describing the _former_ design. Any live match is a missed reader — fix it rather than leaving it.

- [ ] **Step 4: Run**

```bash
pnpm test && pnpm typecheck
```

Expected: PASS. Report the new test count — it will drop, because the Redis-backed session, rate-limit, and snapshot tests were replaced with Postgres and in-memory equivalents in Tasks 3 and 4. A _large_ unexplained drop means coverage was deleted rather than moved; account for the delta explicitly.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove ioredis, bullmq, and REDIS_URL"
```

---

### Task 9: Two-service Dockerfile and compose

**Files:**

- Modify: `Dockerfile`, `docker-compose.yml`, `.env.example`

**Interfaces:**

- Produces: a compose file with exactly two services, `postgres` and `app`.

- [ ] **Step 1: Update the Dockerfile**

Only the `CMD` changes — the multi-stage build, the `prod-deps` split, `USER node`, and the `tsx` bin path all stay as they are:

```dockerfile
CMD ["node_modules/.bin/tsx", "apps/server/src/main.ts"]
```

- [ ] **Step 2: Rewrite `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: jfstats
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
      POSTGRES_DB: jfstats
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U jfstats -d jfstats"]
      interval: 5s
      timeout: 5s
      retries: 10

  app:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      # The container reaches Postgres by service name over the compose
      # network; .env's DATABASE_URL is the host-facing value used by `tsx`
      # run directly on the host, and would send the container to its own
      # loopback interface.
      DATABASE_URL: postgres://jfstats:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}@postgres:5432/jfstats
    ports:
      # Both sides use the same value: PORT is what the process binds to
      # (packages/shared/src/env.ts), not a host-only knob, so hardcoding the
      # container side would let the published port dial a container that is
      # not listening on it.
      - "${PORT:-3000}:${PORT:-3000}"
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3000}/api/health || exit 1",
        ]
      start_period: 30s
      interval: 15s
      timeout: 3s
      retries: 3
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  postgres-data:
```

Note there is no `migrate` service and no `depends_on: service_completed_successfully` — `main.ts` applies migrations before it serves.

- [ ] **Step 3: Update `.env.example`**

Remove `REDIS_URL` and `REDIS_PORT`. Keep the `JELLYFIN_URL` container-networking note. Add a line noting Postgres no longer publishes a host port by default.

- [ ] **Step 4: Verify against real containers**

```bash
docker compose build && docker compose up -d
```

Confirm and report actual output for each: `docker compose ps` shows two services with `app` healthy; `curl -s localhost:3000/api/health` returns JSON; `curl -s localhost:3000/` returns the SPA; `curl -si localhost:3000/users/abc | head -1` is 200; `curl -si localhost:3000/api/nope | head -1` is 404; `docker compose logs app` shows migrations applied, then listening, then a poll cycle. Record the image size.

**Before trusting any curl, confirm the listener is the container and not a stray host process** — that mistake produced a false diagnosis earlier in this project.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml .env.example
git commit -m "feat: collapse the deployment to two services"
```

---

### Task 10: Documentation and end-to-end verification

**Files:**

- Modify: `README.md`
- Create: `docs/superpowers/follow-ups-after-plan-4.md`

- [ ] **Step 1: Update the README**

Every mention of Redis, the worker service, the migrate service, and `dev:api`/`dev:worker` is now wrong. The dev path becomes `docker compose up -d postgres` plus `pnpm --filter @jfstats/server dev`; the production path is `docker compose up -d`. Re-read the whole file top to bottom rather than patching the sections you remember — the previous plan shipped a README whose Setup section contradicted its own compose file, precisely because it was patched section-by-section.

State plainly that migrations run automatically at startup.

- [ ] **Step 2: Run the Playwright smoke test against the new stack**

```bash
pnpm exec playwright test
```

The credential-gated test still skips without `E2E_JELLYFIN_USER`/`E2E_JELLYFIN_PASSWORD`; the four anonymous assertions must pass against the two-service stack. Report which ran and which skipped.

- [ ] **Step 3: Full suite and typecheck**

```bash
pnpm test && pnpm typecheck
```

- [ ] **Step 4: Write the follow-ups document**

Record anything deferred, and specifically: whether losing BullMQ's job-failure history matters in practice, and whether the scheduler's tick interval wants to be configurable.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/follow-ups-after-plan-4.md
git commit -m "docs: document the two-service deployment"
```

---

## Self-Review

**Spec coverage.** The spec's deployment section (App + Postgres + Redis) is the one thing this plan deliberately contradicts, and the header says so. Every behavioral requirement it states is preserved: admin-only login (untouched), session cookies (Task 3), login throttling (Tasks 2–3), the live feed (Task 4), nightly rollup recompute (Tasks 5–6), reconciliation on startup (Task 7), and the poster proxy (untouched). The "What must not regress" table is the checklist for the behaviors that live in the code being replaced.

**Placeholder scan.** Tasks 6 and 7 describe test bodies in prose rather than complete code in two places — the scheduler's four cases and the folded-over entrypoint assertions. That is deliberate: both depend on seams the implementer designs in the same task, and writing the assertions against a guessed signature is how this project's plans have produced wrong code before. Each names the exact property to pin and the mutation that must turn it red.

**Type consistency.** `SessionRecord`, `SessionStore`, `RateLimiter`, and `SnapshotStore` keep their current shapes so callers do not change; only their factory arguments differ. `JobName` moves from `worker.ts` to `schedule.ts` and gains `session-cleanup`, which Task 6 adds to `handle`'s switch — the existing exhaustiveness guard will fail the build if it is missed, which is the intended safety net.

**The risk worth naming.** This plan rewrites the session store and the rate limiter — the two pieces where a defect is a security defect rather than a bug. Both keep their interfaces, so the compiler will not catch a behavioral regression. That is what the "What must not regress" table and the four mandated mutation proofs (expiry, fixed window, fail-closed, overlap) are for; a reviewer should treat those four as the gate.
