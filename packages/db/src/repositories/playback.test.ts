import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { playbackRollupDaily, playbackSessions } from "../schema.js";
import { stopTestDatabase, withTestDatabase } from "../testing/harness.js";
import {
  applyRollupDelta,
  closeSession,
  findStaleOpenSessions,
  openSession,
  recomputeRollupRange,
  touchSession,
} from "./playback.js";

afterAll(stopTestDatabase);

const START = new Date("2026-08-16T20:00:00Z");

const OPEN = {
  playSessionId: "ps-1",
  itemId: "item-1",
  userId: "user-1",
  deviceId: "device-1",
  client: "Jellyfin Web",
  playMethod: "DirectPlay" as const,
  positionTicks: 0,
  remoteEndpoint: "10.0.0.5",
  at: START,
};

describe("playback repositories", () => {
  it("opens a session as not yet ended", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);

      const rows = await db.select().from(playbackSessions);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ playSessionId: "ps-1", endedAt: null, watchMs: 0 });
    });
  });

  it("is idempotent when the same session is opened twice", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      await openSession(db, OPEN);

      const rows = await db.select().from(playbackSessions);
      expect(rows).toHaveLength(1);
    });
  });

  it("accumulates watch time across successive touches", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      await touchSession(db, {
        playSessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 50_000_000,
        watchedMs: 5_000,
        isPaused: false,
        at: new Date(START.getTime() + 5_000),
      });
      await touchSession(db, {
        playSessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 100_000_000,
        watchedMs: 5_000,
        isPaused: false,
        at: new Date(START.getTime() + 10_000),
      });

      const rows = await db.select().from(playbackSessions);
      expect(rows[0]?.watchMs).toBe(10_000);
    });
  });

  it("marks a session completed when position passes the threshold", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      await closeSession(db, {
        playSessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 95,
        runtimeTicks: 100,
        watchedMs: 1_000,
        completionThreshold: 0.9,
        at: new Date(START.getTime() + 60_000),
      });

      const rows = await db.select().from(playbackSessions);
      expect(rows[0]).toMatchObject({ completed: true });
      expect(rows[0]?.endedAt).not.toBeNull();
    });
  });

  it("leaves a session incomplete below the threshold", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      await closeSession(db, {
        playSessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 10,
        runtimeTicks: 100,
        watchedMs: 1_000,
        completionThreshold: 0.9,
        at: new Date(START.getTime() + 60_000),
      });

      const rows = await db.select().from(playbackSessions);
      expect(rows[0]?.completed).toBe(false);
    });
  });

  it("treats an unknown runtime as incomplete rather than dividing by zero", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      await closeSession(db, {
        playSessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 500,
        runtimeTicks: null,
        watchedMs: 1_000,
        completionThreshold: 0.9,
        at: new Date(START.getTime() + 60_000),
      });

      const rows = await db.select().from(playbackSessions);
      expect(rows[0]?.completed).toBe(false);
    });
  });

  it("returns the touched row's identity and start time", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);

      const ref = await touchSession(db, {
        playSessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 10,
        watchedMs: 1_000,
        isPaused: false,
        at: new Date(START.getTime() + 5_000),
      });

      // The applier keys rollups on the start day, which only the row knows.
      expect(ref).toEqual({ userId: "user-1", itemId: "item-1", startedAt: START });
    });
  });

  it("returns null when touching a session that does not exist", async () => {
    await withTestDatabase(async (db) => {
      const ref = await touchSession(db, {
        playSessionId: "missing",
        itemId: "item-1",
        positionTicks: 10,
        watchedMs: 1_000,
        isPaused: false,
        at: START,
      });

      expect(ref).toBeNull();
    });
  });

  it("returns the row when closing, so the play can be counted without the live payload", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);

      const ref = await closeSession(db, {
        playSessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 95,
        runtimeTicks: 100,
        watchedMs: 1_000,
        completionThreshold: 0.9,
        at: new Date(START.getTime() + 60_000),
      });

      expect(ref).toEqual({ userId: "user-1", itemId: "item-1", startedAt: START });
    });
  });

  it("returns null when closing an already-closed session", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      const close = {
        playSessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 95,
        runtimeTicks: 100,
        watchedMs: 1_000,
        completionThreshold: 0.9,
        at: new Date(START.getTime() + 60_000),
      };

      await closeSession(db, close);
      const second = await closeSession(db, close);

      // Null is what stops a replayed close from counting the play twice.
      expect(second).toBeNull();
    });
  });

  it("finds only open sessions older than the cutoff", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      await openSession(db, { ...OPEN, playSessionId: "ps-2", itemId: "item-2", at: new Date(START.getTime() + 60_000) });

      const stale = await findStaleOpenSessions(db, new Date(START.getTime() + 30_000));

      expect(stale).toHaveLength(1);
      expect(stale[0]).toMatchObject({ playSessionId: "ps-1", itemId: "item-1" });
    });
  });

  it("adds to an existing rollup row rather than replacing it", async () => {
    await withTestDatabase(async (db) => {
      const delta = { day: "2026-08-16", userId: "user-1", itemId: "item-1", libraryId: "lib-1", playCount: 1, watchMs: 5_000 };

      await applyRollupDelta(db, delta);
      await applyRollupDelta(db, delta);

      const rows = await db.select().from(playbackRollupDaily);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ playCount: 2, watchMs: 10_000 });
    });
  });

  it("recomputes a range to match what incremental writes produced", async () => {
    await withTestDatabase(async (db) => {
      // Two real sessions on the same day for the same user and item.
      await db.insert(playbackSessions).values([
        { playSessionId: "ps-1", itemId: "item-1", userId: "user-1", startedAt: START, lastSeenAt: START, endedAt: new Date(START.getTime() + 60_000), watchMs: 6_000 },
        { playSessionId: "ps-2", itemId: "item-1", userId: "user-1", startedAt: START, lastSeenAt: START, endedAt: new Date(START.getTime() + 120_000), watchMs: 4_000 },
      ]);
      // A drifted rollup row, as if an incremental write had been lost.
      await applyRollupDelta(db, { day: "2026-08-16", userId: "user-1", itemId: "item-1", libraryId: null, playCount: 1, watchMs: 999 });

      await recomputeRollupRange(db, new Date("2026-08-16T00:00:00Z"), new Date("2026-08-17T00:00:00Z"));

      const rows = await db
        .select()
        .from(playbackRollupDaily)
        .where(and(eq(playbackRollupDaily.userId, "user-1"), eq(playbackRollupDaily.itemId, "item-1")));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ playCount: 2, watchMs: 10_000 });
    });
  });

  it("removes rollup rows in range that no longer have sessions", async () => {
    await withTestDatabase(async (db) => {
      await applyRollupDelta(db, { day: "2026-08-16", userId: "ghost", itemId: "item-x", libraryId: null, playCount: 3, watchMs: 300 });

      await recomputeRollupRange(db, new Date("2026-08-16T00:00:00Z"), new Date("2026-08-17T00:00:00Z"));

      const rows = await db.select().from(playbackRollupDaily);
      expect(rows).toEqual([]);
    });
  });
});
