import { afterEach, describe, expect, it, vi } from "vitest";
import type { api } from "./client";
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

/**
 * Type-only guard, one per route group threaded through `createApp`
 * (apps/server/src/api/app.ts). This block runs no code — `vitest run` never
 * evaluates it, and it produces no test-report entries — it exists purely to
 * be checked by `tsc --build` (`pnpm typecheck`), which does cover this file:
 * apps/web/tsconfig.json's `include: ["src/**\/*"]` reaches every .ts file
 * under src, this test file included.
 *
 * Why this needs to be permanent rather than a throwaway probe: the only real
 * caller of the typed client, apps/web/src/auth/session.tsx, touches
 * `api.api.auth.*` exclusively — auth was already working before task-3b
 * fixed the other four route groups. So reverting task-3b's server-side
 * changes entirely leaves `pnpm test && pnpm typecheck` green with zero
 * signal; nothing else in the repo exercises `api.api.stats`/`history`/
 * `images`/`live`. Each line below fails to typecheck if its group's
 * registrar (apps/server/src/api/routes/{stats,history,images,live}.ts) ever
 * goes back to returning `void`, or otherwise drops out of the chain
 * threaded through createApp — `api.api.<group>` would no longer have the
 * property being accessed. That is exactly the class of defect ("the type
 * link exists but nothing flows through it") that let the original bug pass
 * an earlier review.
 */
type AssertCallable<T extends (...args: never[]) => unknown> = T;
type _StatsOverviewIsCallable = AssertCallable<typeof api.api.stats.overview.$get>;
type _HistoryIsCallable = AssertCallable<typeof api.api.history.$get>;
// `typeof`'s type-query syntax only accepts a dotted identifier chain, not an
// indexed access — `:itemId` isn't a valid identifier, so the path has to be
// split: `typeof ...items` first, then `[":itemId"]["$get"]` as indexed
// access types applied to that.
type _ImagesItemIsCallable = AssertCallable<(typeof api.api.images.items)[":itemId"]["$get"]>;
type _LiveIsCallable = AssertCallable<typeof api.api.live.$get>;
