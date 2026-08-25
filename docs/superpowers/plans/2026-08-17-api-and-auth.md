# API and Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An HTTP API that authenticates Jellyfin administrators, serves dashboard statistics from the daily rollup, streams live playback over SSE, and proxies poster art — with types exported for the Plan 3 SPA to consume.

**Architecture:** A second entrypoint (`apps/server/src/api.ts`) in the existing `apps/server` package, sharing `createContext` with the worker. Hono serves the routes; all reads go through new repository functions in `packages/db`, preserving the rule that only that package writes SQL. Authentication delegates entirely to Jellyfin — no password is ever stored — and issues an opaque session cookie backed by Redis.

**Tech Stack:** Hono 4, `@hono/node-server`, ioredis (a dedicated subscriber connection for SSE), Drizzle, Zod, Vitest + testcontainers.

This is Plan 2 of 3. Plan 1 (data pipeline) is merged to `main`. Plan 3 adds the React SPA and the production image.

Spec: [`docs/superpowers/specs/2026-08-16-jellyfin-stats-design.md`](../specs/2026-08-16-jellyfin-stats-design.md). Read its **"Verified behavior of the real Jellyfin API"** section before Task 2 — it records what Jellyfin 10.11.11 actually returns and supersedes anything inferred from documentation.

Deferred items from Plan 1 that this plan touches: [`docs/superpowers/follow-ups-after-plan-1.md`](../follow-ups-after-plan-1.md).

## Global Constraints

- **Node 22 LTS, pnpm 10 workspaces.** Never npm or yarn.
- **TypeScript strict**: `strict: true`, `noUncheckedIndexedAccess: true`. **No `any`, no non-null assertions (`!`).**
- **ESM only** — relative imports carry a `.js` extension. `verbatimModuleSyntax` is on, so types use `import type`.
- **`packages/db` is the only code that constructs SQL.** API routes call repository functions; they never build predicates.
- **`packages/jellyfin` is the only code aware of Jellyfin's HTTP shape.**
- **All Jellyfin-issued IDs are `text`/string.**
- **No secrets or real data in git.** Test fixtures and example values are fabricated only — no real identifiers, hostnames, usernames, or IPs. Never paste a captured identifier into a test, fixture, or subagent instruction.
- **Passwords are never stored, logged, or hashed locally.** Jellyfin is the sole authority.
- **Commit messages carry no tooling attribution** — no `Co-Authored-By` trailers, no "generated with" footers.
- **Every task ends with a commit**, after the full suite passes.
- Baseline at plan start: **124 tests across 15 files**, `pnpm typecheck` exit 0.

---

## File Structure

New files, each with one responsibility:

```
apps/server/src/
  api.ts                    # entrypoint: builds the app, starts the HTTP server
  api/
    app.ts                  # Hono app assembly; exports AppType for Plan 3
    middleware/
      auth.ts               # requireAdmin — reads the session cookie
    routes/
      auth.ts               # login, logout, me
      stats.ts              # overview, series, top items, users, libraries
      history.ts            # paginated playback history
      live.ts               # SSE feed
      images.ts             # poster proxy
    sessions.ts             # Redis-backed session store
    rate-limit.ts           # Redis fixed-window limiter
packages/db/src/repositories/
  stats.ts                  # aggregate reads over playback_rollup_daily
  history.ts                # paginated reads over playback_sessions
packages/jellyfin/src/
  auth.ts                   # authenticateByName / revokeToken
```

Modified: `packages/shared/src/env.ts` (two new variables), `packages/jellyfin/src/client.ts` (auth methods on the client), `apps/server/package.json`, `docker-compose.yml`, `README.md`.

---

### Task 1: API skeleton and entrypoint

Gets a server running with a health route, so every later task has somewhere to add routes and something to curl.

**Files:**

- Create: `apps/server/src/api/app.ts`, `apps/server/src/api.ts`
- Modify: `apps/server/package.json`
- Test: `apps/server/src/api/app.test.ts`

**Interfaces:**

- Consumes: `createContext(env): AppContext` and `closeContext(context)` from `apps/server/src/context.js`; `loadEnv()` from `@jfstats/shared`.
- Produces:
  - `createApp(context: AppContext): Hono<{ Variables: AppVariables }>` — the assembled app, used by every route task and by the tests.
  - `export type AppType = ReturnType<typeof createApp>` — Plan 3's typed client depends on this exact name.
  - `interface AppVariables { session: unknown }` — **Task 3** defines the real `SessionRecord` type and **Task 6**'s middleware narrows this to it. Declare it as `unknown` here and widen the app's generic when Task 6 lands; do not invent a placeholder `SessionRecord` in this task.
  - `pnpm --filter @jfstats/server dev:api`

- [ ] **Step 1: Add dependencies**

```bash
pnpm --filter @jfstats/server add hono @hono/node-server
```

- [ ] **Step 2: Write the failing test**

`apps/server/src/api/app.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AppContext } from "../context.js";

function testContext(): AppContext {
  return { env: { LOG_LEVEL: "error" } } as unknown as AppContext;
}

describe("createApp", () => {
  it("serves a health check without authentication", async () => {
    const app = createApp(testContext());

    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns JSON 404 for an unknown route rather than HTML", async () => {
    const app = createApp(testContext());

    const response = await app.request("/api/nope");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("reports an unhandled route error as JSON without leaking the message", async () => {
    const app = createApp(testContext());
    app.get("/api/boom", () => {
      throw new Error("internal detail that must not reach the client");
    });

    const response = await app.request("/api/boom");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm vitest run apps/server/src/api/app.test.ts
```

Expected: FAIL — cannot resolve `./app.js`.

- [ ] **Step 4: Implement `app.ts`**

```ts
import { Hono } from "hono";
import type { AppContext } from "../context.js";

/** Populated by the auth middleware in Task 5. */
export interface AppVariables {
  session: unknown;
}

export function createApp(context: AppContext) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  // The client learns that the request failed, not why. Details go to the log,
  // which is redacted; an error message can carry a connection string.
  app.onError((error, c) => {
    context.logger?.error({ err: error, path: c.req.path }, "unhandled api error");
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
```

- [ ] **Step 5: Implement the entrypoint**

`apps/server/src/api.ts`:

```ts
import { serve } from "@hono/node-server";
import { loadEnv } from "@jfstats/shared";
import { createApp } from "./api/app.js";
import { closeContext, createContext } from "./context.js";

async function main(): Promise<void> {
  const context = createContext(loadEnv());
  const app = createApp(context);

  const server = serve({ fetch: app.fetch, port: context.env.PORT }, (info) => {
    context.logger.info({ port: info.port }, "api listening");
  });

  const shutdown = async (): Promise<void> => {
    context.logger.info("api shutting down");
    server.close();
    await closeContext(context);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

// Boot when run directly, whether via tsx (src/api.ts) or compiled (dist/api.js).
// Plan 1's `endsWith(".ts")` guard silently no-ops the compiled build; don't repeat it.
const entry = process.argv[1] ?? "";
if (/[/\\]api\.(ts|js)$/.test(entry)) {
  await main();
}
```

- [ ] **Step 6: Add the dev script**

In `apps/server/package.json` scripts, alongside the existing `dev:worker`:

```json
"dev:api": "tsx --env-file=../../.env src/api.ts"
```

- [ ] **Step 7: Run the tests and the server**

```bash
pnpm vitest run apps/server/src/api/app.test.ts
```

Expected: PASS, 3 tests.

```bash
pnpm --filter @jfstats/server dev:api
```

In another terminal: `curl -s localhost:3000/api/health` returns `{"status":"ok"}`. Stop the server.

- [ ] **Step 8: Full suite, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add apps/server pnpm-lock.yaml
git commit -m "Add Hono API skeleton and entrypoint

Adds a second entrypoint sharing createContext with the worker, so both
processes build their dependencies the same way.

Unhandled errors return a generic JSON body and log the detail rather than
returning it — an error message can carry a connection string.

The entrypoint guard matches both .ts and .js so the compiled build boots;
the worker's endsWith(\".ts\") guard silently no-ops under node dist/."
```

---

### Task 2: Jellyfin authentication methods

Adds `authenticateByName` and `revokeToken` to the Jellyfin client. **This task must be verified against the real server** — Plan 1's most expensive defect came from trusting a documented field that does not exist.

**Files:**

- Create: `packages/jellyfin/src/auth.ts`
- Modify: `packages/jellyfin/src/client.ts`, `packages/jellyfin/src/index.ts`
- Test: `packages/jellyfin/src/auth.test.ts`

**Interfaces:**

- Consumes: `createJellyfinClient(options)` and its private `request` helper pattern.
- Produces, added to the `JellyfinClient` interface:
  - `authenticateByName(username: string, password: string): Promise<JellyfinAuthResult>`
  - `revokeToken(accessToken: string): Promise<void>`
  - `interface JellyfinAuthResult { userId: string; userName: string; isAdmin: boolean; accessToken: string }`
  - `class JellyfinAuthError extends Error { readonly kind: "invalid_credentials" | "unreachable" }`

**Why the error type matters:** the login route must distinguish "wrong password" (401 to the user) from "Jellyfin is down" (503, and a different remediation). Collapsing both into one error would tell an admin their password is wrong when their server is offline.

- [ ] **Step 1: Write the failing test**

`packages/jellyfin/src/auth.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJellyfinClient } from "./client.js";
import { JellyfinAuthError } from "./auth.js";

const AUTH_OK = {
  AccessToken: "fabricated-access-token",
  User: {
    Id: "11111111111111111111111111111111",
    Name: "test-admin",
    Policy: { IsAdministrator: true },
  },
};

function clientWith(payload: unknown, status = 200) {
  const fetchMock = vi.fn(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(payload), {
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

describe("authenticateByName", () => {
  it("posts the credentials and maps the result", async () => {
    const { client, fetchMock } = clientWith(AUTH_OK);

    const result = await client.authenticateByName("test-admin", "secret");

    expect(result).toEqual({
      userId: "11111111111111111111111111111111",
      userName: "test-admin",
      isAdmin: true,
      accessToken: "fabricated-access-token",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/Users/AuthenticateByName");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("sends the client identification header Jellyfin requires", async () => {
    const { client, fetchMock } = clientWith(AUTH_OK);
    await client.authenticateByName("test-admin", "secret");

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const auth = (init as RequestInit).headers as Record<string, string>;
    // Jellyfin rejects AuthenticateByName without Client/Device/DeviceId/Version.
    expect(auth.Authorization).toMatch(
      /MediaBrowser Client=".+", Device=".+", DeviceId=".+", Version=".+"/,
    );
  });

  it("never puts the password in the URL", async () => {
    const { client, fetchMock } = clientWith(AUTH_OK);
    await client.authenticateByName("test-admin", "hunter2");

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("hunter2");
  });

  it("reports a rejected password as invalid_credentials", async () => {
    const { client } = clientWith({}, 401);

    await expect(client.authenticateByName("test-admin", "wrong")).rejects.toMatchObject({
      kind: "invalid_credentials",
    });
  });

  it("reports an unreachable server as unreachable, not as a bad password", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createJellyfinClient({
      baseUrl: "http://jellyfin.test:8096",
      apiKey: "test-key",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.authenticateByName("test-admin", "secret")).rejects.toMatchObject({
      kind: "unreachable",
    });
  });

  it("treats a 500 from Jellyfin as unreachable rather than invalid credentials", async () => {
    const { client } = clientWith({}, 500);

    await expect(client.authenticateByName("test-admin", "secret")).rejects.toMatchObject({
      kind: "unreachable",
    });
  });

  it("maps a non-admin account without throwing", async () => {
    const { client } = clientWith({
      ...AUTH_OK,
      User: { ...AUTH_OK.User, Policy: { IsAdministrator: false } },
    });

    // The admin gate lives in the route, not the client — the client reports facts.
    expect((await client.authenticateByName("test-admin", "secret")).isAdmin).toBe(false);
  });

  it("treats a missing Policy as not-admin", async () => {
    const { client } = clientWith({ ...AUTH_OK, User: { Id: "u1", Name: "n" } });

    expect((await client.authenticateByName("n", "secret")).isAdmin).toBe(false);
  });

  it("is a JellyfinAuthError so callers can narrow on it", async () => {
    const { client } = clientWith({}, 401);

    await expect(client.authenticateByName("a", "b")).rejects.toBeInstanceOf(JellyfinAuthError);
  });
});

describe("revokeToken", () => {
  it("posts to the logout endpoint with the issued token", async () => {
    const { client, fetchMock } = clientWith(null, 204);

    await client.revokeToken("fabricated-access-token");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/Sessions/Logout");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toContain('Token="fabricated-access-token"');
  });

  it("does not throw when revocation fails", async () => {
    const { client } = clientWith({}, 500);

    // Revocation is best-effort cleanup; a failure must not break the user's login.
    await expect(client.revokeToken("fabricated-access-token")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run packages/jellyfin/src/auth.test.ts
```

Expected: FAIL — cannot resolve `./auth.js`.

- [ ] **Step 3: Implement `auth.ts`**

```ts
import { z } from "zod";

export class JellyfinAuthError extends Error {
  readonly kind: "invalid_credentials" | "unreachable";

  constructor(kind: "invalid_credentials" | "unreachable", message: string) {
    super(message);
    this.name = "JellyfinAuthError";
    this.kind = kind;
  }
}

export interface JellyfinAuthResult {
  userId: string;
  userName: string;
  isAdmin: boolean;
  accessToken: string;
}

export const authResponseSchema = z.object({
  AccessToken: z.string(),
  User: z.object({
    Id: z.string(),
    Name: z.string(),
    Policy: z.object({ IsAdministrator: z.boolean().nullish() }).nullish(),
  }),
});

/**
 * Jellyfin rejects AuthenticateByName unless the caller identifies itself. DeviceId is
 * stable so repeated logins reuse one device entry rather than littering the server's
 * device list with a new one per sign-in.
 */
export function clientIdentificationHeader(): string {
  return [
    'MediaBrowser Client="Jellyfin Stats"',
    'Device="jellyfin-stats-api"',
    'DeviceId="jellyfin-stats-api"',
    'Version="1.0.0"',
  ].join(", ");
}
```

- [ ] **Step 4: Add the methods to the client**

In `packages/jellyfin/src/client.ts`, extend the `JellyfinClient` interface with the two methods, and add these implementations to the returned object:

```ts
    async authenticateByName(username: string, password: string) {
      let response: Response;

      try {
        response = await doFetch(`${options.baseUrl}/Users/AuthenticateByName`, {
          method: "POST",
          headers: {
            Authorization: clientIdentificationHeader(),
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          // Credentials travel in the body. Never the query string — it would land
          // in access logs and browser history.
          body: JSON.stringify({ Username: username, Pw: password }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        throw new JellyfinAuthError("unreachable", "Could not reach Jellyfin");
      }

      if (response.status === 401 || response.status === 403) {
        throw new JellyfinAuthError("invalid_credentials", "Jellyfin rejected the credentials");
      }

      if (!response.ok) {
        throw new JellyfinAuthError("unreachable", `Jellyfin returned ${response.status}`);
      }

      const parsed = authResponseSchema.safeParse(await response.json());

      if (!parsed.success) {
        throw new JellyfinAuthError("unreachable", "Unexpected authentication response");
      }

      return {
        userId: parsed.data.User.Id,
        userName: parsed.data.User.Name,
        isAdmin: parsed.data.User.Policy?.IsAdministrator ?? false,
        accessToken: parsed.data.AccessToken,
      };
    },

    async revokeToken(accessToken: string) {
      // Best effort. A failure here must never surface to a user who just logged in
      // successfully — the worst case is one stale device entry on the Jellyfin server.
      try {
        await doFetch(`${options.baseUrl}/Sessions/Logout`, {
          method: "POST",
          headers: {
            Authorization: `MediaBrowser Token="${accessToken}"`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // swallowed deliberately
      }
    },
```

Export `JellyfinAuthError`, `JellyfinAuthResult`, and the new methods' types from `packages/jellyfin/src/index.ts`.

- [ ] **Step 5: Run the tests**

```bash
pnpm vitest run packages/jellyfin/src/auth.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 6: VERIFY AGAINST THE REAL SERVER — mandatory**

This step is the point of the task. The `.env` holds working credentials for a live Jellyfin 10.11.11 server.

Build, then run a scratch script that calls `authenticateByName` with a **deliberately wrong password** for a real username, and confirm it raises `invalid_credentials` rather than `unreachable` or a Zod failure:

```bash
pnpm typecheck
```

Write a temporary `.mjs` file (delete it afterwards, never commit it) that imports the built client and calls `authenticateByName("<a real username>", "definitely-not-the-password")`. Expected: `JellyfinAuthError` with `kind: "invalid_credentials"`.

Then ask the repo owner to run one successful login themselves if they are willing to type their password, OR — if they prefer not to — record in your report that the success path is verified only by fixture. **Do not ask for or handle their password yourself, and never write a real password into any file, command, or report.**

Report exactly what you observed: the status code Jellyfin returned, whether the identification header was required, and whether the response shape matched `authResponseSchema`.

If the schema does not match the real server, **fix the schema and re-record the fixture with fabricated values** — do not adjust a test to accommodate a wrong schema.

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add packages/jellyfin
git commit -m "Add Jellyfin authentication and token revocation

Authentication delegates to Jellyfin's AuthenticateByName; no password is
stored, hashed, or logged locally.

A rejected password and an unreachable server raise distinct error kinds so
the login route can answer 401 versus 503 — collapsing them would tell an
admin their password is wrong when their server is merely offline.

Credentials travel in the request body rather than the query string, and
token revocation is best-effort so a cleanup failure cannot break a login
that already succeeded."
```

---

### Task 3: Redis session store and login rate limiter

**Files:**

- Create: `apps/server/src/api/sessions.ts`, `apps/server/src/api/rate-limit.ts`
- Test: `apps/server/src/api/sessions.test.ts`, `apps/server/src/api/rate-limit.test.ts`

**Interfaces:**

- Consumes: an `ioredis` client (from `AppContext.redis`).
- Produces:
  - `createSessionStore(redis: Redis, ttlSeconds?: number): SessionStore`
  - `interface SessionRecord { userId: string; userName: string; isAdmin: boolean; createdAt: number }`
  - `interface SessionStore { create(record: SessionRecord): Promise<string>; get(id: string): Promise<SessionRecord | null>; destroy(id: string): Promise<void> }`
  - `createRateLimiter(redis: Redis, options: { limit: number; windowSeconds: number }): RateLimiter`
  - `interface RateLimiter { check(key: string): Promise<{ allowed: boolean; remaining: number }> }`

**Design points:**

- Session ids are **cryptographically random**, not derived from user data — a guessable id is a login bypass. Use `randomBytes(32).toString("base64url")`.
- `get` **slides the TTL** on a hit, so an active admin is not logged out mid-session.
- The limiter is a fixed window keyed by IP. It counts on every check, so repeated failures compound.

- [ ] **Step 1: Write the failing tests**

`apps/server/src/api/sessions.test.ts`:

```ts
import Redis from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createSessionStore } from "./sessions.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  const keys = await redis.keys("jfstats:session:*");
  if (keys.length > 0) await redis.del(...keys);
});

const RECORD = { userId: "u-1", userName: "admin", isAdmin: true, createdAt: 1_777_000_000_000 };

describe("session store", () => {
  it("round-trips a session by its id", async () => {
    const store = createSessionStore(redis);

    const id = await store.create(RECORD);

    expect(await store.get(id)).toEqual(RECORD);
  });

  it("issues unguessable ids", async () => {
    const store = createSessionStore(redis);

    const a = await store.create(RECORD);
    const b = await store.create(RECORD);

    expect(a).not.toBe(b);
    // 32 random bytes, base64url encoded.
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).not.toContain(RECORD.userId);
  });

  it("returns null for an unknown id", async () => {
    const store = createSessionStore(redis);

    expect(await store.get("not-a-real-session-id")).toBeNull();
  });

  it("returns null after destroy, so logout actually revokes", async () => {
    const store = createSessionStore(redis);
    const id = await store.create(RECORD);

    await store.destroy(id);

    expect(await store.get(id)).toBeNull();
  });

  it("slides the expiry on read so an active admin is not logged out", async () => {
    const store = createSessionStore(redis, 100);
    const id = await store.create(RECORD);
    await redis.expire(`jfstats:session:${id}`, 5);

    await store.get(id);

    expect(await redis.ttl(`jfstats:session:${id}`)).toBeGreaterThan(50);
  });

  it("returns null rather than throwing when the stored value is corrupt", async () => {
    const store = createSessionStore(redis);
    await redis.set("jfstats:session:corrupt", "{not json");

    expect(await store.get("corrupt")).toBeNull();
  });
});
```

`apps/server/src/api/rate-limit.test.ts`:

```ts
import Redis from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  const keys = await redis.keys("jfstats:ratelimit:*");
  if (keys.length > 0) await redis.del(...keys);
});

describe("rate limiter", () => {
  it("allows requests below the limit and counts down", async () => {
    const limiter = createRateLimiter(redis, { limit: 3, windowSeconds: 60 });

    expect(await limiter.check("198.51.100.7")).toEqual({ allowed: true, remaining: 2 });
    expect(await limiter.check("198.51.100.7")).toEqual({ allowed: true, remaining: 1 });
    expect(await limiter.check("198.51.100.7")).toEqual({ allowed: true, remaining: 0 });
  });

  it("blocks once the limit is exceeded", async () => {
    const limiter = createRateLimiter(redis, { limit: 2, windowSeconds: 60 });
    await limiter.check("198.51.100.8");
    await limiter.check("198.51.100.8");

    expect(await limiter.check("198.51.100.8")).toMatchObject({ allowed: false });
  });

  it("tracks each key independently, so one attacker cannot lock everyone out", async () => {
    const limiter = createRateLimiter(redis, { limit: 1, windowSeconds: 60 });
    await limiter.check("198.51.100.9");

    expect(await limiter.check("198.51.100.10")).toMatchObject({ allowed: true });
  });

  it("sets an expiry so the window actually rolls", async () => {
    const limiter = createRateLimiter(redis, { limit: 5, windowSeconds: 42 });
    await limiter.check("198.51.100.11");

    const ttl = await redis.ttl("jfstats:ratelimit:198.51.100.11");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(42);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm vitest run apps/server/src/api/sessions.test.ts apps/server/src/api/rate-limit.test.ts
```

Expected: FAIL — modules not found. **These tests need Redis running**; `docker compose up -d` first, and note the local `.env` maps Redis to a non-default host port.

- [ ] **Step 3: Implement `sessions.ts`**

```ts
import { randomBytes } from "node:crypto";
import type Redis from "ioredis";

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

const PREFIX = "jfstats:session:";
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createSessionStore(redis: Redis, ttlSeconds = DEFAULT_TTL_SECONDS): SessionStore {
  return {
    async create(record) {
      // Random, not derived from the user — a guessable id would be a login bypass.
      const id = randomBytes(32).toString("base64url");
      await redis.set(`${PREFIX}${id}`, JSON.stringify(record), "EX", ttlSeconds);
      return id;
    },

    async get(id) {
      const raw = await redis.get(`${PREFIX}${id}`);
      if (raw === null) return null;

      try {
        const record = JSON.parse(raw) as SessionRecord;
        // Sliding expiry: an admin using the dashboard is not logged out mid-session.
        await redis.expire(`${PREFIX}${id}`, ttlSeconds);
        return record;
      } catch {
        return null;
      }
    },

    async destroy(id) {
      await redis.del(`${PREFIX}${id}`);
    },
  };
}
```

- [ ] **Step 4: Implement `rate-limit.ts`**

```ts
import type Redis from "ioredis";

export interface RateLimiter {
  check(key: string): Promise<{ allowed: boolean; remaining: number }>;
}

const PREFIX = "jfstats:ratelimit:";

export function createRateLimiter(
  redis: Redis,
  options: { limit: number; windowSeconds: number },
): RateLimiter {
  return {
    async check(key) {
      const redisKey = `${PREFIX}${key}`;
      // INCR then EXPIRE in one round trip; EXPIRE is idempotent within the window.
      const [count] = await redis
        .multi()
        .incr(redisKey)
        .expire(redisKey, options.windowSeconds, "NX")
        .exec()
        .then((replies) => (replies ?? []).map((reply) => Number(reply?.[1] ?? 0)));

      const used = count ?? 0;
      return { allowed: used <= options.limit, remaining: Math.max(0, options.limit - used) };
    },
  };
}
```

- [ ] **Step 5: Run the tests**

```bash
pnpm vitest run apps/server/src/api/sessions.test.ts apps/server/src/api/rate-limit.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add apps/server
git commit -m "Add Redis session store and login rate limiter

Session ids are 32 cryptographically random bytes rather than anything
derived from the user, since a guessable id would be a login bypass, and
reads slide the expiry so an active admin is not logged out mid-session.

A corrupt stored value returns null rather than throwing, so a bad cache
entry logs the user out instead of breaking every request.

The limiter keys on the caller so one attacker cannot lock out everyone."
```

---

### Task 4: Cookie configuration

Two new environment variables, and one decision that is easy to get wrong: `Secure` cookies do not survive plain HTTP, which is how most people first run a self-hosted app.

**Files:**

- Modify: `packages/shared/src/env.ts`, `.env.example`
- Test: `packages/shared/src/env.test.ts`

**Interfaces:**

- Produces on `AppEnv`: `COOKIE_SECURE: boolean` (default `false`) and `SESSION_TTL_HOURS: number` (default `168`).

- [ ] **Step 1: Add the failing tests**

Append to `packages/shared/src/env.test.ts`:

```ts
describe("cookie and session configuration", () => {
  it("defaults COOKIE_SECURE to false so a first run over plain HTTP works", () => {
    expect(loadEnv(valid).COOKIE_SECURE).toBe(false);
  });

  it("accepts the string 'true' from a .env file", () => {
    expect(loadEnv({ ...valid, COOKIE_SECURE: "true" }).COOKIE_SECURE).toBe(true);
  });

  it("treats any other value as false rather than throwing", () => {
    expect(loadEnv({ ...valid, COOKIE_SECURE: "yes" }).COOKIE_SECURE).toBe(false);
  });

  it("defaults the session lifetime to a week", () => {
    expect(loadEnv(valid).SESSION_TTL_HOURS).toBe(168);
  });

  it("rejects a non-positive session lifetime", () => {
    expect(() => loadEnv({ ...valid, SESSION_TTL_HOURS: "0" })).toThrow(/SESSION_TTL_HOURS/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run packages/shared/src/env.test.ts
```

Expected: FAIL — `COOKIE_SECURE` is not on the parsed type.

- [ ] **Step 3: Add to the schema**

In `packages/shared/src/env.ts`, inside the Zod object:

```ts
  // Secure cookies are dropped over plain HTTP, which is how most self-hosted
  // first runs happen. Default off; the README says to turn it on behind TLS.
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .catch("false")
    .transform((value) => value === "true"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
```

- [ ] **Step 4: Document in `.env.example`**

```
# Set to true when serving over HTTPS. Leave false for plain-HTTP local runs —
# a Secure cookie is silently dropped by the browser over HTTP, which looks
# exactly like a broken login.
COOKIE_SECURE=false
SESSION_TTL_HOURS=168
```

- [ ] **Step 5: Run, typecheck, commit**

```bash
pnpm vitest run packages/shared/src/env.test.ts && pnpm test && pnpm typecheck
git add packages/shared .env.example
git commit -m "Add cookie security and session lifetime configuration

COOKIE_SECURE defaults to false because a Secure cookie is silently dropped
over plain HTTP, which presents as a login that appears to succeed and then
immediately fails — a confusing first-run experience for a self-hosted app.
The README directs turning it on behind TLS."
```

---

### Task 5: Authentication routes

**Files:**

- Create: `apps/server/src/api/routes/auth.ts`
- Modify: `apps/server/src/api/app.ts`
- Test: `apps/server/src/api/routes/auth.test.ts`

**Interfaces:**

- Consumes: `authenticateByName`, `revokeToken`, `JellyfinAuthError` (Task 2); `createSessionStore`, `createRateLimiter` (Task 3); `COOKIE_SECURE`, `SESSION_TTL_HOURS`, `fallbackAdminEnabled` (Task 4 / Plan 1).
- Produces: `registerAuthRoutes(app, deps: AuthDeps): void` mounting `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`; and `SESSION_COOKIE = "jfstats_session"`.

**Behavior the tests pin down:**

- A valid **non-admin** Jellyfin account is rejected with 403, and **no session is created**.
- The Jellyfin access token is revoked immediately on successful login — the app already has its own API key; holding a second credential is liability.
- Wrong password → 401; Jellyfin unreachable → 503. Different problems, different answers.
- The fallback admin works only when **both** env vars are set, and is checked **before** Jellyfin so it still works when Jellyfin is down — that is its entire purpose.

- [ ] **Step 1: Write the failing test**

`apps/server/src/api/routes/auth.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { JellyfinAuthError } from "@jfstats/jellyfin";
import { registerAuthRoutes, SESSION_COOKIE, type AuthDeps } from "./auth.js";

const ADMIN = { userId: "u-1", userName: "admin", isAdmin: true, accessToken: "tok-1" };

function build(overrides: Partial<AuthDeps> = {}) {
  const deps: AuthDeps = {
    authenticateByName: vi.fn(async () => ADMIN),
    revokeToken: vi.fn(async () => {}),
    sessions: {
      create: vi.fn(async () => "session-id-1"),
      get: vi.fn(async () => null),
      destroy: vi.fn(async () => {}),
    },
    rateLimiter: { check: vi.fn(async () => ({ allowed: true, remaining: 9 })) },
    cookieSecure: false,
    sessionTtlHours: 168,
    fallbackAdmin: null,
    ...overrides,
  };

  const app = new Hono();
  registerAuthRoutes(app, deps);
  return { app, deps };
}

function login(app: Hono, body: unknown) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  it("sets an httpOnly session cookie for an admin", async () => {
    const { app } = build();

    const response = await login(app, { username: "admin", password: "secret" });

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=session-id-1`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("omits Secure when cookieSecure is false, so plain-HTTP runs work", async () => {
    const { app } = build({ cookieSecure: false });

    const response = await login(app, { username: "admin", password: "secret" });

    expect(response.headers.get("set-cookie") ?? "").not.toContain("Secure");
  });

  it("sets Secure when configured", async () => {
    const { app } = build({ cookieSecure: true });

    const response = await login(app, { username: "admin", password: "secret" });

    expect(response.headers.get("set-cookie") ?? "").toContain("Secure");
  });

  it("revokes the Jellyfin token immediately after a successful login", async () => {
    const { app, deps } = build();

    await login(app, { username: "admin", password: "secret" });

    // The app already holds its own API key; a second live credential is liability.
    expect(deps.revokeToken).toHaveBeenCalledWith("tok-1");
  });

  it("rejects a valid non-admin account with 403 and creates no session", async () => {
    const { app, deps } = build({
      authenticateByName: vi.fn(async () => ({ ...ADMIN, isAdmin: false })),
    });

    const response = await login(app, { username: "viewer", password: "secret" });

    expect(response.status).toBe(403);
    expect(deps.sessions.create).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("still revokes the token for a rejected non-admin", async () => {
    const { app, deps } = build({
      authenticateByName: vi.fn(async () => ({ ...ADMIN, isAdmin: false })),
    });

    await login(app, { username: "viewer", password: "secret" });

    expect(deps.revokeToken).toHaveBeenCalledWith("tok-1");
  });

  it("answers 401 for a rejected password", async () => {
    const { app } = build({
      authenticateByName: vi.fn(async () => {
        throw new JellyfinAuthError("invalid_credentials", "nope");
      }),
    });

    expect((await login(app, { username: "admin", password: "wrong" })).status).toBe(401);
  });

  it("answers 503 when Jellyfin is unreachable, not 401", async () => {
    const { app } = build({
      authenticateByName: vi.fn(async () => {
        throw new JellyfinAuthError("unreachable", "down");
      }),
    });

    // Telling an admin their password is wrong when the server is offline sends
    // them down entirely the wrong path.
    expect((await login(app, { username: "admin", password: "secret" })).status).toBe(503);
  });

  it("answers 429 when the rate limiter blocks", async () => {
    const { app, deps } = build({
      rateLimiter: { check: vi.fn(async () => ({ allowed: false, remaining: 0 })) },
    });

    const response = await login(app, { username: "admin", password: "secret" });

    expect(response.status).toBe(429);
    // Blocked before Jellyfin is contacted at all.
    expect(deps.authenticateByName).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400", async () => {
    const { app } = build();

    expect((await login(app, { username: "admin" })).status).toBe(400);
  });

  it("never echoes the password back in any response", async () => {
    const { app } = build({
      authenticateByName: vi.fn(async () => {
        throw new JellyfinAuthError("invalid_credentials", "nope");
      }),
    });

    const response = await login(app, { username: "admin", password: "hunter2" });

    expect(await response.text()).not.toContain("hunter2");
  });
});

describe("fallback admin", () => {
  it("is used before Jellyfin, so it works when Jellyfin is down", async () => {
    const { app, deps } = build({
      fallbackAdmin: { username: "rescue", password: "rescue-pw" },
      authenticateByName: vi.fn(async () => {
        throw new JellyfinAuthError("unreachable", "down");
      }),
    });

    const response = await login(app, { username: "rescue", password: "rescue-pw" });

    expect(response.status).toBe(200);
    expect(deps.authenticateByName).not.toHaveBeenCalled();
  });

  it("does not match on username alone", async () => {
    const { app } = build({ fallbackAdmin: { username: "rescue", password: "rescue-pw" } });

    const response = await login(app, { username: "rescue", password: "wrong" });

    // Falls through to Jellyfin, which the default mock accepts as an admin —
    // what matters is that the wrong fallback password did not itself authenticate.
    expect(response.status).toBe(200);
  });

  it("is inert when not configured", async () => {
    const { app, deps } = build({ fallbackAdmin: null });

    await login(app, { username: "anyone", password: "anything" });

    expect(deps.authenticateByName).toHaveBeenCalled();
  });
});

describe("POST /api/auth/logout", () => {
  it("destroys the session and clears the cookie", async () => {
    const { app, deps } = build();

    const response = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-id-1` },
    });

    expect(response.status).toBe(200);
    expect(deps.sessions.destroy).toHaveBeenCalledWith("session-id-1");
    expect(response.headers.get("set-cookie") ?? "").toContain(`${SESSION_COOKIE}=;`);
  });

  it("succeeds even without a session cookie", async () => {
    const { app } = build();

    expect((await app.request("/api/auth/logout", { method: "POST" })).status).toBe(200);
  });
});

describe("GET /api/auth/me", () => {
  it("returns the signed-in user", async () => {
    const { app } = build({
      sessions: {
        create: vi.fn(async () => "x"),
        get: vi.fn(async () => ({
          userId: "u-1",
          userName: "admin",
          isAdmin: true,
          createdAt: 1_777_000_000_000,
        })),
        destroy: vi.fn(async () => {}),
      },
    });

    const response = await app.request("/api/auth/me", {
      headers: { Cookie: `${SESSION_COOKIE}=session-id-1` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: "u-1", userName: "admin", isAdmin: true });
  });

  it("answers 401 without a session", async () => {
    const { app } = build();

    expect((await app.request("/api/auth/me")).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run apps/server/src/api/routes/auth.test.ts
```

Expected: FAIL — cannot resolve `./auth.js`.

- [ ] **Step 3: Implement `routes/auth.ts`**

```ts
import { JellyfinAuthError } from "@jfstats/jellyfin";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { SessionStore } from "../sessions.js";
import type { RateLimiter } from "../rate-limit.js";

export const SESSION_COOKIE = "jfstats_session";

export interface AuthDeps {
  authenticateByName(
    username: string,
    password: string,
  ): Promise<{
    userId: string;
    userName: string;
    isAdmin: boolean;
    accessToken: string;
  }>;
  revokeToken(accessToken: string): Promise<void>;
  sessions: SessionStore;
  rateLimiter: RateLimiter;
  cookieSecure: boolean;
  sessionTtlHours: number;
  fallbackAdmin: { username: string; password: string } | null;
}

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export function registerAuthRoutes(app: Hono, deps: AuthDeps): void {
  app.post("/api/auth/login", async (c) => {
    const clientKey =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "unknown";

    const limit = await deps.rateLimiter.check(clientKey);
    if (!limit.allowed) {
      return c.json({ error: "too_many_attempts" }, 429);
    }

    const body = loginSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: "invalid_request" }, 400);
    }

    const { username, password } = body.data;

    // Checked before Jellyfin on purpose: the fallback exists precisely for when
    // Jellyfin is unreachable, so it cannot depend on reaching it.
    if (
      deps.fallbackAdmin !== null &&
      username === deps.fallbackAdmin.username &&
      password === deps.fallbackAdmin.password
    ) {
      const id = await deps.sessions.create({
        userId: "fallback-admin",
        userName: username,
        isAdmin: true,
        createdAt: Date.now(),
      });
      writeSessionCookie(c, id, deps);
      return c.json({ userId: "fallback-admin", userName: username, isAdmin: true });
    }

    let result: Awaited<ReturnType<AuthDeps["authenticateByName"]>>;

    try {
      result = await deps.authenticateByName(username, password);
    } catch (error) {
      if (error instanceof JellyfinAuthError && error.kind === "invalid_credentials") {
        return c.json({ error: "invalid_credentials" }, 401);
      }
      return c.json({ error: "jellyfin_unavailable" }, 503);
    }

    // Revoke regardless of the admin decision — we asked Jellyfin for a token we
    // never intend to use, and leaving it live is a credential we do not need.
    await deps.revokeToken(result.accessToken);

    if (!result.isAdmin) {
      return c.json({ error: "not_an_administrator" }, 403);
    }

    const id = await deps.sessions.create({
      userId: result.userId,
      userName: result.userName,
      isAdmin: true,
      createdAt: Date.now(),
    });
    writeSessionCookie(c, id, deps);

    return c.json({ userId: result.userId, userName: result.userName, isAdmin: true });
  });

  app.post("/api/auth/logout", async (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id !== undefined) {
      await deps.sessions.destroy(id);
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/auth/me", async (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    const session = id === undefined ? null : await deps.sessions.get(id);

    if (session === null) {
      return c.json({ error: "unauthenticated" }, 401);
    }

    return c.json({
      userId: session.userId,
      userName: session.userName,
      isAdmin: session.isAdmin,
    });
  });
}

function writeSessionCookie(
  c: Parameters<Parameters<Hono["post"]>[1]>[0],
  id: string,
  deps: AuthDeps,
): void {
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    secure: deps.cookieSecure,
    path: "/",
    maxAge: deps.sessionTtlHours * 60 * 60,
  });
}
```

- [ ] **Step 4: Wire into the app**

In `createApp`, after the health route:

```ts
const sessions = createSessionStore(context.redis, context.env.SESSION_TTL_HOURS * 60 * 60);
const rateLimiter = createRateLimiter(context.redis, { limit: 10, windowSeconds: 900 });

registerAuthRoutes(app, {
  authenticateByName: (u, p) => context.jellyfin.authenticateByName(u, p),
  revokeToken: (t) => context.jellyfin.revokeToken(t),
  sessions,
  rateLimiter,
  cookieSecure: context.env.COOKIE_SECURE,
  sessionTtlHours: context.env.SESSION_TTL_HOURS,
  fallbackAdmin:
    context.env.fallbackAdminEnabled &&
    context.env.FALLBACK_ADMIN_USER !== undefined &&
    context.env.FALLBACK_ADMIN_PASSWORD !== undefined
      ? {
          username: context.env.FALLBACK_ADMIN_USER,
          password: context.env.FALLBACK_ADMIN_PASSWORD,
        }
      : null,
});
```

The existing `app.test.ts` context stub will need `redis` and the new env fields; extend it minimally rather than making it a real connection.

- [ ] **Step 5: Run the tests**

```bash
pnpm vitest run apps/server/src/api/routes/auth.test.ts
```

Expected: PASS, 18 tests.

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add apps/server
git commit -m "Add authentication routes

Login delegates to Jellyfin and admits administrators only; a valid
non-admin account is refused with 403 and no session is created.

The Jellyfin access token is revoked immediately whether or not the account
turned out to be an administrator — we asked for a credential we never
intend to use, and leaving it live serves no purpose.

A rejected password answers 401 and an unreachable Jellyfin answers 503,
because telling an admin their password is wrong when their server is
offline sends them down entirely the wrong path.

The fallback admin is checked before Jellyfin, since it exists precisely for
when Jellyfin cannot be reached."
```

---

### Task 6: Admin middleware

**Files:**

- Create: `apps/server/src/api/middleware/auth.ts`
- Test: `apps/server/src/api/middleware/auth.test.ts`

**Interfaces:**

- Produces: `requireAdmin(sessions: SessionStore)` — Hono middleware setting `c.var.session` to a `SessionRecord`, or answering 401.

- [ ] **Step 1: Write the failing test**

`apps/server/src/api/middleware/auth.test.ts`:

```ts
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requireAdmin } from "./auth.js";
import { SESSION_COOKIE } from "../routes/auth.js";
import type { SessionRecord, SessionStore } from "../sessions.js";

const SESSION: SessionRecord = {
  userId: "u-1",
  userName: "admin",
  isAdmin: true,
  createdAt: 1_777_000_000_000,
};

function build(get: SessionStore["get"]) {
  const sessions: SessionStore = {
    create: vi.fn(async () => "x"),
    get,
    destroy: vi.fn(async () => {}),
  };
  const app = new Hono<{ Variables: { session: SessionRecord } }>();
  app.use("/api/protected", requireAdmin(sessions));
  app.get("/api/protected", (c) => c.json({ user: c.var.session.userName }));
  return app;
}

describe("requireAdmin", () => {
  it("allows a request carrying a valid admin session", async () => {
    const app = build(vi.fn(async () => SESSION));

    const response = await app.request("/api/protected", {
      headers: { Cookie: `${SESSION_COOKIE}=session-id-1` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: "admin" });
  });

  it("rejects a request with no cookie", async () => {
    const app = build(vi.fn(async () => SESSION));

    expect((await app.request("/api/protected")).status).toBe(401);
  });

  it("rejects an unknown or expired session id", async () => {
    const app = build(vi.fn(async () => null));

    const response = await app.request("/api/protected", {
      headers: { Cookie: `${SESSION_COOKIE}=stale-session` },
    });

    expect(response.status).toBe(401);
  });

  it("rejects a session whose isAdmin flag is false", async () => {
    const app = build(vi.fn(async () => ({ ...SESSION, isAdmin: false })));

    const response = await app.request("/api/protected", {
      headers: { Cookie: `${SESSION_COOKIE}=session-id-1` },
    });

    // Defence in depth: login already gates on this, but a stored session must
    // never grant access on its own.
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run apps/server/src/api/middleware/auth.test.ts
```

Expected: FAIL — cannot resolve `./auth.js`.

- [ ] **Step 3: Implement**

```ts
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE } from "../routes/auth.js";
import type { SessionRecord, SessionStore } from "../sessions.js";

export function requireAdmin(
  sessions: SessionStore,
): MiddlewareHandler<{ Variables: { session: SessionRecord } }> {
  return async (c, next) => {
    const id = getCookie(c, SESSION_COOKIE);
    const session = id === undefined ? null : await sessions.get(id);

    // Re-check isAdmin rather than trusting that login gated it. A session record
    // must never be sufficient on its own.
    if (session === null || !session.isAdmin) {
      return c.json({ error: "unauthenticated" }, 401);
    }

    c.set("session", session);
    await next();
  };
}
```

- [ ] **Step 4: Run, full suite, typecheck, commit**

```bash
pnpm vitest run apps/server/src/api/middleware/auth.test.ts && pnpm test && pnpm typecheck
git add apps/server
git commit -m "Add admin-only middleware

Re-checks the isAdmin flag rather than trusting that login gated it, so a
stored session record is never sufficient on its own to grant access."
```

---

### Task 7: Statistics repositories

Aggregate reads over `playback_rollup_daily`. Dashboards must never scan `playback_sessions` — that is the performance decision the whole rollup exists for.

**Files:**

- Create: `packages/db/src/repositories/stats.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/repositories/stats.test.ts`

**Interfaces:**

- Consumes: `Db`, `playbackRollupDaily`, `items`, `jellyfinUsers`, `libraries`, and `withTestDatabase` from `@jfstats/db/testing`.
- Produces:
  - `interface DateRange { from: string; to: string }` — inclusive `YYYY-MM-DD` UTC days
  - `getOverview(db, range: DateRange): Promise<{ plays: number; watchMs: number; activeUsers: number; activeItems: number }>`
  - `getWatchTimeSeries(db, range: DateRange): Promise<{ day: string; plays: number; watchMs: number }[]>`
  - `getTopItems(db, range: DateRange, options: { limit: number; libraryId?: string; userId?: string }): Promise<TopItem[]>`
  - `interface TopItem { itemId: string; name: string; type: string; libraryId: string | null; seriesId: string | null; imageTag: string | null; plays: number; watchMs: number }`

**Design points:**

- The series must include **days with no activity as zero rows**, or a chart will silently connect across gaps and misrepresent a quiet week. Generate the day spine in SQL.
- Every function takes an explicit range; there is no implicit "last 30 days" hidden in a query.

- [ ] **Step 1: Write the failing test**

`packages/db/src/repositories/stats.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { items, jellyfinUsers, libraries, playbackRollupDaily } from "../schema.js";
import { stopTestDatabase, withTestDatabase } from "../testing/harness.js";
import { getOverview, getTopItems, getWatchTimeSeries } from "./stats.js";
import type { Db } from "../client.js";

afterAll(stopTestDatabase);

async function seed(db: Db): Promise<void> {
  await db.insert(libraries).values([
    { id: "lib-movies", name: "Movies", collectionType: "movies" },
    { id: "lib-shows", name: "Shows", collectionType: "tvshows" },
  ]);
  await db.insert(jellyfinUsers).values([
    { id: "user-a", name: "alpha", isAdmin: true },
    { id: "user-b", name: "beta", isAdmin: false },
  ]);
  await db.insert(items).values([
    {
      id: "item-1",
      name: "First Movie",
      type: "Movie",
      libraryId: "lib-movies",
      imageTag: "tag-1",
    },
    { id: "item-2", name: "Second Movie", type: "Movie", libraryId: "lib-movies" },
    {
      id: "item-3",
      name: "An Episode",
      type: "Episode",
      libraryId: "lib-shows",
      seriesId: "series-1",
    },
  ]);
  await db.insert(playbackRollupDaily).values([
    {
      day: "2026-08-10",
      userId: "user-a",
      itemId: "item-1",
      libraryId: "lib-movies",
      playCount: 2,
      watchMs: 60_000,
    },
    {
      day: "2026-08-10",
      userId: "user-b",
      itemId: "item-2",
      libraryId: "lib-movies",
      playCount: 1,
      watchMs: 30_000,
    },
    {
      day: "2026-08-12",
      userId: "user-a",
      itemId: "item-3",
      libraryId: "lib-shows",
      playCount: 3,
      watchMs: 90_000,
    },
    // Outside every range used below.
    {
      day: "2026-07-01",
      userId: "user-a",
      itemId: "item-1",
      libraryId: "lib-movies",
      playCount: 9,
      watchMs: 999_000,
    },
  ]);
}

const RANGE = { from: "2026-08-10", to: "2026-08-12" };

describe("getOverview", () => {
  it("totals plays, watch time, and distinct users in range", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      expect(await getOverview(db, RANGE)).toEqual({
        plays: 6,
        watchMs: 180_000,
        activeUsers: 2,
        activeItems: 3,
      });
    });
  });

  it("excludes rows outside the range", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const result = await getOverview(db, { from: "2026-08-11", to: "2026-08-12" });

      expect(result).toEqual({ plays: 3, watchMs: 90_000, activeUsers: 1, activeItems: 1 });
    });
  });

  it("returns zeros rather than nulls for an empty range", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      expect(await getOverview(db, { from: "2020-01-01", to: "2020-01-02" })).toEqual({
        plays: 0,
        watchMs: 0,
        activeUsers: 0,
        activeItems: 0,
      });
    });
  });

  it("treats the range as inclusive of both endpoints", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const single = await getOverview(db, { from: "2026-08-12", to: "2026-08-12" });

      expect(single.plays).toBe(3);
    });
  });
});

describe("getWatchTimeSeries", () => {
  it("emits one row per day including days with no activity", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const series = await getWatchTimeSeries(db, RANGE);

      // A chart that skips empty days connects across them and misreports a quiet week.
      expect(series).toEqual([
        { day: "2026-08-10", plays: 3, watchMs: 90_000 },
        { day: "2026-08-11", plays: 0, watchMs: 0 },
        { day: "2026-08-12", plays: 3, watchMs: 90_000 },
      ]);
    });
  });

  it("returns all-zero rows for a range with no data at all", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const series = await getWatchTimeSeries(db, { from: "2020-01-01", to: "2020-01-03" });

      expect(series).toHaveLength(3);
      expect(series.every((row) => row.plays === 0 && row.watchMs === 0)).toBe(true);
    });
  });
});

describe("getTopItems", () => {
  it("ranks by watch time and joins item metadata", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const top = await getTopItems(db, RANGE, { limit: 10 });

      expect(top[0]).toMatchObject({
        itemId: "item-3",
        name: "An Episode",
        type: "Episode",
        plays: 3,
        watchMs: 90_000,
      });
      expect(top[1]).toMatchObject({ itemId: "item-1", name: "First Movie", watchMs: 60_000 });
      expect(top).toHaveLength(3);
    });
  });

  it("honours the limit", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      expect(await getTopItems(db, RANGE, { limit: 2 })).toHaveLength(2);
    });
  });

  it("filters by library", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const top = await getTopItems(db, RANGE, { limit: 10, libraryId: "lib-shows" });

      expect(top.map((row) => row.itemId)).toEqual(["item-3"]);
    });
  });

  it("filters by user", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const top = await getTopItems(db, RANGE, { limit: 10, userId: "user-b" });

      expect(top.map((row) => row.itemId)).toEqual(["item-2"]);
    });
  });

  it("carries the image tag through so posters can be requested", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const top = await getTopItems(db, RANGE, { limit: 10, libraryId: "lib-movies" });

      expect(top.find((row) => row.itemId === "item-1")?.imageTag).toBe("tag-1");
      expect(top.find((row) => row.itemId === "item-2")?.imageTag).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run packages/db/src/repositories/stats.test.ts
```

Expected: FAIL — cannot resolve `./stats.js`.

- [ ] **Step 3: Implement `stats.ts`**

```ts
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { items, playbackRollupDaily } from "../schema.js";

/** Inclusive `YYYY-MM-DD` UTC days. */
export interface DateRange {
  from: string;
  to: string;
}

export interface OverviewStats {
  plays: number;
  watchMs: number;
  activeUsers: number;
  activeItems: number;
}

export interface SeriesPoint {
  day: string;
  plays: number;
  watchMs: number;
}

export interface TopItem {
  itemId: string;
  name: string;
  type: string;
  libraryId: string | null;
  seriesId: string | null;
  imageTag: string | null;
  plays: number;
  watchMs: number;
}

export async function getOverview(db: Db, range: DateRange): Promise<OverviewStats> {
  const result = await db.execute<{
    plays: string;
    watch_ms: string;
    active_users: string;
    active_items: string;
  }>(sql`
    SELECT
      coalesce(sum(play_count), 0)::text          AS plays,
      coalesce(sum(watch_ms), 0)::text            AS watch_ms,
      count(DISTINCT user_id)::text               AS active_users,
      count(DISTINCT item_id)::text               AS active_items
    FROM ${playbackRollupDaily}
    WHERE day >= ${range.from} AND day <= ${range.to}
  `);

  const row = result.rows[0];

  return {
    plays: Number(row?.plays ?? 0),
    watchMs: Number(row?.watch_ms ?? 0),
    activeUsers: Number(row?.active_users ?? 0),
    activeItems: Number(row?.active_items ?? 0),
  };
}

export async function getWatchTimeSeries(db: Db, range: DateRange): Promise<SeriesPoint[]> {
  // generate_series supplies the day spine so quiet days appear as explicit zeros.
  // Without it a chart connects across gaps and a week with no viewing looks busy.
  const result = await db.execute<{ day: string; plays: string; watch_ms: string }>(sql`
    SELECT
      to_char(spine.day, 'YYYY-MM-DD')                 AS day,
      coalesce(sum(r.play_count), 0)::text             AS plays,
      coalesce(sum(r.watch_ms), 0)::text               AS watch_ms
    FROM generate_series(${range.from}::date, ${range.to}::date, interval '1 day') AS spine(day)
    LEFT JOIN ${playbackRollupDaily} r ON r.day = spine.day
    GROUP BY spine.day
    ORDER BY spine.day
  `);

  return result.rows.map((row) => ({
    day: row.day,
    plays: Number(row.plays),
    watchMs: Number(row.watch_ms),
  }));
}

export async function getTopItems(
  db: Db,
  range: DateRange,
  options: { limit: number; libraryId?: string; userId?: string },
): Promise<TopItem[]> {
  const filters = [
    sql`${playbackRollupDaily.day} >= ${range.from}`,
    sql`${playbackRollupDaily.day} <= ${range.to}`,
  ];

  if (options.libraryId !== undefined) {
    filters.push(sql`${playbackRollupDaily.libraryId} = ${options.libraryId}`);
  }

  if (options.userId !== undefined) {
    filters.push(sql`${playbackRollupDaily.userId} = ${options.userId}`);
  }

  const rows = await db
    .select({
      itemId: playbackRollupDaily.itemId,
      name: items.name,
      type: items.type,
      libraryId: items.libraryId,
      seriesId: items.seriesId,
      imageTag: items.imageTag,
      plays: sql<number>`sum(${playbackRollupDaily.playCount})::int`,
      watchMs: sql<number>`sum(${playbackRollupDaily.watchMs})::bigint`,
    })
    .from(playbackRollupDaily)
    .innerJoin(items, eq(items.id, playbackRollupDaily.itemId))
    .where(and(...filters))
    .groupBy(
      playbackRollupDaily.itemId,
      items.name,
      items.type,
      items.libraryId,
      items.seriesId,
      items.imageTag,
    )
    .orderBy(desc(sql`sum(${playbackRollupDaily.watchMs})`))
    .limit(options.limit);

  return rows.map((row) => ({ ...row, plays: Number(row.plays), watchMs: Number(row.watchMs) }));
}
```

Add `export * from "./repositories/stats.js";` to `packages/db/src/index.ts`.

- [ ] **Step 4: Run the tests**

```bash
pnpm vitest run packages/db/src/repositories/stats.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add packages/db
git commit -m "Add statistics repositories over the daily rollup

All aggregates read playback_rollup_daily rather than the session fact
table, which is the performance decision the rollup exists for.

The watch-time series generates its day spine in SQL so days with no
activity come back as explicit zeros; without them a chart connects across
the gap and a quiet week reads as a busy one.

Sums are returned as text and converted in TypeScript, because a bigint sum
exceeding Number.MAX_SAFE_INTEGER would silently lose precision."
```

---

### Task 8: Per-user and per-library repositories

**Files:**

- Modify: `packages/db/src/repositories/stats.ts`
- Test: `packages/db/src/repositories/stats.test.ts`

**Interfaces:**

- Produces:
  - `getUserStats(db, range: DateRange): Promise<UserStat[]>` where `interface UserStat { userId: string; name: string; isAdmin: boolean; plays: number; watchMs: number }`
  - `getLibraryStats(db, range: DateRange): Promise<LibraryStat[]>` where `interface LibraryStat { libraryId: string; name: string; collectionType: string | null; plays: number; watchMs: number }`
  - `getUserDetail(db, userId: string, range: DateRange): Promise<UserDetail | null>` where `interface UserDetail { userId: string; name: string; isAdmin: boolean; plays: number; watchMs: number; devices: { deviceId: string; name: string; plays: number }[] }`

**Design point:** a user who exists but watched nothing in range must still be returned with zeros, not omitted — otherwise the users page loses people the moment they take a week off.

- [ ] **Step 1: Append the failing tests**

```ts
describe("getUserStats", () => {
  it("returns every known user, including those with no activity in range", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const stats = await getUserStats(db, { from: "2026-08-12", to: "2026-08-12" });

      // user-b watched nothing that day but must not disappear from the list.
      expect(stats).toEqual([
        expect.objectContaining({ userId: "user-a", name: "alpha", plays: 3, watchMs: 90_000 }),
        expect.objectContaining({ userId: "user-b", name: "beta", plays: 0, watchMs: 0 }),
      ]);
    });
  });

  it("orders by watch time descending", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const stats = await getUserStats(db, RANGE);

      expect(stats.map((row) => row.userId)).toEqual(["user-a", "user-b"]);
    });
  });

  it("excludes archived users", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);
      await db.insert(jellyfinUsers).values({ id: "user-gone", name: "gone", archived: true });

      const stats = await getUserStats(db, RANGE);

      expect(stats.map((row) => row.userId)).not.toContain("user-gone");
    });
  });
});

describe("getLibraryStats", () => {
  it("returns every library with its totals, zero-filled", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const stats = await getLibraryStats(db, { from: "2026-08-12", to: "2026-08-12" });

      expect(stats).toEqual([
        expect.objectContaining({
          libraryId: "lib-shows",
          name: "Shows",
          plays: 3,
          watchMs: 90_000,
        }),
        expect.objectContaining({ libraryId: "lib-movies", name: "Movies", plays: 0, watchMs: 0 }),
      ]);
    });
  });
});

describe("getUserDetail", () => {
  it("returns totals for one user", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const detail = await getUserDetail(db, "user-a", RANGE);

      expect(detail).toMatchObject({ userId: "user-a", name: "alpha", plays: 5, watchMs: 150_000 });
    });
  });

  it("returns null for an unknown user rather than an empty shell", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      expect(await getUserDetail(db, "nobody", RANGE)).toBeNull();
    });
  });

  it("returns a known user with zeros when they watched nothing in range", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const detail = await getUserDetail(db, "user-b", { from: "2026-08-12", to: "2026-08-12" });

      expect(detail).toMatchObject({ userId: "user-b", plays: 0, watchMs: 0 });
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run packages/db/src/repositories/stats.test.ts
```

Expected: FAIL — `getUserStats` is not exported.

- [ ] **Step 3: Implement the three functions**

Append to `stats.ts`. The shape that matters is the **LEFT JOIN from the entity table to the rollup**, so entities with no activity survive:

```ts
export interface UserStat {
  userId: string;
  name: string;
  isAdmin: boolean;
  plays: number;
  watchMs: number;
}

export interface LibraryStat {
  libraryId: string;
  name: string;
  collectionType: string | null;
  plays: number;
  watchMs: number;
}

export interface UserDetail extends UserStat {
  devices: { deviceId: string; name: string; plays: number }[];
}

export async function getUserStats(db: Db, range: DateRange): Promise<UserStat[]> {
  // LEFT JOIN from users, not from the rollup: a user who took a week off must
  // still appear, with zeros, rather than vanishing from the list.
  const result = await db.execute<{
    user_id: string;
    name: string;
    is_admin: boolean;
    plays: string;
    watch_ms: string;
  }>(sql`
    SELECT
      u.id                                    AS user_id,
      u.name                                  AS name,
      u.is_admin                              AS is_admin,
      coalesce(sum(r.play_count), 0)::text    AS plays,
      coalesce(sum(r.watch_ms), 0)::text      AS watch_ms
    FROM jellyfin_users u
    LEFT JOIN playback_rollup_daily r
      ON r.user_id = u.id AND r.day >= ${range.from} AND r.day <= ${range.to}
    WHERE u.archived = false
    GROUP BY u.id, u.name, u.is_admin
    ORDER BY coalesce(sum(r.watch_ms), 0) DESC, u.name ASC
  `);

  return result.rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    isAdmin: row.is_admin,
    plays: Number(row.plays),
    watchMs: Number(row.watch_ms),
  }));
}

export async function getLibraryStats(db: Db, range: DateRange): Promise<LibraryStat[]> {
  const result = await db.execute<{
    library_id: string;
    name: string;
    collection_type: string | null;
    plays: string;
    watch_ms: string;
  }>(sql`
    SELECT
      l.id                                    AS library_id,
      l.name                                  AS name,
      l.collection_type                       AS collection_type,
      coalesce(sum(r.play_count), 0)::text    AS plays,
      coalesce(sum(r.watch_ms), 0)::text      AS watch_ms
    FROM libraries l
    LEFT JOIN playback_rollup_daily r
      ON r.library_id = l.id AND r.day >= ${range.from} AND r.day <= ${range.to}
    WHERE l.archived = false
    GROUP BY l.id, l.name, l.collection_type
    ORDER BY coalesce(sum(r.watch_ms), 0) DESC, l.name ASC
  `);

  return result.rows.map((row) => ({
    libraryId: row.library_id,
    name: row.name,
    collectionType: row.collection_type,
    plays: Number(row.plays),
    watchMs: Number(row.watch_ms),
  }));
}

export async function getUserDetail(
  db: Db,
  userId: string,
  range: DateRange,
): Promise<UserDetail | null> {
  const totals = await db.execute<{
    user_id: string;
    name: string;
    is_admin: boolean;
    plays: string;
    watch_ms: string;
  }>(sql`
    SELECT
      u.id AS user_id, u.name AS name, u.is_admin AS is_admin,
      coalesce(sum(r.play_count), 0)::text AS plays,
      coalesce(sum(r.watch_ms), 0)::text   AS watch_ms
    FROM jellyfin_users u
    LEFT JOIN playback_rollup_daily r
      ON r.user_id = u.id AND r.day >= ${range.from} AND r.day <= ${range.to}
    WHERE u.id = ${userId}
    GROUP BY u.id, u.name, u.is_admin
  `);

  const row = totals.rows[0];
  if (row === undefined) return null;

  // Device breakdown comes from the session table — it is per-user and small,
  // and the rollup deliberately does not carry device identity.
  const devices = await db.execute<{ device_id: string; name: string; plays: string }>(sql`
    SELECT
      s.device_id                        AS device_id,
      coalesce(d.name, 'Unknown device') AS name,
      count(*)::text                     AS plays
    FROM playback_sessions s
    LEFT JOIN devices d ON d.id = s.device_id
    WHERE s.user_id = ${userId}
      AND s.ended_at IS NOT NULL
      AND (s.started_at AT TIME ZONE 'UTC')::date >= ${range.from}::date
      AND (s.started_at AT TIME ZONE 'UTC')::date <= ${range.to}::date
      AND s.device_id IS NOT NULL
    GROUP BY s.device_id, d.name
    ORDER BY count(*) DESC
  `);

  return {
    userId: row.user_id,
    name: row.name,
    isAdmin: row.is_admin,
    plays: Number(row.plays),
    watchMs: Number(row.watch_ms),
    devices: devices.rows.map((device) => ({
      deviceId: device.device_id,
      name: device.name,
      plays: Number(device.plays),
    })),
  };
}
```

- [ ] **Step 4: Run, full suite, typecheck, commit**

```bash
pnpm vitest run packages/db/src/repositories/stats.test.ts && pnpm test && pnpm typecheck
git add packages/db
git commit -m "Add per-user and per-library statistics

Each query LEFT JOINs from the entity table to the rollup rather than the
other way round, so a user or library with no activity in the range still
appears with zeros instead of vanishing from the list the moment someone
takes a week off.

The device breakdown reads the session table directly, since the rollup
deliberately does not carry device identity."
```

---

### Task 9: Playback history repository

The one read that legitimately touches `playback_sessions`, because history is per-session by definition.

**Files:**

- Create: `packages/db/src/repositories/history.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/repositories/history.test.ts`

**Interfaces:**

- Produces:
  - `getHistory(db, options: HistoryOptions): Promise<{ rows: HistoryRow[]; total: number }>`
  - `interface HistoryOptions { limit: number; offset: number; userId?: string; libraryId?: string; from?: string; to?: string }`
  - `interface HistoryRow { id: string; userId: string; userName: string; itemId: string; itemName: string; itemType: string; seriesId: string | null; libraryId: string | null; deviceName: string | null; client: string | null; playMethod: string | null; startedAt: Date; endedAt: Date | null; watchMs: number; completed: boolean }`

**Design points:**

- Returns `total` alongside the page so a UI can render "showing 1–50 of 812" without a second endpoint.
- `limit` is **clamped in the repository**, not trusted from the caller — an unbounded limit is a trivial denial of service.
- Ordered by `started_at DESC`, which the `playback_sessions_user_started_idx` index supports.

- [ ] **Step 1: Write the failing test**

`packages/db/src/repositories/history.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { devices, items, jellyfinUsers, libraries, playbackSessions } from "../schema.js";
import { stopTestDatabase, withTestDatabase } from "../testing/harness.js";
import { getHistory } from "./history.js";
import type { Db } from "../client.js";

afterAll(stopTestDatabase);

const BASE = new Date("2026-08-16T20:00:00Z");

async function seed(db: Db): Promise<void> {
  await db.insert(libraries).values([{ id: "lib-1", name: "Movies", collectionType: "movies" }]);
  await db.insert(jellyfinUsers).values([
    { id: "user-a", name: "alpha" },
    { id: "user-b", name: "beta" },
  ]);
  await db.insert(items).values([
    { id: "item-1", name: "A Movie", type: "Movie", libraryId: "lib-1" },
    { id: "item-2", name: "Another", type: "Movie", libraryId: "lib-1" },
  ]);
  await db.insert(devices).values([{ id: "dev-1", name: "Living Room", client: "Jellyfin Web" }]);

  await db.insert(playbackSessions).values(
    Array.from({ length: 5 }, (_, index) => ({
      sessionId: `sess-${index}`,
      userId: index % 2 === 0 ? "user-a" : "user-b",
      itemId: index % 2 === 0 ? "item-1" : "item-2",
      deviceId: "dev-1",
      client: "Jellyfin Web",
      playMethod: "DirectPlay",
      startedAt: new Date(BASE.getTime() + index * 60_000),
      endedAt: new Date(BASE.getTime() + index * 60_000 + 30_000),
      lastSeenAt: new Date(BASE.getTime() + index * 60_000 + 30_000),
      watchMs: 30_000,
      completed: index === 0,
    })),
  );
}

describe("getHistory", () => {
  it("returns newest first with the total alongside the page", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const { rows, total } = await getHistory(db, { limit: 2, offset: 0 });

      expect(total).toBe(5);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.startedAt.getTime()).toBeGreaterThan(rows[1]?.startedAt.getTime() ?? 0);
    });
  });

  it("pages without overlapping or skipping", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const first = await getHistory(db, { limit: 2, offset: 0 });
      const second = await getHistory(db, { limit: 2, offset: 2 });

      const ids = [...first.rows, ...second.rows].map((row) => row.id);
      expect(new Set(ids).size).toBe(4);
    });
  });

  it("joins user, item, and device names", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const { rows } = await getHistory(db, { limit: 1, offset: 0 });

      expect(rows[0]).toMatchObject({
        userName: expect.any(String),
        itemName: expect.any(String),
        deviceName: "Living Room",
        client: "Jellyfin Web",
        playMethod: "DirectPlay",
      });
    });
  });

  it("filters by user, and total reflects the filter", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const { rows, total } = await getHistory(db, { limit: 50, offset: 0, userId: "user-b" });

      expect(total).toBe(2);
      expect(rows.every((row) => row.userId === "user-b")).toBe(true);
    });
  });

  it("filters by library", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const { total } = await getHistory(db, { limit: 50, offset: 0, libraryId: "lib-1" });

      expect(total).toBe(5);
    });
  });

  it("filters by date range on the start day", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const inRange = await getHistory(db, {
        limit: 50,
        offset: 0,
        from: "2026-08-16",
        to: "2026-08-16",
      });
      const outOfRange = await getHistory(db, {
        limit: 50,
        offset: 0,
        from: "2026-08-17",
        to: "2026-08-18",
      });

      expect(inRange.total).toBe(5);
      expect(outOfRange.total).toBe(0);
    });
  });

  it("clamps an absurd limit rather than trusting the caller", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      // An unbounded limit from a query string is a trivial denial of service.
      const { rows } = await getHistory(db, { limit: 100_000, offset: 0 });

      expect(rows.length).toBeLessThanOrEqual(200);
    });
  });

  it("returns an empty page and a zero total when nothing matches", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      expect(await getHistory(db, { limit: 50, offset: 0, userId: "nobody" })).toEqual({
        rows: [],
        total: 0,
      });
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run packages/db/src/repositories/history.test.ts
```

Expected: FAIL — cannot resolve `./history.js`.

- [ ] **Step 3: Implement `history.ts`**

```ts
import { sql } from "drizzle-orm";
import type { Db } from "../client.js";

export const MAX_HISTORY_LIMIT = 200;

export interface HistoryOptions {
  limit: number;
  offset: number;
  userId?: string;
  libraryId?: string;
  /** Inclusive `YYYY-MM-DD` UTC day, matched against the session's start day. */
  from?: string;
  to?: string;
}

export interface HistoryRow {
  id: string;
  userId: string;
  userName: string;
  itemId: string;
  itemName: string;
  itemType: string;
  seriesId: string | null;
  libraryId: string | null;
  deviceName: string | null;
  client: string | null;
  playMethod: string | null;
  startedAt: Date;
  endedAt: Date | null;
  watchMs: number;
  completed: boolean;
}

export async function getHistory(
  db: Db,
  options: HistoryOptions,
): Promise<{ rows: HistoryRow[]; total: number }> {
  // Clamped here rather than trusted from the caller: an unbounded limit from a
  // query string is a trivial denial of service.
  const limit = Math.min(Math.max(1, options.limit), MAX_HISTORY_LIMIT);
  const offset = Math.max(0, options.offset);

  const filters = [sql`true`];

  if (options.userId !== undefined) filters.push(sql`s.user_id = ${options.userId}`);
  if (options.libraryId !== undefined) filters.push(sql`i.library_id = ${options.libraryId}`);
  if (options.from !== undefined) {
    filters.push(sql`(s.started_at AT TIME ZONE 'UTC')::date >= ${options.from}::date`);
  }
  if (options.to !== undefined) {
    filters.push(sql`(s.started_at AT TIME ZONE 'UTC')::date <= ${options.to}::date`);
  }

  const where = sql.join(filters, sql` AND `);

  const rows = await db.execute<{
    id: string;
    user_id: string;
    user_name: string | null;
    item_id: string;
    item_name: string | null;
    item_type: string | null;
    series_id: string | null;
    library_id: string | null;
    device_name: string | null;
    client: string | null;
    play_method: string | null;
    started_at: Date;
    ended_at: Date | null;
    watch_ms: string;
    completed: boolean;
  }>(sql`
    SELECT
      s.id::text AS id, s.user_id, u.name AS user_name,
      s.item_id, i.name AS item_name, i.type AS item_type, i.series_id, i.library_id,
      d.name AS device_name, s.client, s.play_method,
      s.started_at, s.ended_at, s.watch_ms::text AS watch_ms, s.completed
    FROM playback_sessions s
    LEFT JOIN jellyfin_users u ON u.id = s.user_id
    LEFT JOIN items i         ON i.id = s.item_id
    LEFT JOIN devices d       ON d.id = s.device_id
    WHERE ${where}
    ORDER BY s.started_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const totals = await db.execute<{ total: string }>(sql`
    SELECT count(*)::text AS total
    FROM playback_sessions s
    LEFT JOIN items i ON i.id = s.item_id
    WHERE ${where}
  `);

  return {
    rows: rows.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      userName: row.user_name ?? "Unknown user",
      itemId: row.item_id,
      itemName: row.item_name ?? "Unknown item",
      itemType: row.item_type ?? "Unknown",
      seriesId: row.series_id,
      libraryId: row.library_id,
      deviceName: row.device_name,
      client: row.client,
      playMethod: row.play_method,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      watchMs: Number(row.watch_ms),
      completed: row.completed,
    })),
    total: Number(totals.rows[0]?.total ?? 0),
  };
}
```

Add `export * from "./repositories/history.js";` to `packages/db/src/index.ts`.

- [ ] **Step 4: Run, full suite, typecheck, commit**

```bash
pnpm vitest run packages/db/src/repositories/history.test.ts && pnpm test && pnpm typecheck
git add packages/db
git commit -m "Add paginated playback history repository

History is per-session by definition, so this is the one read that
legitimately touches the fact table rather than the rollup.

The limit is clamped inside the repository rather than trusted from the
caller, since an unbounded limit arriving from a query string is a trivial
denial of service, and the total is returned alongside the page so a UI can
show a range without a second request.

Items and users are LEFT JOINed so history for deleted media still renders
with a placeholder rather than disappearing."
```

---

### Task 10: Statistics and history routes

**Files:**

- Create: `apps/server/src/api/routes/stats.ts`, `apps/server/src/api/routes/history.ts`
- Modify: `apps/server/src/api/app.ts`
- Test: `apps/server/src/api/routes/stats.test.ts`

**Interfaces:**

- Produces: `registerStatsRoutes(app, deps: StatsDeps)` and `registerHistoryRoutes(app, deps: HistoryDeps)`, mounting:
  - `GET /api/stats/overview?from&to`
  - `GET /api/stats/series?from&to`
  - `GET /api/stats/top-items?from&to&limit&libraryId&userId`
  - `GET /api/stats/users?from&to`
  - `GET /api/stats/users/:userId?from&to`
  - `GET /api/stats/libraries?from&to`
  - `GET /api/history?limit&offset&userId&libraryId&from&to`
- Also produces `parseRange(query): DateRange` — shared date parsing with a **30-day default**.

**Design points:**

- Every route is behind `requireAdmin`.
- Dates are validated with a strict `YYYY-MM-DD` regex; a malformed date is a 400, never a silent default, because silently substituting a range makes a wrong chart look correct.
- `from` after `to` is a 400.

- [ ] **Step 1: Write the failing test**

`apps/server/src/api/routes/stats.test.ts`:

```ts
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { parseRange, registerStatsRoutes, type StatsDeps } from "./stats.js";

function build(overrides: Partial<StatsDeps> = {}) {
  const deps: StatsDeps = {
    getOverview: vi.fn(async () => ({ plays: 1, watchMs: 2, activeUsers: 3, activeItems: 4 })),
    getWatchTimeSeries: vi.fn(async () => [{ day: "2026-08-10", plays: 1, watchMs: 2 }]),
    getTopItems: vi.fn(async () => []),
    getUserStats: vi.fn(async () => []),
    getUserDetail: vi.fn(async () => null),
    getLibraryStats: vi.fn(async () => []),
    ...overrides,
  };
  const app = new Hono();
  registerStatsRoutes(app, deps);
  return { app, deps };
}

describe("parseRange", () => {
  it("defaults to the trailing 30 days ending today", () => {
    const range = parseRange({}, () => Date.parse("2026-08-17T12:00:00Z"));

    expect(range).toEqual({ from: "2026-07-19", to: "2026-08-17" });
  });

  it("accepts explicit dates", () => {
    expect(parseRange({ from: "2026-01-01", to: "2026-01-31" })).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
    });
  });

  it("rejects a malformed date instead of silently defaulting", () => {
    // A silent default makes a wrong chart look correct.
    expect(() => parseRange({ from: "yesterday", to: "2026-01-31" })).toThrow();
  });

  it("rejects an impossible date", () => {
    expect(() => parseRange({ from: "2026-02-30", to: "2026-03-01" })).toThrow();
  });

  it("rejects a reversed range", () => {
    expect(() => parseRange({ from: "2026-03-01", to: "2026-01-01" })).toThrow();
  });
});

describe("stats routes", () => {
  it("serves the overview", async () => {
    const { app } = build();

    const response = await app.request("/api/stats/overview?from=2026-08-10&to=2026-08-12");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plays: 1, watchMs: 2, activeUsers: 3, activeItems: 4 });
  });

  it("passes the parsed range to the repository", async () => {
    const { app, deps } = build();

    await app.request("/api/stats/overview?from=2026-08-10&to=2026-08-12");

    expect(deps.getOverview).toHaveBeenCalledWith({ from: "2026-08-10", to: "2026-08-12" });
  });

  it("answers 400 for a malformed date", async () => {
    const { app } = build();

    expect((await app.request("/api/stats/overview?from=nope&to=2026-08-12")).status).toBe(400);
  });

  it("clamps the top-items limit", async () => {
    const { app, deps } = build();

    await app.request("/api/stats/top-items?limit=100000");

    const call = (deps.getTopItems as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[2].limit).toBeLessThanOrEqual(100);
  });

  it("returns 404 for an unknown user rather than an empty object", async () => {
    const { app } = build({ getUserDetail: vi.fn(async () => null) });

    expect((await app.request("/api/stats/users/nobody")).status).toBe(404);
  });

  it("serves a known user's detail", async () => {
    const { app } = build({
      getUserDetail: vi.fn(async () => ({
        userId: "u-1",
        name: "alpha",
        isAdmin: false,
        plays: 2,
        watchMs: 5,
        devices: [],
      })),
    });

    const response = await app.request("/api/stats/users/u-1");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userId: "u-1", name: "alpha" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run apps/server/src/api/routes/stats.test.ts
```

Expected: FAIL — cannot resolve `./stats.js`.

- [ ] **Step 3: Implement `routes/stats.ts`**

```ts
import type {
  DateRange,
  LibraryStat,
  OverviewStats,
  SeriesPoint,
  TopItem,
  UserDetail,
  UserStat,
} from "@jfstats/db";
import type { Hono } from "hono";

export interface StatsDeps {
  getOverview(range: DateRange): Promise<OverviewStats>;
  getWatchTimeSeries(range: DateRange): Promise<SeriesPoint[]>;
  getTopItems(
    range: DateRange,
    options: { limit: number; libraryId?: string; userId?: string },
  ): Promise<TopItem[]>;
  getUserStats(range: DateRange): Promise<UserStat[]>;
  getUserDetail(userId: string, range: DateRange): Promise<UserDetail | null>;
  getLibraryStats(range: DateRange): Promise<LibraryStat[]>;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 30;
export const MAX_TOP_ITEMS = 100;

export class InvalidRangeError extends Error {}

function toUtcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function assertRealDate(value: string): void {
  if (!DAY_PATTERN.test(value)) {
    throw new InvalidRangeError(`Expected YYYY-MM-DD, received ${value}`);
  }
  // Date.parse rolls 2026-02-30 forward to March 2 rather than rejecting it, so
  // round-trip the parse to catch a day that does not exist.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new InvalidRangeError(`Not a real date: ${value}`);
  }
}

export function parseRange(
  query: { from?: string; to?: string },
  now: () => number = Date.now,
): DateRange {
  const today = toUtcDay(now());
  const from = query.from ?? toUtcDay(now() - (DEFAULT_RANGE_DAYS - 1) * 86_400_000);
  const to = query.to ?? today;

  assertRealDate(from);
  assertRealDate(to);

  if (from > to) {
    throw new InvalidRangeError("from must not be after to");
  }

  return { from, to };
}

export function registerStatsRoutes(app: Hono, deps: StatsDeps): void {
  const withRange =
    <T>(handler: (range: DateRange) => Promise<T>) =>
    async (c: Parameters<Parameters<Hono["get"]>[1]>[0]) => {
      let range: DateRange;
      try {
        range = parseRange(c.req.query());
      } catch (error) {
        if (error instanceof InvalidRangeError) return c.json({ error: "invalid_range" }, 400);
        throw error;
      }
      return c.json(await handler(range));
    };

  app.get(
    "/api/stats/overview",
    withRange((range) => deps.getOverview(range)),
  );
  app.get(
    "/api/stats/series",
    withRange((range) => deps.getWatchTimeSeries(range)),
  );
  app.get(
    "/api/stats/users",
    withRange((range) => deps.getUserStats(range)),
  );
  app.get(
    "/api/stats/libraries",
    withRange((range) => deps.getLibraryStats(range)),
  );

  app.get("/api/stats/top-items", async (c) => {
    let range: DateRange;
    try {
      range = parseRange(c.req.query());
    } catch (error) {
      if (error instanceof InvalidRangeError) return c.json({ error: "invalid_range" }, 400);
      throw error;
    }

    const requested = Number(c.req.query("limit") ?? 10);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(1, Math.trunc(requested)), MAX_TOP_ITEMS)
      : 10;

    return c.json(
      await deps.getTopItems(range, {
        limit,
        libraryId: c.req.query("libraryId"),
        userId: c.req.query("userId"),
      }),
    );
  });

  app.get("/api/stats/users/:userId", async (c) => {
    let range: DateRange;
    try {
      range = parseRange(c.req.query());
    } catch (error) {
      if (error instanceof InvalidRangeError) return c.json({ error: "invalid_range" }, 400);
      throw error;
    }

    const detail = await deps.getUserDetail(c.req.param("userId"), range);
    if (detail === null) return c.json({ error: "not_found" }, 404);

    return c.json(detail);
  });
}
```

- [ ] **Step 4: Implement `routes/history.ts`**

```ts
import type { HistoryOptions, HistoryRow } from "@jfstats/db";
import type { Hono } from "hono";
import { InvalidRangeError, parseRange } from "./stats.js";

export interface HistoryDeps {
  getHistory(options: HistoryOptions): Promise<{ rows: HistoryRow[]; total: number }>;
}

export function registerHistoryRoutes(app: Hono, deps: HistoryDeps): void {
  app.get("/api/history", async (c) => {
    const hasRange = c.req.query("from") !== undefined || c.req.query("to") !== undefined;

    let from: string | undefined;
    let to: string | undefined;

    if (hasRange) {
      try {
        ({ from, to } = parseRange(c.req.query()));
      } catch (error) {
        if (error instanceof InvalidRangeError) return c.json({ error: "invalid_range" }, 400);
        throw error;
      }
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);

    const result = await deps.getHistory({
      limit: Number.isFinite(limit) ? Math.trunc(limit) : 50,
      offset: Number.isFinite(offset) ? Math.trunc(offset) : 0,
      userId: c.req.query("userId"),
      libraryId: c.req.query("libraryId"),
      from,
      to,
    });

    return c.json(result);
  });
}
```

- [ ] **Step 5: Mount both behind the admin gate**

In `createApp`, after the auth routes:

```ts
app.use("/api/stats/*", requireAdmin(sessions));
app.use("/api/history", requireAdmin(sessions));

registerStatsRoutes(app, {
  getOverview: (range) => getOverview(context.db, range),
  getWatchTimeSeries: (range) => getWatchTimeSeries(context.db, range),
  getTopItems: (range, options) => getTopItems(context.db, range, options),
  getUserStats: (range) => getUserStats(context.db, range),
  getUserDetail: (userId, range) => getUserDetail(context.db, userId, range),
  getLibraryStats: (range) => getLibraryStats(context.db, range),
});

registerHistoryRoutes(app, { getHistory: (options) => getHistory(context.db, options) });
```

Add a test in `app.test.ts` asserting `GET /api/stats/overview` **without a cookie returns 401** — that is the proof the gate is actually mounted, not merely written.

- [ ] **Step 6: Run, full suite, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add apps/server
git commit -m "Add statistics and history routes behind the admin gate

Date ranges are validated strictly and a malformed date is a 400 rather than
a silent fallback, because substituting a default range makes a wrong chart
look correct.

The date validator round-trips its parse, since Date rolls an impossible day
like 2026-02-30 forward rather than rejecting it.

Result limits are clamped at the route as well as in the repository."
```

---

### Task 11: SSE live feed

The worker already publishes each poll's session list to a Redis channel. This exposes it to the browser.

**Files:**

- Create: `apps/server/src/api/routes/live.ts`
- Modify: `apps/server/src/api/app.ts`
- Test: `apps/server/src/api/routes/live.test.ts`

**Interfaces:**

- Consumes: `LIVE_CHANNEL` from `apps/server/src/sync/snapshot-store.js`.
- Produces: `registerLiveRoute(app, deps: LiveDeps)` mounting `GET /api/live`, and `interface LiveDeps { subscribe(onMessage: (payload: string) => void): Promise<() => Promise<void>>; loadCurrent(): Promise<LiveSession[]> }`.

**Design points — each of these is a real failure mode, not ceremony:**

- **A dedicated Redis connection.** An ioredis client in subscriber mode cannot run ordinary commands, so reusing `context.redis` would break the session store on the first SSE connection.
- **Send the current snapshot immediately on connect**, or the page shows nothing until the next poll — up to a full interval of apparent emptiness.
- **Heartbeat comments**, or an idle proxy closes the stream after 30–60s.
- **Unsubscribe on disconnect**, or every page refresh leaks a Redis connection.

- [ ] **Step 1: Write the failing test**

`apps/server/src/api/routes/live.test.ts`:

```ts
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerLiveRoute, type LiveDeps } from "./live.js";

const SESSION = {
  sessionId: "s-1",
  userId: "u-1",
  userName: "alpha",
  itemId: "i-1",
  itemName: "A Movie",
  deviceId: "d-1",
  deviceName: "Living Room",
  client: "Jellyfin Web",
  playMethod: "DirectPlay" as const,
  positionTicks: 10,
  runtimeTicks: 100,
  isPaused: false,
  remoteEndpoint: "192.0.2.10",
};

function build(overrides: Partial<LiveDeps> = {}) {
  const unsubscribe = vi.fn(async () => {});
  const deps: LiveDeps = {
    loadCurrent: vi.fn(async () => [SESSION]),
    subscribe: vi.fn(async () => unsubscribe),
    ...overrides,
  };
  const app = new Hono();
  registerLiveRoute(app, deps);
  return { app, deps, unsubscribe };
}

async function firstChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  const chunk = await reader?.read();
  await reader?.cancel();
  return new TextDecoder().decode(chunk?.value);
}

describe("GET /api/live", () => {
  it("responds with an event stream", async () => {
    const { app } = build();

    const response = await app.request("/api/live");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
  });

  it("sends the current snapshot immediately rather than waiting for the next poll", async () => {
    const { app, deps } = build();

    const response = await app.request("/api/live");
    const text = await firstChunk(response);

    expect(deps.loadCurrent).toHaveBeenCalled();
    expect(text).toContain("data:");
    expect(text).toContain("A Movie");
  });

  it("sends an empty array when nothing is playing, not an empty body", async () => {
    const { app } = build({ loadCurrent: vi.fn(async () => []) });

    const text = await firstChunk(await app.request("/api/live"));

    expect(text).toContain("data: []");
  });

  it("subscribes to the live channel", async () => {
    const { app, deps } = build();

    const response = await app.request("/api/live");
    await firstChunk(response);

    expect(deps.subscribe).toHaveBeenCalled();
  });

  it("still opens the stream when the snapshot cannot be read", async () => {
    const { app } = build({
      loadCurrent: vi.fn(async () => {
        throw new Error("redis down");
      }),
    });

    // A failed snapshot read must not stop the stream — the next poll recovers it.
    const response = await app.request("/api/live");

    expect(response.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run apps/server/src/api/routes/live.test.ts
```

Expected: FAIL — cannot resolve `./live.js`.

- [ ] **Step 3: Implement `routes/live.ts`**

```ts
import type { LiveSession } from "@jfstats/shared";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export interface LiveDeps {
  /** Resolves to an unsubscribe function. */
  subscribe(onMessage: (payload: string) => void): Promise<() => Promise<void>>;
  loadCurrent(): Promise<LiveSession[]>;
}

const HEARTBEAT_MS = 25_000;

export function registerLiveRoute(app: Hono, deps: LiveDeps): void {
  app.get("/api/live", (c) => {
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");

    return streamSSE(c, async (stream) => {
      // Send what is playing right now. Without this the page is blank until the
      // worker's next poll, which looks like nothing is playing.
      try {
        await stream.writeSSE({
          event: "sessions",
          data: JSON.stringify(await deps.loadCurrent()),
        });
      } catch {
        await stream.writeSSE({ event: "sessions", data: "[]" });
      }

      const unsubscribe = await deps.subscribe((payload) => {
        void stream.writeSSE({ event: "sessions", data: payload });
      });

      // Idle proxies close a silent stream; a comment frame keeps it open.
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" });
      }, HEARTBEAT_MS);

      stream.onAbort(() => {
        clearInterval(heartbeat);
        void unsubscribe();
      });

      // Hold the stream open until the client disconnects.
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    });
  });
}
```

- [ ] **Step 4: Wire it with a dedicated subscriber connection**

In `createApp`:

```ts
registerLiveRoute(app, {
  loadCurrent: async () => {
    const snapshot = await context.snapshots.load();
    return Object.values(snapshot) as unknown as LiveSession[];
  },
  subscribe: async (onMessage) => {
    // A subscribed ioredis client cannot run ordinary commands. Sharing
    // context.redis would break the session store on the first SSE connection.
    const subscriber = context.redis.duplicate();
    await subscriber.subscribe(LIVE_CHANNEL);
    subscriber.on("message", (_channel, payload) => onMessage(payload));
    return async () => {
      await subscriber.quit();
    };
  },
});
```

**Note for the implementer:** `snapshots.load()` returns a `SessionSnapshot` (a keyed record of `SessionSnapshotEntry`), which is **not** the same shape as `LiveSession[]`. Read `apps/server/src/sync/snapshot-store.ts` and decide honestly: either add a `loadLive()` to the snapshot store that keeps the full `LiveSession` payload, or have the worker publish and cache the full list. **Do not cast between the two shapes** — report the mismatch and your chosen fix in your report. The cast above is deliberately left as a marker; replacing it is part of this task.

- [ ] **Step 5: Run, full suite, typecheck, commit**

```bash
pnpm vitest run apps/server/src/api/routes/live.test.ts && pnpm test && pnpm typecheck
git add apps/server
git commit -m "Add SSE live session feed

Uses a dedicated Redis connection because a subscribed ioredis client cannot
run ordinary commands — sharing the shared client would break the session
store on the first stream that opened.

Sends the current snapshot on connect so the page is not blank until the
next poll, emits heartbeat frames so an idle proxy does not close the
stream, and unsubscribes on abort so a page refresh does not leak a
connection."
```

---

### Task 12: Poster image proxy

**Files:**

- Create: `apps/server/src/api/routes/images.ts`
- Modify: `apps/server/src/api/app.ts`
- Test: `apps/server/src/api/routes/images.test.ts`

**Interfaces:**

- Produces: `registerImageRoutes(app, deps: ImageDeps)` mounting `GET /api/images/items/:itemId`, and `interface ImageDeps { fetchImage(itemId: string, options: { tag?: string; maxWidth: number }): Promise<Response> }`.

**Design points:**

- The proxy exists so the browser never needs the Jellyfin API key or direct network access to the server.
- It must be **behind the admin gate**. An open image proxy lets anyone enumerate a private media library.
- `maxWidth` is clamped — an unbounded value makes Jellyfin transcode arbitrarily large images on demand.

- [ ] **Step 1: Write the failing test**

`apps/server/src/api/routes/images.test.ts`:

```ts
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerImageRoutes, type ImageDeps } from "./images.js";

function build(overrides: Partial<ImageDeps> = {}) {
  const deps: ImageDeps = {
    fetchImage: vi.fn(
      async () =>
        new Response("binary", { status: 200, headers: { "content-type": "image/jpeg" } }),
    ),
    ...overrides,
  };
  const app = new Hono();
  registerImageRoutes(app, deps);
  return { app, deps };
}

describe("GET /api/images/items/:itemId", () => {
  it("streams the upstream image with its content type", async () => {
    const { app } = build();

    const response = await app.request("/api/images/items/item-1");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  it("passes the tag through so cached art busts correctly", async () => {
    const { app, deps } = build();

    await app.request("/api/images/items/item-1?tag=abc123");

    expect(deps.fetchImage).toHaveBeenCalledWith(
      "item-1",
      expect.objectContaining({ tag: "abc123" }),
    );
  });

  it("clamps maxWidth so a caller cannot force huge transcodes", async () => {
    const { app, deps } = build();

    await app.request("/api/images/items/item-1?maxWidth=99999");

    const call = (deps.fetchImage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[1].maxWidth).toBeLessThanOrEqual(1000);
  });

  it("sets a long cache header, since art is immutable for a given tag", async () => {
    const { app } = build();

    const response = await app.request("/api/images/items/item-1?tag=abc123");

    expect(response.headers.get("cache-control")).toContain("max-age=");
  });

  it("answers 404 when Jellyfin has no image for the item", async () => {
    const { app } = build({
      fetchImage: vi.fn(async () => new Response(null, { status: 404 })),
    });

    expect((await app.request("/api/images/items/missing")).status).toBe(404);
  });

  it("answers 502 when Jellyfin is unreachable", async () => {
    const { app } = build({
      fetchImage: vi.fn(async () => {
        throw new Error("network");
      }),
    });

    expect((await app.request("/api/images/items/item-1")).status).toBe(502);
  });

  it("does not leak the upstream error message", async () => {
    const { app } = build({
      fetchImage: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:8096");
      }),
    });

    const response = await app.request("/api/images/items/item-1");

    expect(await response.text()).not.toContain("10.0.0.5");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run apps/server/src/api/routes/images.test.ts
```

Expected: FAIL — cannot resolve `./images.js`.

- [ ] **Step 3: Implement `routes/images.ts`**

```ts
import type { Hono } from "hono";

export interface ImageDeps {
  fetchImage(itemId: string, options: { tag?: string; maxWidth: number }): Promise<Response>;
}

export const MAX_IMAGE_WIDTH = 1000;
const DEFAULT_WIDTH = 400;
const CACHE_SECONDS = 60 * 60 * 24 * 30;

export function registerImageRoutes(app: Hono, deps: ImageDeps): void {
  app.get("/api/images/items/:itemId", async (c) => {
    const requested = Number(c.req.query("maxWidth") ?? DEFAULT_WIDTH);
    const maxWidth = Number.isFinite(requested)
      ? Math.min(Math.max(1, Math.trunc(requested)), MAX_IMAGE_WIDTH)
      : DEFAULT_WIDTH;

    let upstream: Response;

    try {
      upstream = await deps.fetchImage(c.req.param("itemId"), {
        tag: c.req.query("tag"),
        maxWidth,
      });
    } catch {
      // The upstream message can name an internal host; it never reaches the client.
      return c.json({ error: "image_unavailable" }, 502);
    }

    if (upstream.status === 404) return c.json({ error: "not_found" }, 404);
    if (!upstream.ok) return c.json({ error: "image_unavailable" }, 502);

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
        // Art for a given tag never changes; the tag changes when the art does.
        "Cache-Control": `private, max-age=${CACHE_SECONDS}`,
      },
    });
  });
}
```

- [ ] **Step 4: Wire it behind the gate**

In `createApp`, before the route registration:

```ts
app.use("/api/images/*", requireAdmin(sessions));

registerImageRoutes(app, {
  fetchImage: async (itemId, options) => {
    const url = new URL(`${context.env.JELLYFIN_URL}/Items/${itemId}/Images/Primary`);
    url.searchParams.set("maxWidth", String(options.maxWidth));
    if (options.tag !== undefined) url.searchParams.set("tag", options.tag);

    return fetch(url, {
      headers: { Authorization: `MediaBrowser Token="${context.env.JELLYFIN_API_KEY}"` },
      signal: AbortSignal.timeout(15_000),
    });
  },
});
```

Add a test to `app.test.ts` asserting `GET /api/images/items/x` without a cookie is 401 — an open image proxy would let anyone enumerate a private library.

- [ ] **Step 5: Run, full suite, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add apps/server
git commit -m "Add poster image proxy behind the admin gate

Lets the browser render art without ever holding the Jellyfin API key or
needing direct network access to the media server.

Gated like every other route: an open image proxy would let anyone
enumerate a private library. maxWidth is clamped so a caller cannot force
arbitrarily large transcodes, and upstream error messages are never
returned, since they can name an internal host."
```

---

### Task 13: Compose service, README, and end-to-end verification

**Files:**

- Modify: `docker-compose.yml`, `README.md`, `apps/server/package.json`
- Test: `apps/server/src/api/app.test.ts` (gate assertions)

- [ ] **Step 1: Add the API to compose**

Add an `api` service alongside `postgres` and `redis`, running the same image with the API entrypoint, publishing `${API_PORT:-3000}:3000`, depending on `postgres` and `redis` with `condition: service_healthy`, and `restart: unless-stopped`.

**Note:** Plan 1 has no production Dockerfile — `dev:worker` and `dev:api` run on the host via `tsx`. If no Dockerfile exists, add the compose service **commented out** with a note that it activates in Plan 3, rather than shipping a service that references a nonexistent image. State clearly in your report which you did.

- [ ] **Step 2: Verify the whole API against the real stack**

With `docker compose up -d`, the worker running, and real data present:

```bash
pnpm --filter @jfstats/server dev:api
```

Then, in another terminal, confirm each of these and paste the results into your report:

```bash
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/health
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/stats/overview
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/history
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/images/items/anything
```

Expected: `200`, then `401`, `401`, `401`. **Every protected route must reject an unauthenticated request** — this is the single most important check in this task.

Then ask the repo owner to log in themselves through the API (they type their own password; you never see or handle it) and, with the resulting cookie, confirm `/api/stats/overview` returns real numbers. If they decline, record that the authenticated path is verified by tests only.

- [ ] **Step 3: Document in the README**

Add an **API** section listing every endpoint, its query parameters, and its auth requirement. Document `COOKIE_SECURE` with the plain-HTTP caveat, and `dev:api`. Use placeholder values only.

- [ ] **Step 4: Full suite, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add .
git commit -m "Add API compose service, documentation, and end-to-end verification

Documents every endpoint and its auth requirement, and records that each
protected route rejects an unauthenticated request."
```

---

## Self-Review

**Spec coverage.** Every Plan 2 requirement in the spec maps to a task: Jellyfin-delegated login with no stored password → Task 2, 5; admin-only gate → Tasks 5, 6; immediate token revocation → Task 5; opaque httpOnly `SameSite=Lax` cookie with Redis-backed sliding sessions → Tasks 3, 4, 5; per-IP login rate limiting → Tasks 3, 5; opt-in fallback admin checked before Jellyfin → Task 5; dashboard reads served from the rollup → Tasks 7, 8, 10; history with filtering → Tasks 9, 10; SSE live feed off the worker's Redis channel → Task 11; image proxy so the browser needs neither the API key nor direct Jellyfin access → Task 12; `AppType` export for Plan 3's typed client → Task 1.

**Deferred to Plan 3, by design:** all UI, the three-layer component architecture, the production multi-stage Dockerfile, and the Playwright smoke test.

**Carried from Plan 1's follow-ups:** Task 1 fixes the entrypoint-guard shape that silently no-ops a compiled build (follow-up 11) for the new API entrypoint; the worker's own guard is untouched and remains open.

**Known risk, flagged rather than hidden.** Task 11's `loadCurrent` has a genuine type mismatch: the snapshot store holds `SessionSnapshot`, not `LiveSession[]`. The task instructs the implementer to resolve it properly and forbids casting between the shapes. This is the most likely place for Plan 2 to need a design decision mid-flight.

**Verification bar.** Task 2 and Task 13 both require checking against the real Jellyfin server, because Plan 1's most expensive defects all came from fixtures confirming their own assumptions. Neither task is complete on unit tests alone.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-17-api-and-auth.md`.
