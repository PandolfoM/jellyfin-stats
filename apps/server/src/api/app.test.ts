import type Redis from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { createApp, createLiveSubscriber } from "./app.js";
import type { AppContext } from "../context.js";

function testContext(): AppContext {
  return {
    env: {
      LOG_LEVEL: "error",
      COOKIE_SECURE: false,
      SESSION_TTL_HOURS: 168,
      TRUST_PROXY_HEADERS: false,
      fallbackAdminEnabled: false,
    },
    redis: {},
    // Never opened: an unauthenticated request is rejected by requireAdmin
    // before any handler touches context.db or context.snapshots.
    db: {},
    snapshots: {},
  } as unknown as AppContext;
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

  it("rejects an unauthenticated request to the stats API", async () => {
    // Proves requireAdmin is actually mounted on this route, not merely
    // written elsewhere: without this, every user's stats would be reachable
    // by anyone who can reach the port.
    const app = createApp(testContext());

    const response = await app.request("/api/stats/overview");

    expect(response.status).toBe(401);
  });

  it("rejects an unauthenticated request to the history API", async () => {
    const app = createApp(testContext());

    const response = await app.request("/api/history");

    expect(response.status).toBe(401);
  });

  it("rejects an unauthenticated request to the live feed", async () => {
    // The live feed shows who is watching what, in real time — the same
    // sensitivity as history, so it must be gated the same way.
    const app = createApp(testContext());

    const response = await app.request("/api/live");

    expect(response.status).toBe(401);
  });

  it("rejects an unauthenticated request to the image proxy", async () => {
    // Proves requireAdmin is actually mounted on this route, not merely
    // written elsewhere: an open image proxy would let anyone who can reach
    // the port enumerate a private media library by walking item ids.
    const app = createApp(testContext());

    const response = await app.request("/api/images/items/anything");

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

    const subscribe = createLiveSubscriber(redis);

    await expect(subscribe(() => {})).rejects.toThrow("redis hiccup");
    expect(quit).toHaveBeenCalled();
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
    const unsubscribe = await createLiveSubscriber(redis)(onMessage);

    expect(quit).not.toHaveBeenCalled();

    deliver?.("jfstats:sessions:live", "[]");
    expect(onMessage).toHaveBeenCalledWith("[]");

    await unsubscribe();
    expect(quit).toHaveBeenCalled();
  });
});
