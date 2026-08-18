import type Redis from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, createImageFetcher, createLiveSubscriber } from "./app.js";
import type { AppContext } from "../context.js";

function testContext(): AppContext {
  return {
    env: {
      LOG_LEVEL: "error",
      COOKIE_SECURE: false,
      SESSION_TTL_HOURS: 168,
      TRUST_PROXY_HEADERS: false,
      fallbackAdminEnabled: false,
      // Synthetic, non-secret values for the /api/settings gate test below —
      // never exercised beyond construction, since an unauthenticated
      // request never reaches the handler that would read them.
      SESSION_POLL_INTERVAL_MS: 5_000,
      REFERENCE_SYNC_INTERVAL_MS: 900_000,
      COMPLETION_THRESHOLD: 0.9,
      JELLYFIN_URL: "http://jellyfin.example.invalid",
    },
    redis: {},
    // Never opened: an unauthenticated request is rejected by requireAdmin
    // before any handler touches context.db or context.snapshots.
    db: {},
    snapshots: {},
    logger: { error: vi.fn(), info: vi.fn() },
  } as unknown as AppContext;
}

const testLogger = (): { error: ReturnType<typeof vi.fn> } => ({ error: vi.fn() });

describe("createApp", () => {
  it("serves a health check without authentication", async () => {
    const { app } = createApp(testContext());

    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns JSON 404 for an unknown route rather than HTML", async () => {
    const { app } = createApp(testContext());

    const response = await app.request("/api/nope");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("reports an unhandled route error as JSON without leaking the message", async () => {
    const { app } = createApp(testContext());
    app.get("/api/boom", () => {
      throw new Error("internal detail that must not reach the client");
    });

    const response = await app.request("/api/boom");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });

  it("rejects an unauthenticated request to the stats API", async () => {
    // Proves requireAdmin is actually mounted on this route, not merely
    // written elsewhere: without this, every user's stats would be reachable
    // by anyone who can reach the port.
    const { app } = createApp(testContext());

    const response = await app.request("/api/stats/overview");

    expect(response.status).toBe(401);
  });

  it("rejects an unauthenticated request to the history API", async () => {
    const { app } = createApp(testContext());

    const response = await app.request("/api/history");

    expect(response.status).toBe(401);
  });

  it("rejects an unauthenticated request to the live feed", async () => {
    // The live feed shows who is watching what, in real time — the same
    // sensitivity as history, so it must be gated the same way.
    const { app } = createApp(testContext());

    const response = await app.request("/api/live");

    expect(response.status).toBe(401);
  });

  it("rejects an unauthenticated request to the image proxy", async () => {
    // Proves requireAdmin is actually mounted on this route, not merely
    // written elsewhere: an open image proxy would let anyone who can reach
    // the port enumerate a private media library by walking item ids.
    const { app } = createApp(testContext());

    const response = await app.request("/api/images/items/anything");

    expect(response.status).toBe(401);
  });

  it("rejects an unauthenticated request to /api/settings", async () => {
    // Proves requireAdmin is actually mounted ahead of this route, not just
    // written somewhere in the file — the effective sync intervals and
    // Jellyfin URL this route exposes are still configuration an anonymous
    // caller must not be able to read.
    const { app } = createApp(testContext());

    const response = await app.request("/api/settings");

    expect(response.status).toBe(401);
  });

  it("rejects an unauthenticated request to /api/auth/me", async () => {
    // /me used to read the session store itself, which slid the Redis TTL
    // without re-issuing the cookie and skipped the isAdmin re-check. It is
    // mounted behind the same middleware as everything else now; this proves
    // the middleware is actually mounted ahead of the route, which Hono only
    // honours when app.use() is registered first.
    const { app } = createApp(testContext());

    const response = await app.request("/api/auth/me");

    expect(response.status).toBe(401);
  });
});

describe("createLiveSubscriber", () => {
  it("quits the duplicated connection if SUBSCRIBE itself rejects, rather than leaking it", async () => {
    // context.redis.duplicate() opens the connection before SUBSCRIBE is ever
    // sent. If SUBSCRIBE then rejects (a Redis hiccup), nothing else in the
    // codebase ever gets a reference to that connection to close it — the
    // duplicated client must clean up after itself.
    const quit = vi.fn(async () => {});
    const fakeSubscriber = {
      subscribe: vi.fn(async () => {
        throw new Error("redis hiccup");
      }),
      quit,
      on: vi.fn(),
    };
    const redis = { duplicate: vi.fn(() => fakeSubscriber) } as unknown as Redis;

    const subscribe = createLiveSubscriber(redis, testLogger());

    await expect(subscribe(() => {})).rejects.toThrow("redis hiccup");
    expect(quit).toHaveBeenCalled();
  });

  it("registers an error listener on the duplicated connection before subscribing", async () => {
    // duplicate() does not carry listeners over from the shared client, and
    // there is one of these per attached dashboard tab. With no `error`
    // listener ioredis falls back to console.error, which bypasses LOG_LEVEL
    // and the redaction paths in logger.ts — and REDIS_URL can carry a
    // password. Registered before SUBSCRIBE so a failure during that round
    // trip is already covered.
    const events: string[] = [];
    const fakeSubscriber = {
      subscribe: vi.fn(async () => {
        events.push("subscribe");
      }),
      quit: vi.fn(async () => {}),
      on: vi.fn((event: string) => {
        events.push(`on:${event}`);
      }),
    };
    const redis = { duplicate: vi.fn(() => fakeSubscriber) } as unknown as Redis;

    await createLiveSubscriber(redis, testLogger())(() => {});

    expect(events.indexOf("on:error")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("on:error")).toBeLessThan(events.indexOf("subscribe"));
  });

  it("logs a connection error from the duplicated client through the app logger", async () => {
    let onError: ((error: Error) => void) | undefined;
    const fakeSubscriber = {
      subscribe: vi.fn(async () => {}),
      quit: vi.fn(async () => {}),
      on: vi.fn((event: string, listener: (error: Error) => void) => {
        if (event === "error") onError = listener;
      }),
    };
    const redis = { duplicate: vi.fn(() => fakeSubscriber) } as unknown as Redis;
    const logger = testLogger();

    await createLiveSubscriber(redis, logger)(() => {});
    const failure = new Error("ECONNRESET");
    onError?.(failure);

    expect(logger.error).toHaveBeenCalledWith({ err: failure }, "live subscriber connection error");
  });

  it("resolves rather than rejecting when quit fails, because nothing observes the abort path", async () => {
    // The unsubscribe closure is invoked from stream.onAbort, where Hono runs
    // subscribers through forEach with no error handling. ioredis rejects
    // pending commands with "Connection is closed.", so a rejection here
    // becomes an unhandled rejection and, under Node's default
    // --unhandled-rejections=throw, kills the API process.
    const fakeSubscriber = {
      subscribe: vi.fn(async () => {}),
      quit: vi.fn(async () => {
        throw new Error("Connection is closed.");
      }),
      on: vi.fn(),
    };
    const redis = { duplicate: vi.fn(() => fakeSubscriber) } as unknown as Redis;

    const unsubscribe = await createLiveSubscriber(redis, testLogger())(() => {});

    await expect(unsubscribe()).resolves.toBeUndefined();
    expect(fakeSubscriber.quit).toHaveBeenCalled();
  });

  it("does not quit the connection on a successful subscribe, and relays messages", async () => {
    const quit = vi.fn(async () => {});
    let deliver: ((channel: string, payload: string) => void) | undefined;
    const fakeSubscriber = {
      subscribe: vi.fn(async () => {}),
      quit,
      on: vi.fn((_event: string, listener: (channel: string, payload: string) => void) => {
        deliver = listener;
      }),
    };
    const redis = { duplicate: vi.fn(() => fakeSubscriber) } as unknown as Redis;

    const onMessage = vi.fn();
    const unsubscribe = await createLiveSubscriber(redis, testLogger())(onMessage);

    expect(quit).not.toHaveBeenCalled();

    deliver?.("jfstats:sessions:live", "[]");
    expect(onMessage).toHaveBeenCalledWith("[]");

    await unsubscribe();
    expect(quit).toHaveBeenCalled();
  });
});

describe("createImageFetcher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests exactly the intended path for a valid item id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const fetchImage = createImageFetcher({
      JELLYFIN_URL: "http://jellyfin.internal:8096",
      JELLYFIN_API_KEY: "secret-key",
    });

    await fetchImage("a1b2c3d4e5f67890a1b2c3d4e5f67890", { maxWidth: 400 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchSpy.mock.calls[0]?.[0]);
    // Pins the whole thing: if the id were interpolated unencoded and this
    // assertion only checked a substring or a prefix, a payload that
    // truncated everything after "/Items/<id>" (via an unescaped "#") could
    // still pass. Only an exact match proves nothing was dropped or reinterpreted.
    expect(requestedUrl).toBe(
      "http://jellyfin.internal:8096/Items/a1b2c3d4e5f67890a1b2c3d4e5f67890/Images/Primary?maxWidth=400",
    );
  });

  it("never puts the API key in the request URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const fetchImage = createImageFetcher({
      JELLYFIN_URL: "http://jellyfin.internal:8096",
      JELLYFIN_API_KEY: "super-secret-admin-key",
    });

    await fetchImage("a1b2c3d4e5f67890a1b2c3d4e5f67890", { maxWidth: 400 });

    const requestedUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(requestedUrl).not.toContain("super-secret-admin-key");
  });

  it("keeps a traversal/fragment payload contained within the item id path segment", async () => {
    // registerImageRoutes rejects this shape before it ever reaches
    // createImageFetcher (see images.ts), but this proves the encoding here
    // is real defense-in-depth, not just a comment: even if a future change
    // loosened or removed that validator, this payload could not escape the
    // /Items/<id>/Images/Primary path to hit a different Jellyfin endpoint,
    // because encodeURIComponent turns "/" and "#" into inert path characters.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const fetchImage = createImageFetcher({
      JELLYFIN_URL: "http://jellyfin.internal:8096",
      JELLYFIN_API_KEY: "secret-key",
    });

    await fetchImage("../../Users#", { maxWidth: 400 });

    const requestedUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(requestedUrl).toBe(
      "http://jellyfin.internal:8096/Items/..%2F..%2FUsers%23/Images/Primary?maxWidth=400",
    );
  });
});
