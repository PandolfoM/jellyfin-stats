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

    // StatsDeps.getTopItems(range, options) takes two arguments, so the
    // options bag (with the clamped limit) is index 1, not 2.
    const call = (deps.getTopItems as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[1].limit).toBeLessThanOrEqual(100);
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
