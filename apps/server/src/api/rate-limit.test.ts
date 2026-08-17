import type Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestRedis, stopTestRedis } from "../testing/redis-harness.js";
import { createRateLimiter } from "./rate-limit.js";

let redis: Redis;

beforeAll(async () => {
  redis = await startTestRedis();
});

afterAll(async () => {
  await stopTestRedis();
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
