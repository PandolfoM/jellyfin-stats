import type { LiveSession } from "@jfstats/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, createImageFetcher, createLiveSubscriber } from "./app.js";
import type { AppContext } from "../context.js";
import { createSnapshotStore, type SnapshotStore } from "../sync/snapshot-store.js";

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
    // Never opened: an unauthenticated request is rejected by requireAdmin
    // before any handler touches context.db or context.snapshots.
    db: {},
    snapshots: {},
    logger: { error: vi.fn(), info: vi.fn() },
  } as unknown as AppContext;
}

function testSession(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    sessionId: "s-1",
    userId: "u-1",
    userName: "alpha",
    itemId: "i-1",
    itemName: "A Movie",
    deviceId: "d-1",
    deviceName: "Living Room",
    client: "Jellyfin Web",
    playMethod: "DirectPlay",
    positionTicks: 10,
    runtimeTicks: 100,
    isPaused: false,
    remoteEndpoint: "192.0.2.10",
    ...overrides,
  };
}

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

  it("rejects an unauthenticated request to the item detail API", async () => {
    // Same reasoning as the image proxy: an open detail endpoint would let
    // anyone who can reach the port read a private library by walking ids.
    const { app } = createApp(testContext());

    const response = await app.request("/api/items/a1b2c3d4e5f67890a1b2c3d4e5f67890");

    expect(response.status).toBe(401);
  });

  it("rejects an unauthenticated write to the custom CSS endpoint", async () => {
    // Regression test for a real hole: `app.use("/api/settings", ...)` matches
    // that exact path and nothing beneath it, so this sub-path was initially
    // ungated and an anonymous PUT persisted a stylesheet that every signed-in
    // operator would then load. A gate on the sibling GET says nothing about
    // this route, which is why it needs its own test.
    const { app } = createApp(testContext());

    const response = await app.request("/api/settings/custom-css", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ css: "body { display: none; }" }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects an unauthenticated sync trigger", async () => {
    // A POST beneath /api/settings — covered by the wildcard gate, and pinned
    // here so removing that line cannot silently expose a Jellyfin-hitting job
    // to anyone who can reach the port.
    const { app } = createApp(testContext());

    const response = await app.request("/api/settings/sync-now", { method: "POST" });

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
  it("relays a publish to onMessage as a JSON-stringified session list", async () => {
    // Composed against the real snapshot store rather than a hand-written
    // stub: this is what proves the JSON.stringify wrapping actually happens
    // in the adapter, not just in some test double standing in for it.
    const store = createSnapshotStore();
    const onMessage = vi.fn();

    await createLiveSubscriber(store)(onMessage);
    await store.publish([testSession()]);

    expect(onMessage).toHaveBeenCalledWith(JSON.stringify([testSession()]));
  });

  it("stops relaying once the returned unsubscribe has run", async () => {
    const store = createSnapshotStore();
    const onMessage = vi.fn();

    const unsubscribe = await createLiveSubscriber(store)(onMessage);
    await unsubscribe();
    await store.publish([testSession()]);

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("resolves rather than rejecting when unsubscribed", async () => {
    // registerLiveRoute invokes this from the stream's abort path, where Hono
    // runs subscribers through forEach with no error handling — an unobserved
    // rejection there would kill the process under Node's default
    // --unhandled-rejections=throw. Against the real createSnapshotStore(),
    // EventEmitter#off is synchronous and cannot throw, so this direction
    // alone doesn't exercise the adapter's try/catch — see the next test for
    // that. This one just pins the resolved shape against the real store.
    const store = createSnapshotStore();

    const unsubscribe = await createLiveSubscriber(store)(() => {});

    await expect(unsubscribe()).resolves.toBeUndefined();
  });

  it("resolves rather than rejecting even when the store's unsubscribe throws", async () => {
    // createLiveSubscriber is parameterized by SnapshotStore, so this injects
    // the failure at the real boundary the adapter depends on, rather than
    // mocking EventEmitter internals (which would only prove the mock
    // behaves as programmed). A future SnapshotStore implementation, or a
    // future edit to this file, is not guaranteed to keep subscribe()'s
    // returned unsubscribe from ever throwing — this is what the adapter's
    // try/catch exists for.
    const throwingStore: SnapshotStore = {
      load: async () => ({}),
      save: async () => {},
      publish: async () => {},
      loadLive: async () => [],
      subscribe: () => () => {
        throw new Error("boom");
      },
    };

    const unsubscribe = await createLiveSubscriber(throwingStore)(() => {});

    await expect(unsubscribe()).resolves.toBeUndefined();
  });

  it("leaves other subscribers on the same store unaffected by one unsubscribe", async () => {
    const store = createSnapshotStore();
    const onA = vi.fn();
    const onB = vi.fn();

    const unsubscribeA = await createLiveSubscriber(store)(onA);
    await createLiveSubscriber(store)(onB);
    await unsubscribeA();
    await store.publish([testSession()]);

    expect(onA).not.toHaveBeenCalled();
    expect(onB).toHaveBeenCalledTimes(1);
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
