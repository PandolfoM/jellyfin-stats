import type { LiveSession } from "@jfstats/shared";
import type Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestRedis, stopTestRedis } from "../testing/redis-harness.js";
import { createSnapshotStore, LIVE_CHANNEL } from "./snapshot-store.js";

let redis: Redis;

beforeAll(async () => {
  redis = await startTestRedis();
});

afterAll(async () => {
  await stopTestRedis();
});

beforeEach(async () => {
  const keys = await redis.keys("jfstats:sessions:*");
  if (keys.length > 0) await redis.del(...keys);
});

const SESSION: LiveSession = {
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
};

describe("snapshot store loadLive", () => {
  it("returns an empty array before anything has been published", async () => {
    const store = createSnapshotStore(redis);

    expect(await store.loadLive()).toEqual([]);
  });

  it("returns the full LiveSession list from the most recent publish, not the minimal diff snapshot", async () => {
    const store = createSnapshotStore(redis);

    await store.publish([SESSION]);

    // If loadLive degraded to the reducer's minimal SessionSnapshotEntry shape,
    // userName/itemName/deviceName etc. would be missing here.
    expect(await store.loadLive()).toEqual([SESSION]);
  });

  it("reflects only the latest publish, not an accumulation of earlier ones", async () => {
    const store = createSnapshotStore(redis);
    const other: LiveSession = { ...SESSION, sessionId: "s-2", itemName: "Another Movie" };

    await store.publish([SESSION]);
    await store.publish([other]);

    expect(await store.loadLive()).toEqual([other]);
  });

  it("returns an empty array rather than throwing when the cache is corrupt", async () => {
    const store = createSnapshotStore(redis);
    await redis.set("jfstats:sessions:live:cache", "{not json");

    expect(await store.loadLive()).toEqual([]);
  });
});

describe("dedicated subscriber connection", () => {
  it("delivers published messages to a duplicated connection while the original connection keeps running ordinary commands", async () => {
    // This is the failure mode design point 1 exists for: an ioredis client that
    // has issued SUBSCRIBE cannot run ordinary commands afterward. If the live
    // route reused the app's shared connection instead of a duplicate, the first
    // browser to open the live view would break every other Redis-backed feature
    // (sessions, rate limiting) for the rest of the process's life.
    const store = createSnapshotStore(redis);
    const subscriber = redis.duplicate();
    await subscriber.subscribe(LIVE_CHANNEL);

    const received = new Promise<string>((resolve) => {
      subscriber.on("message", (_channel, payload) => resolve(payload));
    });

    await store.publish([SESSION]);

    expect(JSON.parse(await received)).toEqual([SESSION]);
    // The original connection must still answer ordinary commands.
    expect(await redis.ping()).toBe("PONG");

    await subscriber.quit();
  });
});
