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
