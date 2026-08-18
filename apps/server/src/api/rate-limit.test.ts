import type { Db } from "@jfstats/db";
import { stopTestDatabase, withTestDatabase } from "@jfstats/db/testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "./rate-limit.js";

afterAll(stopTestDatabase);
afterEach(() => {
  vi.useRealTimers();
});

describe("rate limiter", () => {
  it("allows requests below the limit and counts down", async () => {
    await withTestDatabase(async (db) => {
      const limiter = createRateLimiter(db, { limit: 3, windowSeconds: 60 });

      expect(await limiter.check("198.51.100.7")).toEqual({ allowed: true, remaining: 2 });
      expect(await limiter.check("198.51.100.7")).toEqual({ allowed: true, remaining: 1 });
      expect(await limiter.check("198.51.100.7")).toEqual({ allowed: true, remaining: 0 });
    });
  });

  it("blocks once the limit is exceeded", async () => {
    await withTestDatabase(async (db) => {
      const limiter = createRateLimiter(db, { limit: 2, windowSeconds: 60 });
      await limiter.check("198.51.100.8");
      await limiter.check("198.51.100.8");

      expect(await limiter.check("198.51.100.8")).toMatchObject({ allowed: false });
    });
  });

  it("tracks each key independently, so one attacker cannot lock everyone out", async () => {
    await withTestDatabase(async (db) => {
      const limiter = createRateLimiter(db, { limit: 1, windowSeconds: 60 });
      await limiter.check("198.51.100.9");

      expect(await limiter.check("198.51.100.10")).toMatchObject({ allowed: true });
    });
  });

  // Replaces the old Redis test that inspected the key's TTL to prove an expiry
  // was set. Postgres has no TTL — the equivalent, observable behavior is that
  // once windowSeconds elapses the count actually resets, i.e. the window rolls.
  // Fakes only Date (not timers), so the real Postgres I/O underneath still runs
  // on real timers.
  it("rolls the window once it elapses, so the limit resets", async () => {
    await withTestDatabase(async (db) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));

      const limiter = createRateLimiter(db, { limit: 2, windowSeconds: 42 });
      await limiter.check("198.51.100.11");
      await limiter.check("198.51.100.11");
      expect(await limiter.check("198.51.100.11")).toMatchObject({ allowed: false });

      vi.setSystemTime(new Date("2026-08-18T12:00:00Z").getTime() + 43_000);

      expect(await limiter.check("198.51.100.11")).toEqual({ allowed: true, remaining: 1 });
    });
  });
});

/**
 * A real Postgres container cannot be made to fail a specific query on demand,
 * so this drives the failure the same way the Db type is actually used: a Db
 * whose write rejects, as directed by the task brief.
 */
function brokenDb(): Db {
  return {
    insert: () => {
      throw new Error("connection terminated unexpectedly");
    },
  } as unknown as Db;
}

describe("rate limiter under a datastore fault", () => {
  it("fails closed when the datastore errors", async () => {
    // Reading a failed count as "0 attempts so far" would have ALLOWED the
    // request, silently switching login throttling off exactly when an
    // attacker would most want it off.
    const limiter = createRateLimiter(brokenDb(), { limit: 10, windowSeconds: 900 });

    expect(await limiter.check("ip-x")).toEqual({ allowed: false, remaining: 0 });
  });
});
