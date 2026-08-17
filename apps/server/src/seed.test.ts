import { describe, expect, it } from "vitest";
import { generateSeedData } from "./seed.js";

describe("generateSeedData", () => {
  it("is deterministic for a given seed", () => {
    // A fixed injected clock makes this deterministic by construction, not by luck:
    // the two calls below would agree even if they were made seconds (or days)
    // apart in real wall-clock time, because neither one ever reads Date.now().
    const now = () => 1_777_000_000_000;
    const a = generateSeedData({ days: 30, users: 4, items: 50, seed: 42, now });
    const b = generateSeedData({ days: 30, users: 4, items: 50, seed: 42, now });

    expect(a).toEqual(b);
  });

  it("produces the requested number of users and items", () => {
    const data = generateSeedData({ days: 10, users: 4, items: 25, seed: 1 });

    expect(data.users).toHaveLength(4);
    expect(data.items).toHaveLength(25);
  });

  it("generates sessions only within the requested window", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const now = 1_777_000_000_000;
    const data = generateSeedData({ days: 7, users: 2, items: 10, seed: 1, now: () => now });

    // With the clock fixed, the window is exact: every session must start on or
    // after the start of the oldest requested day, and strictly before `now`.
    for (const session of data.sessions) {
      expect(session.startedAt.getTime()).toBeGreaterThanOrEqual(now - 7 * dayMs);
      expect(session.startedAt.getTime()).toBeLessThan(now);
    }
  });

  it("gives every session a unique play session and item pair", () => {
    const data = generateSeedData({ days: 30, users: 4, items: 50, seed: 7 });
    const keys = data.sessions.map((s) => `${s.sessionId}:${s.itemId}`);

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
