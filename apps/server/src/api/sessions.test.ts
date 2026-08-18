import type Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestRedis, stopTestRedis } from "../testing/redis-harness.js";
import { createSessionStore } from "./sessions.js";

let redis: Redis;

beforeAll(async () => {
  redis = await startTestRedis();
});

afterAll(async () => {
  await stopTestRedis();
});

beforeEach(async () => {
  const keys = await redis.keys("jfstats:session:*");
  if (keys.length > 0) await redis.del(...keys);
});

const RECORD = { userId: "u-1", userName: "admin", isAdmin: true, createdAt: 1_777_000_000_000 };

describe("session store", () => {
  it("round-trips a session by its id", async () => {
    const store = createSessionStore(redis);

    const id = await store.create(RECORD);

    expect(await store.get(id)).toEqual(RECORD);
  });

  it("issues unguessable ids", async () => {
    const store = createSessionStore(redis);

    const a = await store.create(RECORD);
    const b = await store.create(RECORD);

    expect(a).not.toBe(b);
    // 32 random bytes, base64url encoded.
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).not.toContain(RECORD.userId);
  });

  it("returns null for an unknown id", async () => {
    const store = createSessionStore(redis);

    expect(await store.get("not-a-real-session-id")).toBeNull();
  });

  it("returns null after destroy, so logout actually revokes", async () => {
    const store = createSessionStore(redis);
    const id = await store.create(RECORD);

    await store.destroy(id);

    expect(await store.get(id)).toBeNull();
  });

  it("slides the expiry on read so an active admin is not logged out", async () => {
    const store = createSessionStore(redis, 100);
    const id = await store.create(RECORD);
    await redis.expire(`jfstats:session:${id}`, 5);

    await store.get(id);

    expect(await redis.ttl(`jfstats:session:${id}`)).toBeGreaterThan(50);
  });

  it("returns null rather than throwing when the stored value is corrupt", async () => {
    const store = createSessionStore(redis);
    await redis.set("jfstats:session:corrupt", "{not json");

    expect(await store.get("corrupt")).toBeNull();
  });
});
