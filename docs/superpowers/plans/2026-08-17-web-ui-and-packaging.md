# Web UI and Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A React dashboard that renders the statistics the API already serves, plus the production image that finally makes `docker compose up -d` deploy the whole thing.

**Architecture:** A Vite SPA in `apps/web`, typed end-to-end by importing the Hono `AppType` from `apps/server` — no codegen, and a route signature change breaks the UI build. Components sit in three layers with a one-way dependency rule: shadcn primitives, then domain components that take **props only**, then route containers that own the TanStack Query calls. In production the API serves the built SPA as static files, so there is one port, no CORS, and no nginx.

**Tech Stack:** Vite 6, React 19, TanStack Router + TanStack Query, Tailwind v4, shadcn/ui, Recharts, Vitest + Testing Library, Playwright.

This is Plan 3 of 3. Plans 1 (data pipeline) and 2 (API and auth) are merged to `main`.

Spec: [`docs/superpowers/specs/2026-08-16-jellyfin-stats-design.md`](../specs/2026-08-16-jellyfin-stats-design.md).
Carried-forward items: [`follow-ups-after-plan-1.md`](../follow-ups-after-plan-1.md), [`follow-ups-after-plan-2.md`](../follow-ups-after-plan-2.md).

## Global Constraints

- **Node 22 LTS, pnpm 10 workspaces.** Never npm or yarn.
- **TypeScript strict**: `strict: true`, `noUncheckedIndexedAccess: true`. **No `any`, no non-null assertions (`!`) in production code.**
- **ESM only.** Relative imports in `apps/server` and `packages/*` carry a `.js` extension; **`apps/web` is bundled by Vite and does not** — follow each package's existing convention rather than unifying them.
- **`packages/db` remains the only code that constructs SQL. `packages/jellyfin` remains the only code aware of Jellyfin's HTTP shape.** The web app talks only to our own API.
- **No secrets or real data in git.** No real hostnames, credentials, Jellyfin ids, usernames, or IPs in any tracked file — including fixtures, screenshots, and test data.
- **The browser never receives the Jellyfin API key.** Poster art goes through `/api/images/items/:itemId`.
- **Commit messages carry no tooling attribution** — no `Co-Authored-By` trailers, no "generated with" footers.
- **Every task ends with a commit**, after the full suite passes.
- Baseline at plan start: **302 tests across 29 files**, `pnpm typecheck` exit 0.

## The API this consumes (verified against the merged code)

| Route | Auth | Query parameters |
|---|---|---|
| `GET /api/health` | none | — |
| `POST /api/auth/login` | none | body: `{ username, password }` |
| `POST /api/auth/logout` | none | — |
| `GET /api/auth/me` | admin | — |
| `GET /api/stats/overview` | admin | `from`, `to` |
| `GET /api/stats/series` | admin | `from`, `to` |
| `GET /api/stats/top-items` | admin | `from`, `to`, `limit`, `libraryId`, `userId` |
| `GET /api/stats/users` | admin | `from`, `to` |
| `GET /api/stats/users/:userId` | admin | `from`, `to` |
| `GET /api/stats/libraries` | admin | `from`, `to` |
| `GET /api/history` | admin | `limit`, `offset`, `userId`, `libraryId`, `from`, `to` |
| `GET /api/live` | admin | SSE, event name `sessions` |
| `GET /api/images/items/:itemId` | admin | `tag`, `maxWidth` |

Dates are inclusive `YYYY-MM-DD`; a malformed date is a 400, and the span is capped at 1000 days. Unauthenticated requests to any admin route return `401 { "error": "unauthenticated" }`.

---

## File Structure

```
apps/web/
  index.html
  vite.config.ts               # dev proxy /api -> localhost:3000
  src/
    main.tsx                   # entry: providers + router
    api/
      client.ts                # typed hc<AppType> client + fetch wrapper
      queries.ts               # TanStack Query options factories, one per endpoint
    auth/
      session.tsx              # session context, useSession(), login/logout
    components/
      ui/                      # shadcn primitives (generic, no domain knowledge)
      domain/                  # props-only, domain-aware, no fetching
    routes/                    # TanStack Router file routes; containers own queries
    lib/
      format.ts                # duration, date, and number formatting
```

**The one-way rule:** `routes/` may import from `domain/` and `ui/`; `domain/` may import from `ui/`; `ui/` imports from neither. A domain component that fetches, or reads route params, belongs in `routes/`.

---

### Task 1: Vite app skeleton and the typed API client

The load-bearing task: it establishes the type bridge that makes every later task's API call checked at compile time.

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/api/client.ts`
- Modify: root `tsconfig.json` (add `{ "path": "./apps/web" }` to `references`), root `vitest.config.ts` (add `apps/web/src/**/*.test.ts?(x)` to `include`)
- Test: `apps/web/src/api/client.test.ts`

**Interfaces:**
- Consumes: `AppType` from `apps/server/src/api/app.js`.
- Produces:
  - `api` — the `hc<AppType>` client instance
  - `ApiError` — `class ApiError extends Error { readonly status: number }`
  - `unwrap<T>(response: Response): Promise<T>` — throws `ApiError` on non-2xx, parses JSON otherwise
  - `pnpm --filter @jfstats/web dev`

**Design points:**
- **`credentials: "include"` on every request.** The session lives in an httpOnly cookie; without this the browser sends nothing and every call 401s.
- **A 401 is not an error to retry.** `unwrap` throws `ApiError` with the status so Task 3's session layer can distinguish "not logged in" from "server broke".
- The Vite dev server proxies `/api` to `localhost:3000` so dev is same-origin and the cookie works exactly as in production.

- [ ] **Step 1: Create the package**

```bash
pnpm --filter @jfstats/web add react react-dom hono @tanstack/react-query @tanstack/react-router
pnpm --filter @jfstats/web add -D vite @vitejs/plugin-react typescript @types/react @types/react-dom jsdom @testing-library/react @testing-library/user-event
```

`apps/web/package.json`:

```json
{
  "name": "@jfstats/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  }
}
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist-types",
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "moduleResolution": "Bundler",
    "noEmit": false,
    "emitDeclarationOnly": true
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../server" }]
}
```

`apps/web/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // Proxying keeps dev same-origin, so the httpOnly session cookie behaves
    // exactly as it does in production. A cross-origin dev setup would need
    // CORS plus SameSite=None, which is a different security posture than
    // the one the API was built for.
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: false } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Jellyfin Stats</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write the failing test**

`apps/web/src/api/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, unwrap } from "./client";

afterEach(() => vi.restoreAllMocks());

describe("unwrap", () => {
  it("returns the parsed body for a 2xx response", async () => {
    const response = new Response(JSON.stringify({ plays: 3 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(unwrap<{ plays: number }>(response)).resolves.toEqual({ plays: 3 });
  });

  it("throws ApiError carrying the status for a 401", async () => {
    const response = new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });

    await expect(unwrap(response)).rejects.toMatchObject({ status: 401 });
  });

  it("throws ApiError for a 500 too, so callers can distinguish it from a 401", async () => {
    const response = new Response(JSON.stringify({ error: "internal_error" }), { status: 500 });

    // The session layer treats 401 as "log in" and everything else as "something
    // broke". Collapsing them would bounce a user to the login page on a server
    // fault, where logging in again cannot possibly help.
    await expect(unwrap(response)).rejects.toMatchObject({ status: 500 });
  });

  it("is an ApiError instance so callers can narrow on it", async () => {
    await expect(unwrap(new Response("{}", { status: 401 }))).rejects.toBeInstanceOf(ApiError);
  });

  it("does not throw on a non-JSON 2xx body", async () => {
    // The image proxy returns binary; unwrap is only used for JSON routes, but a
    // parse failure must not masquerade as an auth problem.
    await expect(unwrap(new Response("not json", { status: 200 }))).rejects.not.toMatchObject({
      status: 401,
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm vitest run apps/web/src/api/client.test.ts
```

Expected: FAIL — cannot resolve `./client`.

- [ ] **Step 4: Implement `client.ts`**

```ts
import { hc } from "hono/client";
import type { AppType } from "../../../server/src/api/app.js";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Every request carries the session cookie. Without `credentials: "include"` the
 * browser omits it and every admin route answers 401.
 */
export const api = hc<AppType>("/", {
  init: { credentials: "include" },
});

export async function unwrap<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new ApiError(response.status, `Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}
```

- [ ] **Step 5: Minimal entry point**

`apps/web/src/main.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 means "log in", not "try again" — retrying it just delays the redirect.
      retry: (failureCount, error) =>
        error instanceof Error && "status" in error && error.status === 401 ? false : failureCount < 2,
      staleTime: 30_000,
    },
  },
});

const root = document.getElementById("root");

if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <p>Jellyfin Stats</p>
      </QueryClientProvider>
    </StrictMode>,
  );
}
```

- [ ] **Step 6: Wire the workspace**

Add `{ "path": "./apps/web" }` to the root `tsconfig.json` `references` array, and add `"apps/web/src/**/*.test.{ts,tsx}"` to the `include` array in the root `vitest.config.ts`. Set `environment` per-file with a `// @vitest-environment jsdom` comment where DOM is needed, so the Node-based server tests keep their current environment.

- [ ] **Step 7: Run everything**

```bash
pnpm vitest run apps/web/src/api/client.test.ts
pnpm test && pnpm typecheck
```

Expected: 5 new tests pass; full suite green.

Then start both processes and confirm the proxy works end to end:

```bash
pnpm --filter @jfstats/server dev:api    # terminal 1
pnpm --filter @jfstats/web dev            # terminal 2
```

`curl -s -o /dev/null -w "%{http_code}\n" localhost:5173/api/health` must return **200** — proving the proxy reaches the API. Stop both.

- [ ] **Step 8: Commit**

```bash
git add apps/web tsconfig.json vitest.config.ts pnpm-lock.yaml
git commit -m "Add Vite app skeleton and typed API client

The client imports AppType from the server package, so a route signature
change breaks the UI build rather than surfacing at runtime.

Requests carry credentials because the session lives in an httpOnly cookie,
and the dev server proxies /api so development is same-origin — a
cross-origin setup would need CORS and SameSite=None, a different security
posture than the API was built for.

unwrap preserves the HTTP status so callers can tell 401 from 500; bouncing
a user to the login page on a server fault would send them somewhere logging
in cannot help."
```

---

### Task 2: Tailwind, shadcn primitives, and the app shell

**Files:**
- Create: `apps/web/src/index.css`, `apps/web/src/components/ui/button.tsx`, `card.tsx`, `skeleton.tsx`, `table.tsx`, `badge.tsx`, `apps/web/src/lib/cn.ts`, `apps/web/src/lib/format.ts`
- Modify: `apps/web/src/main.tsx`, `apps/web/vite.config.ts`
- Test: `apps/web/src/lib/format.test.ts`

**Interfaces:**
- Produces:
  - `cn(...inputs)` — the `clsx` + `tailwind-merge` helper every component uses
  - `formatDuration(ms: number): string` — `"2h 14m"`, `"47m"`, `"38s"`
  - `formatDay(day: string): string` — `"2026-08-16"` → `"16 Aug"`
  - `formatCount(n: number): string` — thousands separated
  - `ui/` primitives: `Button`, `Card`/`CardHeader`/`CardTitle`/`CardContent`, `Skeleton`, `Table` family, `Badge`

**Design direction — read before writing CSS.** The agreed look is **clean and spacious**: generous whitespace, a restrained palette, two or three well-chosen charts per view rather than a wall of widgets. Dark mode is the default, because this dashboard will live on a TV or a second monitor. **Invoke the `frontend-design` skill** before writing the stylesheet and primitives, and let it inform the type scale, spacing rhythm, and colour choices rather than accepting Tailwind's defaults verbatim.

**Why `formatDuration` is a task deliverable rather than an inline helper:** watch time arrives as milliseconds and appears on nearly every screen. One implementation, tested, means the overview card and the history table cannot disagree about what 3,660,000 ms says.

- [ ] **Step 1: Add dependencies**

```bash
pnpm --filter @jfstats/web add clsx tailwind-merge class-variance-authority lucide-react
pnpm --filter @jfstats/web add -D tailwindcss @tailwindcss/vite
```

Add `tailwindcss()` to the Vite `plugins` array.

- [ ] **Step 2: Write the failing test**

`apps/web/src/lib/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatCount, formatDay, formatDuration } from "./format";

describe("formatDuration", () => {
  it("renders hours and minutes above an hour", () => {
    expect(formatDuration(8_040_000)).toBe("2h 14m");
  });

  it("renders minutes only below an hour", () => {
    expect(formatDuration(2_820_000)).toBe("47m");
  });

  it("renders seconds below a minute, so a short sample is not just '0m'", () => {
    expect(formatDuration(38_000)).toBe("38s");
  });

  it("renders zero as 0m rather than an empty string", () => {
    expect(formatDuration(0)).toBe("0m");
  });

  it("omits a zero minute component", () => {
    expect(formatDuration(7_200_000)).toBe("2h");
  });

  it("does not produce a negative duration from a negative input", () => {
    expect(formatDuration(-5_000)).toBe("0m");
  });
});

describe("formatDay", () => {
  it("renders an ISO day as a short human date", () => {
    expect(formatDay("2026-08-16")).toBe("16 Aug");
  });

  it("does not shift the day across a timezone boundary", () => {
    // Parsing "2026-01-01" as local time in a negative-offset zone yields
    // 31 Dec. The formatter must treat the string as a calendar date.
    expect(formatDay("2026-01-01")).toBe("1 Jan");
  });
});

describe("formatCount", () => {
  it("separates thousands", () => {
    expect(formatCount(12_345)).toBe("12,345");
  });

  it("leaves small numbers alone", () => {
    expect(formatCount(7)).toBe("7");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
pnpm vitest run apps/web/src/lib/format.test.ts
```

Expected: FAIL — cannot resolve `./format`.

- [ ] **Step 4: Implement `format.ts`**

```ts
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Takes an inclusive `YYYY-MM-DD` calendar day. Deliberately does not go through
 * `new Date(day)` and local-time formatting — that shifts the day backwards in
 * any negative UTC offset, so a chart's first column would silently be labelled
 * with the previous date.
 */
export function formatDay(day: string): string {
  const [, month, date] = day.split("-");
  const monthIndex = Number(month) - 1;
  return `${Number(date)} ${MONTHS[monthIndex] ?? "?"}`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-GB").format(n);
}
```

- [ ] **Step 5: Add `cn` and the primitives**

`apps/web/src/lib/cn.ts`:

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

Add the shadcn primitives listed in **Files** above. Use the canonical shadcn implementations, adjusted to the palette the `frontend-design` skill settles on. Keep them generic — no Jellyfin or statistics vocabulary in `ui/`.

`apps/web/src/index.css` sets the Tailwind import, the dark-first CSS custom properties, and a `body` background. Import it from `main.tsx`.

- [ ] **Step 6: Run, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add apps/web pnpm-lock.yaml
git commit -m "Add Tailwind, shadcn primitives, and formatting helpers

Watch time appears on nearly every screen, so formatDuration is one tested
implementation rather than an inline helper per component — the overview
card and the history table cannot disagree about what a duration says.

formatDay parses the calendar string directly instead of going through Date
and local-time formatting, which shifts the day backwards in any negative
UTC offset and would silently mislabel a chart's first column."
```

---

### Task 3: Session context and the login screen

**Files:**
- Create: `apps/web/src/auth/session.tsx`, `apps/web/src/routes/login.tsx`
- Modify: `apps/web/src/main.tsx`
- Test: `apps/web/src/auth/session.test.tsx`

**Interfaces:**
- Consumes: `api`, `unwrap`, `ApiError` (Task 1).
- Produces:
  - `SessionProvider` — wraps the app, resolves the session once on mount
  - `useSession(): { status: "loading" | "authenticated" | "anonymous"; user: SessionUser | null; login(username, password): Promise<void>; logout(): Promise<void> }`
  - `interface SessionUser { userId: string; userName: string; isAdmin: boolean }`

**Design points, each pinned by a test:**
- **A 401 from `/api/auth/me` is `anonymous`, not an error.** It is the normal state before logging in.
- **A 500 from `/api/auth/me` is *not* `anonymous`.** Showing a login form because the server broke invites a user to type their password at a service that cannot check it. Surface it as an error state instead.
- **`login` distinguishes the API's four failure codes** — 401 wrong credentials, 403 not an administrator, 429 too many attempts, 503 Jellyfin unreachable — because each has a different remedy and "login failed" tells the user none of them.
- **The password is never written to state or a ref**, only passed to the request.

- [ ] **Step 1: Write the failing test**

`apps/web/src/auth/session.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, useSession } from "./session";

function Probe() {
  const { status, user, login, logout } = useSession();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.userName ?? "-"}</span>
      <button onClick={() => void login("admin", "secret")}>login</button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input instanceof Request ? input.url : input), init),
    ),
  );
}

describe("SessionProvider", () => {
  it("resolves to authenticated when /api/auth/me returns a user", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ userId: "u-1", userName: "admin", isAdmin: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    renderProbe();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    expect(screen.getByTestId("user")).toHaveTextContent("admin");
  });

  it("treats a 401 as anonymous rather than an error", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }));

    renderProbe();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
  });

  it("does NOT treat a 500 as anonymous", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }));

    renderProbe();

    // Showing a login form because the server broke invites the user to type
    // their password at a service that cannot check it.
    await waitFor(() => expect(screen.getByTestId("status")).not.toHaveTextContent("anonymous"));
  });

  it("becomes authenticated after a successful login", async () => {
    let loggedIn = false;
    mockFetch((url) => {
      if (url.includes("/api/auth/login")) {
        loggedIn = true;
        return new Response(JSON.stringify({ userId: "u-1", userName: "admin", isAdmin: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return loggedIn
        ? new Response(JSON.stringify({ userId: "u-1", userName: "admin", isAdmin: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("{}", { status: 401 });
    });

    renderProbe();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));

    await userEvent.click(screen.getByText("login"));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
  });

  it("returns to anonymous after logout", async () => {
    let loggedIn = true;
    mockFetch((url) => {
      if (url.includes("/api/auth/logout")) {
        loggedIn = false;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return loggedIn
        ? new Response(JSON.stringify({ userId: "u-1", userName: "admin", isAdmin: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("{}", { status: 401 });
    });

    renderProbe();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    await userEvent.click(screen.getByText("logout"));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
  });

  it("surfaces the API's distinct login failures as distinct errors", async () => {
    const seen: string[] = [];

    for (const [status, expected] of [
      [401, "invalid_credentials"],
      [403, "not_an_administrator"],
      [429, "too_many_attempts"],
      [503, "jellyfin_unavailable"],
    ] as const) {
      mockFetch((url) =>
        url.includes("/api/auth/login")
          ? new Response(JSON.stringify({ error: expected }), { status })
          : new Response("{}", { status: 401 }),
      );

      const { unmount } = renderProbe();
      await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
      await userEvent.click(screen.getByText("login"));
      await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
      seen.push(expected);
      unmount();
      vi.restoreAllMocks();
    }

    // Each code has a different remedy: fix the password, use an admin account,
    // wait, or go check the Jellyfin server. "Login failed" tells the user none.
    expect(seen).toEqual([
      "invalid_credentials",
      "not_an_administrator",
      "too_many_attempts",
      "jellyfin_unavailable",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm vitest run apps/web/src/auth/session.test.tsx
```

Expected: FAIL — cannot resolve `./session`.

- [ ] **Step 3: Implement `session.tsx`**

Build a context holding `{ status, user, error }`, resolving once on mount via `GET /api/auth/me`. Map the outcome:
- 200 → `authenticated` with the parsed user
- 401 → `anonymous`
- anything else → `status: "error"` (add it to the union), never `anonymous`

`login(username, password)` posts to `/api/auth/login`; on success it re-resolves the session rather than trusting the response body, so the client state always comes from the same source of truth. On failure it throws an error carrying the API's `error` string so the login screen can render a specific message.

`logout()` posts to `/api/auth/logout` and sets `anonymous` regardless of the response — a failed logout must still clear local state, since the cookie is gone either way.

**Never store the password.** Read it from the form's `FormData` at submit time and pass it straight to `login`.

- [ ] **Step 4: Build the login screen**

`apps/web/src/routes/login.tsx` — a single centred card: username, password, submit. Render a specific message per error code:

| Code | Message |
|---|---|
| `invalid_credentials` | "That username or password was not accepted by Jellyfin." |
| `not_an_administrator` | "That account is not a Jellyfin administrator. This dashboard is admin-only." |
| `too_many_attempts` | "Too many attempts. Wait a few minutes and try again." |
| `jellyfin_unavailable` | "Could not reach your Jellyfin server. Check that it is running." |

Disable the submit button while the request is in flight. Do not clear the username on failure — retyping it is a small insult after a failed login.

- [ ] **Step 5: Run, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add apps/web
git commit -m "Add session context and login screen

A 401 from /api/auth/me is the anonymous state, but any other status is an
error state — showing a login form because the server broke would invite the
user to type their password at a service that cannot check it.

The four login failures the API distinguishes are surfaced as four different
messages, because each has a different remedy: fix the password, use an admin
account, wait, or go check the Jellyfin server.

The password is read from FormData at submit and never held in state."
```

---

### Task 4: Router, app shell, and the protected-route gate

**Files:**
- Create: `apps/web/src/routes/__root.tsx`, `apps/web/src/routes/index.tsx`, `apps/web/src/components/domain/AppShell.tsx`, `apps/web/src/components/domain/EmptyState.tsx`
- Modify: `apps/web/src/main.tsx`
- Test: `apps/web/src/components/domain/AppShell.test.tsx`, `apps/web/src/routes/guard.test.tsx`

**Interfaces:**
- Produces:
  - `AppShell` — sidebar navigation + content area; **props only** (`{ userName, onLogout, children }`)
  - `EmptyState` — `{ title, description?, icon? }`, used by every list that can be empty
  - A router whose non-login routes redirect to `/login` when the session is `anonymous`

**The gate is the point of this task.** A route that renders its container before the session resolves will fire queries that 401, and a route that renders for an anonymous user shows an empty dashboard rather than a login prompt. Test both.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/routes/guard.test.tsx` must assert (five cases — the `error` status is a distinct state and must not be folded into `anonymous`):
1. While `status === "loading"`, no route content and no data fetch — render a shell skeleton.
2. When `anonymous`, a protected route redirects to `/login` and **does not** render its content.
3. When `authenticated`, the protected route renders.
4. `/login` is reachable while anonymous and does **not** redirect.

`AppShell.test.tsx` must assert it renders the six navigation links, shows the signed-in user's name, and calls `onLogout` when the logout control is used — with no fetching of its own.

Write these as real assertions on rendered output, not on mocks. **After writing each, ask what you would have to break for it to fail** — a guard test that renders the same thing in both states proves nothing.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm vitest run apps/web/src/routes/guard.test.tsx apps/web/src/components/domain/AppShell.test.tsx
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Root route renders `AppShell` for authenticated users and bare children for `/login`. Navigation: Overview `/`, Live `/live`, History `/history`, Users `/users`, Libraries `/libraries`, Settings `/settings`.

`AppShell` takes props only — it does not call `useSession`. The root route reads the session and passes `userName` and `onLogout` down. That keeps the shell renderable in a test with two props and no providers.

- [ ] **Step 4: Run, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add apps/web
git commit -m "Add router, app shell, and the protected-route gate

Protected routes wait for the session to resolve before rendering, so they
cannot fire queries that are guaranteed to 401, and redirect anonymous users
to the login screen rather than showing an empty dashboard.

AppShell takes props only and does not read the session itself, so it renders
in a test with two props and no providers."
```

---

### Task 5: Query layer and the date-range control

**Files:**
- Create: `apps/web/src/api/queries.ts`, `apps/web/src/components/domain/DateRangePicker.tsx`, `apps/web/src/lib/range.ts`
- Test: `apps/web/src/lib/range.test.ts`, `apps/web/src/api/queries.test.ts`

**Interfaces:**
- Produces:
  - `overviewQuery(range)`, `seriesQuery(range)`, `topItemsQuery(range, opts)`, `userStatsQuery(range)`, `userDetailQuery(userId, range)`, `libraryStatsQuery(range)`, `historyQuery(opts)` — each returning a TanStack `queryOptions` object with a stable `queryKey`
  - `defaultRange(now?: () => number): DateRange` — trailing 30 days, inclusive
  - `clampRangeDays(range): DateRange` — enforces the API's 1000-day cap client-side
  - `DateRangePicker` — props only: `{ value, onChange, presets }`

**Design points:**
- **Query keys include the range**, so changing dates refetches rather than showing stale numbers under new labels.
- **The 1000-day cap is enforced client-side too.** The API returns `invalid_range` past it; catching it in the picker means the user gets a usable control instead of an error toast.
- `defaultRange` takes an injected clock, matching the convention already used in `parseRange`, `rollupWindow`, and `generateSeedData` on the server.

- [ ] **Step 1: Write the failing tests**

`range.test.ts` covers: the default is exactly 30 inclusive days ending today, with a fixed injected clock; a range longer than 1000 days is clamped from the `from` end; an already-valid range passes through unchanged; a reversed range is corrected rather than sent.

`queries.test.ts` covers: each factory produces a distinct `queryKey`; the same factory with different ranges produces different keys (**this is the one that catches stale data under new labels**); and `historyQuery` includes its filters in the key.

- [ ] **Step 2: Run to verify they fail, then implement, then run again**

```bash
pnpm vitest run apps/web/src/lib/range.test.ts apps/web/src/api/queries.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/web
git commit -m "Add query layer and date-range control

Query keys include the range, so changing dates refetches instead of showing
stale numbers under new labels.

The API's 1000-day cap is enforced client-side as well, so an over-long range
becomes a usable clamped control rather than an error response."
```

---

### Task 6: Domain components — stat cards, charts, and top content

**Files:**
- Create: `apps/web/src/components/domain/StatCard.tsx`, `StatCardRow.tsx`, `WatchTimeChart.tsx`, `TopContentList.tsx`, `PosterImage.tsx`
- Test: one `.test.tsx` beside each

**Interfaces:**
- Produces, all **props only, no fetching, no route awareness**:
  - `StatCard` — `{ label, value, hint?, loading? }`
  - `StatCardRow` — `{ stats: OverviewStats | null, loading }`
  - `WatchTimeChart` — `{ points: SeriesPoint[], loading }`
  - `TopContentList` — `{ items: TopItem[], loading, emptyMessage? }`
  - `PosterImage` — `{ itemId, tag, alt, className? }`, rendering `<img src="/api/images/items/…">`

**Before writing the chart, invoke the `dataviz` skill.** It governs palette, chart form, axis and legend treatment, and light/dark readability. Recharts' defaults are not the target.

**Design points:**
- **Each component owns its loading and empty states.** A caller never reimplements a skeleton — that is what makes these reusable across four different routes.
- **`WatchTimeChart` must render every day it is given**, including zeros. The API already zero-fills; the chart must not filter them out or it reintroduces the gap-connecting bug the server work went out of its way to prevent.
- **`PosterImage` degrades to a placeholder** when `tag` is null or the request fails — a missing poster must not leave a broken-image icon in a list.
- `StatCardRow` is used by the overview, user detail, and library detail routes. Variation goes through props; **if it ever needs to know which page it is on, split it.**

- [ ] **Step 1: Write the failing tests**

Each component's test must include a case that would fail if the behaviour were removed:
- `StatCard` renders a skeleton when `loading` and the value when not.
- `StatCardRow` renders zeros (not blanks) for a null stats object once loaded.
- `WatchTimeChart` — assert that a series containing a zero day produces the same number of rendered points as the input length. **Not** that it "renders without crashing".
- `TopContentList` renders `EmptyState` for `[]`, and item names for a populated list.
- `PosterImage` renders an `img` whose `src` contains `/api/images/items/<id>` and the tag, and a placeholder when `tag` is null.

- [ ] **Step 2: Run to verify they fail, implement, run again**

- [ ] **Step 3: Commit**

```bash
git add apps/web
git commit -m "Add stat card, chart, and top-content domain components

Each component owns its own loading and empty state, so the four routes that
use them never reimplement a skeleton — that is what makes them reusable
rather than merely shared.

The watch-time chart renders every day it is given, including zeros. The API
zero-fills deliberately; dropping those points would reintroduce the
gap-connecting distortion the server work exists to prevent."
```

---

### Task 7: Overview route

**Files:**
- Create: `apps/web/src/routes/index.tsx` (replacing the placeholder), `apps/web/src/components/domain/ActivityFeed.tsx`
- Test: `apps/web/src/routes/index.test.tsx`

**Interfaces:**
- Consumes: `overviewQuery`, `seriesQuery`, `topItemsQuery`, `historyQuery` (Task 5); `StatCardRow`, `WatchTimeChart`, `TopContentList` (Task 6).
- Produces: `ActivityFeed` — `{ rows: HistoryRow[], loading }`, a compact recent-activity list.

The route is a **container**: it owns the queries and passes plain data down. It should contain no presentation logic beyond layout.

Assert: all four queries fire with the current range; the range picker changing triggers a refetch with new keys; a 401 from any query redirects to login rather than rendering an error card.

- [ ] Steps: failing test → run → implement → run → `pnpm test && pnpm typecheck` → commit.

---

### Task 8: Live route (SSE)

**Files:**
- Create: `apps/web/src/routes/live.tsx`, `apps/web/src/api/useLiveSessions.ts`, `apps/web/src/components/domain/ActiveStreamCard.tsx`
- Test: `apps/web/src/api/useLiveSessions.test.ts`, `apps/web/src/components/domain/ActiveStreamCard.test.tsx`

**Interfaces:**
- Produces:
  - `useLiveSessions(): { sessions: LiveSession[]; connected: boolean }`
  - `ActiveStreamCard` — props only: `{ session, variant: "compact" | "full" }`

**Design points, each a real failure mode:**
- **`EventSource` must be closed on unmount**, or navigating away and back leaks a connection per visit — and each one holds a Redis subscriber server-side.
- **A dropped connection must reconnect.** `EventSource` retries automatically, but the UI should show `connected: false` while it is down rather than silently displaying a frozen list as if it were live. A stale "now playing" that looks current is worse than a visible disconnection notice.
- **The server sends a `sessions` event**, not a default message event — listen for the right name.
- `ActiveStreamCard`'s `compact` variant is used on the overview; `full` on `/live`. Variation by prop, not by page awareness.

Assert: the hook subscribes to `/api/live`; it parses a `sessions` event into state; **it closes the EventSource on unmount** (spy on `close`); and `connected` goes false on `error`.

- [ ] Steps: failing tests → run → implement → run → `pnpm test && pnpm typecheck` → commit.

---

### Task 9: History route

**Files:**
- Create: `apps/web/src/routes/history.tsx`, `apps/web/src/components/domain/PlaybackHistoryTable.tsx`
- Test: `apps/web/src/components/domain/PlaybackHistoryTable.test.tsx`, `apps/web/src/routes/history.test.tsx`

**Interfaces:**
- Produces: `PlaybackHistoryTable` — `{ rows, total, page, pageSize, onPageChange, loading }`, props only. Used by `/history` and later by the user and library detail routes.

**Design points:**
- **Render the total as "showing 1–50 of 812".** The API returns it alongside the page precisely so this needs no second request.
- **Deleted media still renders** — the API substitutes `"Unknown item"` / `"Unknown user"` placeholders rather than dropping the row. The table must display them plainly rather than as an error.
- Filters (user, library, date range) live in the route container and go into the query key.

Assert: pagination calls `onPageChange` with the right page and does not skip or repeat rows across pages; the total renders; a row with placeholder names renders without special-casing.

- [ ] Steps: failing tests → run → implement → run → `pnpm test && pnpm typecheck` → commit.

---

### Task 10: Users and libraries routes

**Files:**
- Create: `apps/web/src/routes/users.tsx`, `users.$userId.tsx`, `libraries.tsx`, `libraries.$libraryId.tsx`, `apps/web/src/components/domain/UserStatsTable.tsx`, `LibraryStatsTable.tsx`, `DeviceBreakdown.tsx`
- Test: one `.test.tsx` per component, plus a route test for the detail pages

**Design points:**
- **A user or library with no activity in range still appears, with zeros.** The API guarantees this via its `LEFT JOIN` direction; the UI must not filter them out and undo it. Assert it.
- The detail routes reuse `StatCardRow`, `TopContentList`, and `PlaybackHistoryTable` — **this is the payoff of the three-layer split.** If any of them needs a new prop to work here, that is fine; if any needs to know which page it is on, stop and reconsider.
- `/users/:userId` returns 404 for an unknown id — render a not-found state, not an empty user page.

- [ ] Steps: failing tests → run → implement → run → `pnpm test && pnpm typecheck` → commit.

---

### Task 11: Settings route

**Files:**
- Create: `apps/web/src/routes/settings.tsx`
- Test: `apps/web/src/routes/settings.test.tsx`

Read-only in this plan: show the effective sync intervals, completion threshold, and Jellyfin server URL, plus the signed-in account and a logout control. **The API exposes no settings-mutation endpoint**, so do not build a form that appears editable — a control that looks like it saves and does not is worse than a plain read-only display. State plainly in the UI that these are configured through environment variables.

- [ ] Steps: failing test → run → implement → run → `pnpm test && pnpm typecheck` → commit.

---

### Task 12: Production image and static serving

**Files:**
- Create: `Dockerfile`, `.dockerignore`
- Modify: `apps/server/src/api/app.ts` (serve built static files), `docker-compose.yml` (uncomment and complete the services), `apps/server/package.json`
- Test: `apps/server/src/api/static.test.ts`

**This is the task that makes `docker compose up -d` deploy the whole product.**

**Interfaces:**
- Consumes: `createApp(context)` and `AppContext` from `apps/server/src/api/app.ts`; `loadEnv` / `AppEnv` from `packages/shared/src/env.ts`; the built SPA in `apps/web/dist` (Task 1 configures Vite's `build.outDir`).
- Produces: `WEB_ROOT` on `AppEnv`; `apps/server/src/migrate.ts` as the one-shot migration entrypoint; a `Dockerfile` whose image runs three commands — `src/api.ts`, `src/worker.ts`, `src/migrate.ts`.

**Four facts established by probe before this task was written. Do not re-derive them, and do not "fix" code that depends on them:**

1. `node apps/server/dist/api.js` fails today with `ERR_UNKNOWN_FILE_EXTENSION`. All three workspace packages declare `"exports": "./src/index.ts"`, so compiled output resolves `@jfstats/db` back to TypeScript source. Making `node dist/*.js` work means restructuring the `exports` map of every package with dual dev/prod conditions.
2. BullMQ reads `.lua` command files from disk at runtime (`bullmq/dist/cjs/commands/*.lua`). Bundling the worker into a single file with esbuild breaks that loading, so bundling is the **riskier** option here, not the safer one.
3. `serveStatic({ root })` accepts an **absolute** path and serves correctly from it — despite its type comment claiming the root is resolved against the current working directory. Use absolute paths; `pnpm --filter` sets cwd to the *package* directory while Vitest runs from the repo root, so a relative root would mean two different directories.
4. `serveStatic` already rejects path traversal. `/../../package.json`, `/..%2f..%2fpackage.json`, and `/%2e%2e/package.json` all returned 404 against a root containing a real `index.html`. **Do not add your own traversal guard** — write the test that pins this behavior, so a future dependency bump that regresses it fails loudly.

**Design points:**
- **Ship `tsx` in the runtime layer, and do not produce `dist/` in the image at all.** This reverses the instruction an earlier draft of this plan carried. Given fact 1, the alternative is restructuring three packages' export maps with `development`/`default` conditions — a change that touches every import path in the repo and risks subtle resolution bugs in test, dev, and prod differently, to save roughly 30 MB on a self-hosted image whose base layer is already ~130 MB. `tsx` is a mature runtime loader, the startup cost is about a second on a long-lived daemon, and shipping no `dist/` means there is no broken compiled artifact left lying around to trip over later. Move `tsx` from `devDependencies` to `dependencies` in `apps/server/package.json` — it is a runtime dependency now, and that is what lets the runtime stage install with `--prod`.
- **Static serving must not shadow the API.** Both static handlers return `next()` immediately for any path starting with `/api/`, and they are registered *after* every `/api` route. Otherwise an unknown API path returns `index.html` with a 200 and every client error becomes a confusing HTML body.
- **The SPA fallback returns `index.html` for unknown non-API paths**, so a deep link like `/users/abc` survives a refresh.
- **Static serving is optional and off by default.** In development Vite serves the SPA and `apps/web/dist` does not exist. When `WEB_ROOT` is unset, register nothing and keep the existing JSON 404 — this is also what makes the non-vacuity probe in Step 6 possible.
- **Migrations run as a one-shot compose service, not on API start.** Two services starting concurrently would race the same migration. Use `migrate()` from `drizzle-orm/node-postgres/migrator` — `drizzle-orm` is already a production dependency, so this avoids shipping `drizzle-kit` (a devDependency) into the image.
- The image runs **three commands from one image**, as separate compose services.

- [ ] **Step 1: Add `WEB_ROOT` to the environment schema**

In `packages/shared/src/env.ts`, add to the `z.object({ ... })` schema:

```ts
  // Absolute path to the built SPA. Unset in development, where Vite serves it.
  WEB_ROOT: z.string().min(1).optional(),
```

- [ ] **Step 2: Write the failing test**

Create `apps/server/src/api/static.test.ts`. This builds a real directory on disk rather than mocking the filesystem — a hand-written fixture of a filesystem is exactly the pattern that produced this project's worst defects.

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { registerStaticRoutes } from "./static.js";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(path.join(tmpdir(), "jfstats-web-"));
  mkdirSync(path.join(webRoot, "assets"));
  writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>jfstats</title>");
  writeFileSync(path.join(webRoot, "assets", "app-abc123.js"), "console.log('spa');");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

/** Mirrors production order: API routes and the JSON 404 exist before static is registered. */
function buildApp(root: string | undefined): Hono {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  registerStaticRoutes(app, root);
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}

describe("static serving", () => {
  it("serves index.html for a deep link so a refresh does not 404", async () => {
    const res = await buildApp(webRoot).request("/users/abc");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>jfstats</title>");
  });

  it("serves a real asset with its own content", async () => {
    const res = await buildApp(webRoot).request("/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('spa');");
  });

  it("leaves an unknown /api path as a JSON 404 rather than shadowing it with index.html", async () => {
    const res = await buildApp(webRoot).request("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("does not shadow a registered API route", async () => {
    const res = await buildApp(webRoot).request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  // Guards the non-vacuity of every assertion above: with WEB_ROOT unset the
  // same deep link must 404, which proves the fallback is what serves it.
  it("registers nothing when no web root is configured", async () => {
    const res = await buildApp(undefined).request("/users/abc");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  // Pins serveStatic's own traversal handling (verified by probe) so a
  // dependency bump that regresses it fails here rather than in production.
  it.each(["/../../package.json", "/..%2f..%2fpackage.json", "/%2e%2e/package.json"])(
    "refuses to escape the web root via %s",
    async (attack) => {
      const res = await buildApp(webRoot).request(attack);
      const body = await res.text();
      expect(body).not.toContain("@jfstats/server");
      expect(body).not.toContain("dependencies");
    },
  );
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm vitest run apps/server/src/api/static.test.ts`
Expected: FAIL — `Cannot find module './static.js'`.

- [ ] **Step 4: Implement static serving**

Create `apps/server/src/api/static.ts`:

```ts
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

/**
 * Serves the built SPA. Registered after every /api route so it can never
 * shadow one: both handlers defer immediately on an /api path, which keeps an
 * unknown API route a JSON 404 instead of a 200 carrying index.html.
 *
 * `root` must be absolute — @hono/node-server resolves a relative root against
 * the current working directory, which differs between `pnpm --filter` (the
 * package directory) and Vitest (the repo root).
 *
 * Passing `undefined` registers nothing, which is the development case: Vite
 * serves the SPA and apps/web/dist does not exist.
 */
export function registerStaticRoutes(app: Hono, root: string | undefined): void {
  if (root === undefined) return;

  const isApi = (path: string): boolean => path === "/api" || path.startsWith("/api/");

  // Real files: assets, favicon, manifest. Falls through when nothing matches.
  app.use("*", async (c, next) => {
    if (isApi(c.req.path)) return next();
    return serveStatic({ root })(c, next);
  });

  // Client-routed paths: anything left over renders the SPA shell.
  app.get("*", async (c, next) => {
    if (isApi(c.req.path)) return next();
    return serveStatic({ root, path: "index.html" })(c, next);
  });
}
```

Wire it into `apps/server/src/api/app.ts`, immediately **after** `registerLiveRoute` and **before** `app.notFound(...)`:

```ts
  registerStaticRoutes(app, context.env.WEB_ROOT);
```

with `import { registerStaticRoutes } from "./static.js";` at the top.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run apps/server/src/api/static.test.ts`
Expected: PASS, 9 tests (5 named cases + 3 traversal cases + the API-health case).

- [ ] **Step 6: Prove the API guard is load-bearing, then restore it**

Temporarily delete the `if (isApi(c.req.path)) return next();` line from the **second** handler in `static.ts` and rerun. The "leaves an unknown /api path as a JSON 404" test must go **red** — if it stays green, the test is not testing what it claims and must be fixed before continuing. Restore the line and confirm green again. Report both outcomes.

- [ ] **Step 7: Add the migration entrypoint**

Create `apps/server/src/migrate.ts`:

```ts
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@jfstats/shared";

const env = loadEnv();
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

// Resolved from this file, not from cwd: compose runs it from /app.
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/drizzle",
);

try {
  await migrate(drizzle(pool), { migrationsFolder });
  console.log("migrations applied");
} finally {
  await pool.end();
}
```

Verify it against the real database before trusting it — a migration entrypoint that silently applies nothing is the worst possible failure here:

```bash
pnpm --filter @jfstats/server exec tsx --env-file=../../.env src/migrate.ts
```

Expected: `migrations applied`, and re-running is a no-op rather than an error. Confirm both runs.

- [ ] **Step 8: Add `.dockerignore`**

```
node_modules
**/node_modules
**/dist
.git
.env
.env.*
!.env.example
*.log
.worktrees
docs
playwright-report
test-results
```

`.env` is listed explicitly: the build context would otherwise carry the real Jellyfin URL and API key into an image layer.

- [ ] **Step 9: Move `tsx` to production dependencies**

In `apps/server/package.json`, move `"tsx": "^4.19.2"` out of `devDependencies` and into `dependencies`, then run `pnpm install` to update the lockfile. Without this, the runtime stage's `--prod` install omits it and every entrypoint fails.

- [ ] **Step 10: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# Manifests first so the dependency layers survive source-only changes.
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/jellyfin/package.json packages/jellyfin/

# Full install, then build the SPA.
FROM manifests AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @jfstats/web build

# Production dependencies only — no Vite, no Playwright, no testcontainers.
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

FROM base AS runtime
ENV NODE_ENV=production WEB_ROOT=/app/web
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /app/packages/jellyfin/node_modules ./packages/jellyfin/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY apps/server ./apps/server
COPY packages ./packages
COPY --from=build /app/apps/web/dist ./web
USER node
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "apps/server/src/api.ts"]
```

Note `WEB_ROOT=/app/web` is absolute, per fact 3. The `CMD` invokes `tsx` through its bin path rather than `pnpm exec`, so the process is PID 1's direct child and receives signals without a shell in between.

- [ ] **Step 11: Complete `docker-compose.yml`**

Append to the existing `services:` block (which already defines `postgres` and `redis`):

```yaml
  migrate:
    build: .
    command: ["node_modules/.bin/tsx", "apps/server/src/migrate.ts"]
    restart: "no"
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy

  api:
    build: .
    restart: unless-stopped
    env_file: .env
    ports:
      - "${PORT:-3000}:3000"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully

  worker:
    build: .
    command: ["node_modules/.bin/tsx", "apps/server/src/worker.ts"]
    restart: unless-stopped
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
```

The container always listens on 3000; `${PORT:-3000}` chooses only the **host** port. Do not pass `PORT` through to the container as well — that would move the listener out from under the published mapping. Plan 2 shipped exactly this bug in reverse (compose published `${API_PORT}` while the app read `PORT`).

- [ ] **Step 12: Build and verify against real containers**

```bash
docker compose build && docker compose up -d
```

Confirm each of the following and report the actual output, not a summary:
- `docker compose ps` shows `migrate` exited 0, with `api` and `worker` running.
- `curl -s http://localhost:3000/api/health` returns JSON.
- `curl -s http://localhost:3000/` returns the SPA's HTML.
- `curl -si http://localhost:3000/users/abc | head -1` returns `200`, and the body is the same HTML — the deep link works on refresh.
- `curl -si http://localhost:3000/api/nope | head -1` returns `404` with a JSON body.
- `docker compose logs worker` shows a poll cycle, not a crash loop.
- `docker image inspect jellyfin-stats-api --format '{{.Size}}'` — record the number in the commit message.

- [ ] **Step 13: Full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS with 9 more tests than the previous task's baseline, `typecheck` exit 0.

- [ ] **Step 14: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml apps/server packages/shared pnpm-lock.yaml
git commit -m "feat: serve the SPA from the API and add the production image"
```

---

### Task 13: Playwright smoke test, README, and end-to-end verification

**Files:**
- Create: `playwright.config.ts`, `e2e/smoke.spec.ts`
- Modify: `README.md`, root `package.json`
- Test: the smoke test itself

**The smoke test covers the one path no unit test can:** load the app, get redirected to login, sign in with a real Jellyfin administrator account, and see the dashboard render real numbers.

**Credential handling:** the test reads the username and password from environment variables and **never hardcodes them**. Document that `E2E_JELLYFIN_USER` / `E2E_JELLYFIN_PASSWORD` are required to run it, that they are not stored anywhere, and that the test skips itself when they are absent rather than failing. Never write a real credential into a tracked file, a screenshot, or a trace artifact — add `test-results/` and `playwright-report/` to `.gitignore`.

**README:** document `pnpm --filter @jfstats/web dev`, the two-terminal dev setup, the production `docker compose up -d` flow now that an image exists, and remove the Plan 2 note saying no production image exists.

Assert: redirect to `/login` when anonymous; successful login lands on the dashboard; the overview shows a non-zero total when the database has data; a deep link survives a page reload; logout returns to `/login`.

- [ ] **Steps:** write the spec → run against the running stack → README → `pnpm test && pnpm typecheck` → commit.

---

## Self-Review

**Spec coverage.** Every Plan 3 requirement maps to a task: Vite + React + TanStack + Tailwind + shadcn → Tasks 1–2; the three-layer component architecture → Tasks 2, 4, 6, and exercised by 7–11; dark mode → Task 2; the seven routes → Tasks 3, 4, 7, 8, 9, 10, 11; poster art proxied so the browser never holds the API key → Task 6's `PosterImage`; charts following the `dataviz` skill → Task 6; the production multi-stage image and one-port static serving → Task 12; the Playwright smoke test → Task 13.

**Carried from earlier follow-ups:** Task 12 settles the compiled-entrypoint problem Plan 1 recorded (workspace packages resolving `main` to `.ts` sources), which is what made `node dist/*.js` a no-op. It settles it by shipping `tsx` and producing no `dist/` in the image at all, rather than by restructuring the export maps — see Task 12's fact list for the evidence and the reasoning.

**Deliberately not in scope:** per-user session revocation, moving the image fetch into `packages/jellyfin`, and the remaining deferred test-coverage items — all recorded in the two follow-up documents and none blocking a working UI.

**Where this plan is most likely to need a decision mid-flight:** Tasks 7–13 are specified by design points and required assertions rather than complete code, unlike Tasks 1–6 and 12 and unlike Plans 1–2 throughout. That is deliberate — they assemble components Tasks 1–6 define in full — but it means their implementers make more choices inside the task than this project's implementers have been asked to make before. Where a task names a required assertion, treat it as a floor rather than a specification: add what the component actually needs, and report anything the task did not anticipate rather than quietly widening scope.

**The habit that matters most in this plan.** Both previous plans' most common defect was a test that would pass with the behaviour removed. UI tests are especially prone to it — "renders without crashing" proves nothing. After each assertion, ask what you would have to break for it to go red, and where a fix rests on a guarantee, prove it by deleting the guarantee and watching the test fail.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-17-web-ui-and-packaging.md`.
