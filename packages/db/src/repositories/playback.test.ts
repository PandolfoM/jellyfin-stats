import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { items, playbackRollupDaily, playbackSessions } from "../schema.js";
import { stopTestDatabase, withTestDatabase } from "../testing/harness.js";
import {
  applyRollupDelta,
  closeSession,
  deleteSeededRollupRows,
  deleteSeededSessions,
  findStaleOpenSessions,
  openSession,
  recomputeRollupRange,
  touchSession,
} from "./playback.js";

afterAll(stopTestDatabase);

const START = new Date("2026-08-16T20:00:00Z");

const OPEN = {
  sessionId: "ps-1",
  itemId: "item-1",
  userId: "user-1",
  deviceId: "device-1",
  client: "Jellyfin Web",
  playMethod: "DirectPlay" as const,
  positionTicks: 0,
  isPaused: false,
  remoteEndpoint: "10.0.0.5",
  at: START,
};

describe("playback repositories", () => {
  it("opens a session as not yet ended", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);

      const rows = await db.select().from(playbackSessions);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ sessionId: "ps-1", endedAt: null, watchMs: 0 });
    });
  });

  it("opens a session already paused as is_paused: true", async () => {
    // A session first observed already paused (worker restart, or the user pauses
    // within the first poll interval) must not read is_paused: false until the next
    // poll's progressed/paused event corrects it — openSession is the only place that
    // knows the true initial state.
    await withTestDatabase(async (db) => {
      await openSession(db, { ...OPEN, isPaused: true });

      const rows = await db.select().from(playbackSessions);
      expect(rows[0]).toMatchObject({ isPaused: true });
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
        sessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 50_000_000,
        watchedMs: 5_000,
        isPaused: false,
        at: new Date(START.getTime() + 5_000),
      });
      await touchSession(db, {
        sessionId: "ps-1",
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
        sessionId: "ps-1",
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
        sessionId: "ps-1",
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
        sessionId: "ps-1",
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
        sessionId: "ps-1",
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
        sessionId: "missing",
        itemId: "item-1",
        positionTicks: 10,
        watchedMs: 1_000,
        isPaused: false,
        at: START,
      });

      expect(ref).toBeNull();
    });
  });

  it("returns null and changes nothing when the only matching row is already closed", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      await closeSession(db, {
        sessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 95,
        runtimeTicks: 100,
        watchedMs: 1_000,
        completionThreshold: 0.9,
        at: new Date(START.getTime() + 60_000),
      });

      // Only a closed row exists for this identity. Before the fix, touchSession
      // filtered on identity alone and would have matched — and mutated — it.
      const touched = await touchSession(db, {
        sessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 999,
        watchedMs: 5_000,
        isPaused: true,
        at: new Date(START.getTime() + 120_000),
      });

      expect(touched).toBeNull();

      const rows = await db.select().from(playbackSessions);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ watchMs: 1_000, positionTicks: 95, isPaused: false });
    });
  });

  it("opens a second row for a re-watch of the same session and item after the first closed", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);
      await closeSession(db, {
        sessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 95,
        runtimeTicks: 100,
        watchedMs: 1_000,
        completionThreshold: 0.9,
        at: new Date(START.getTime() + 60_000),
      });

      // Jellyfin reuses the client's session id across items, so re-watching the same
      // item later in the same browser session produces the identical (sessionId,
      // itemId) pair that was just closed. Before the fix, the plain unique index made
      // this collide with the completed row and openSession silently no-opped.
      const rewatchAt = new Date(START.getTime() + 120_000);
      await openSession(db, { ...OPEN, at: rewatchAt });

      const rows = await db
        .select()
        .from(playbackSessions)
        .orderBy(playbackSessions.startedAt);

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ watchMs: 1_000, positionTicks: 95 });
      expect(rows[0]?.endedAt).not.toBeNull();
      expect(rows[1]).toMatchObject({ startedAt: rewatchAt, watchMs: 0 });
      expect(rows[1]?.endedAt).toBeNull();

      const touched = await touchSession(db, {
        sessionId: "ps-1",
        itemId: "item-1",
        positionTicks: 10,
        watchedMs: 2_000,
        isPaused: false,
        at: new Date(rewatchAt.getTime() + 5_000),
      });

      expect(touched).toEqual({ userId: "user-1", itemId: "item-1", startedAt: rewatchAt });

      const afterTouch = await db
        .select()
        .from(playbackSessions)
        .orderBy(playbackSessions.startedAt);

      // The watch time landed on the new open row, and the closed row from the first
      // viewing was left exactly as it was.
      expect(afterTouch[0]?.watchMs).toBe(1_000);
      expect(afterTouch[1]?.watchMs).toBe(2_000);
    });
  });

  it("returns the row when closing, so the play can be counted without the live payload", async () => {
    await withTestDatabase(async (db) => {
      await openSession(db, OPEN);

      const ref = await closeSession(db, {
        sessionId: "ps-1",
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
        sessionId: "ps-1",
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
      await openSession(db, { ...OPEN, sessionId: "ps-2", itemId: "item-2", at: new Date(START.getTime() + 60_000) });

      const stale = await findStaleOpenSessions(db, new Date(START.getTime() + 30_000));

      expect(stale).toHaveLength(1);
      expect(stale[0]).toMatchObject({ sessionId: "ps-1", itemId: "item-1" });
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
        { sessionId: "ps-1", itemId: "item-1", userId: "user-1", startedAt: START, lastSeenAt: START, endedAt: new Date(START.getTime() + 60_000), watchMs: 6_000 },
        { sessionId: "ps-2", itemId: "item-1", userId: "user-1", startedAt: START, lastSeenAt: START, endedAt: new Date(START.getTime() + 120_000), watchMs: 4_000 },
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

  it("recomputes non-midnight-aligned bounds without dropping or duplicating a day", async () => {
    await withTestDatabase(async (db) => {
      const day1Start = new Date("2026-08-16T10:00:00Z");
      const day1Second = new Date("2026-08-16T11:00:00Z");
      const day2Start = new Date("2026-08-17T10:00:00Z");

      await db.insert(playbackSessions).values([
        {
          sessionId: "d1-1",
          itemId: "item-1",
          userId: "user-1",
          startedAt: day1Start,
          lastSeenAt: day1Start,
          endedAt: new Date(day1Start.getTime() + 60_000),
          watchMs: 1_000,
        },
        {
          sessionId: "d1-2",
          itemId: "item-1",
          userId: "user-1",
          startedAt: day1Second,
          lastSeenAt: day1Second,
          endedAt: new Date(day1Second.getTime() + 60_000),
          watchMs: 2_000,
        },
        {
          sessionId: "d2-1",
          itemId: "item-1",
          userId: "user-1",
          startedAt: day2Start,
          lastSeenAt: day2Start,
          endedAt: new Date(day2Start.getTime() + 60_000),
          watchMs: 3_000,
        },
      ]);

      // Neither bound sits on a UTC day boundary — this is the shape every real caller
      // uses (a 7-day lookback from "now", a seed script's relative dates, tests that
      // straddle midnight).
      const from = new Date("2026-08-16T05:00:00Z");
      const to = new Date("2026-08-17T05:00:00Z");

      await recomputeRollupRange(db, from, to);

      const firstPass = await db.select().from(playbackRollupDaily).orderBy(playbackRollupDaily.day);
      expect(firstPass).toHaveLength(2);
      expect(firstPass[0]).toMatchObject({ day: "2026-08-16", playCount: 2, watchMs: 3_000 });
      expect(firstPass[1]).toMatchObject({ day: "2026-08-17", playCount: 1, watchMs: 3_000 });

      // A second recompute over the identical non-aligned bounds must not collide with
      // the rows the first pass just wrote. Before the fix, the DELETE and INSERT
      // disagreed on which days were "in range", so this call threw a primary-key
      // violation instead of cleanly replacing the rows.
      await recomputeRollupRange(db, from, to);

      const secondPass = await db.select().from(playbackRollupDaily).orderBy(playbackRollupDaily.day);
      expect(secondPass).toHaveLength(2);
      expect(secondPass[0]).toMatchObject({ day: "2026-08-16", playCount: 2, watchMs: 3_000 });
      expect(secondPass[1]).toMatchObject({ day: "2026-08-17", playCount: 1, watchMs: 3_000 });
    });
  });

  it("removes an orphaned rollup row on the boundary day even when bounds aren't midnight-aligned", async () => {
    await withTestDatabase(async (db) => {
      // Seeded on the day that only the *ceiled* upper bound reaches — a day with no
      // sessions at all, so recompute must still delete it.
      await applyRollupDelta(db, {
        day: "2026-08-17",
        userId: "ghost",
        itemId: "item-x",
        libraryId: null,
        playCount: 5,
        watchMs: 500,
      });

      await recomputeRollupRange(db, new Date("2026-08-16T05:00:00Z"), new Date("2026-08-17T05:00:00Z"));

      const rows = await db.select().from(playbackRollupDaily);
      expect(rows).toEqual([]);
    });
  });

  it("resolves library_id from the items table when the caller doesn't supply one", async () => {
    await withTestDatabase(async (db) => {
      await db.insert(items).values({ id: "item-1", libraryId: "lib-1", type: "Movie", name: "The Movie" });

      // No libraryId passed at all — this is how the applier calls it. Before the fix,
      // the applier had no way to know the item's library and always passed null,
      // leaving playback_rollup_daily.library_id NULL until the nightly recompute ran.
      await applyRollupDelta(db, {
        day: "2026-08-16",
        userId: "user-1",
        itemId: "item-1",
        playCount: 1,
        watchMs: 5_000,
      });

      const rows = await db.select().from(playbackRollupDaily);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ libraryId: "lib-1" });
    });
  });

  it("keeps a known libraryId when a later delta for the same key doesn't know it", async () => {
    await withTestDatabase(async (db) => {
      await applyRollupDelta(db, {
        day: "2026-08-16",
        userId: "user-1",
        itemId: "item-1",
        libraryId: "lib-1",
        playCount: 1,
        watchMs: 1_000,
      });
      await applyRollupDelta(db, {
        day: "2026-08-16",
        userId: "user-1",
        itemId: "item-1",
        libraryId: null,
        playCount: 1,
        watchMs: 1_000,
      });

      const rows = await db.select().from(playbackRollupDaily);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ libraryId: "lib-1", playCount: 2, watchMs: 2_000 });
    });
  });

  it("deleteSeededSessions removes only seed-prefixed sessions, leaving real ones untouched", async () => {
    await withTestDatabase(async (db) => {
      // A realistic Jellyfin session id: 32-character hex, as real Jellyfin issues.
      const realSessionId = "a656b907eb3a73532e40e44b968d0225";

      await openSession(db, { ...OPEN, sessionId: realSessionId });
      await openSession(db, { ...OPEN, sessionId: "seed-ps-1", itemId: "item-2" });

      const removed = await deleteSeededSessions(db);

      expect(removed).toBe(1);

      const rows = await db.select().from(playbackSessions);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ sessionId: realSessionId });
    });
  });

  it("deleteSeededRollupRows removes only seed-user-prefixed rows, leaving real ones untouched", async () => {
    await withTestDatabase(async (db) => {
      // A realistic Jellyfin user id: 32-character hex, as real Jellyfin issues.
      const realUserId = "3fa07a1cf2b74b6a9c2f6c9c6e9c7a3d";

      await applyRollupDelta(db, {
        day: "2026-08-16",
        userId: realUserId,
        itemId: "item-1",
        libraryId: null,
        playCount: 1,
        watchMs: 1_000,
      });
      await applyRollupDelta(db, {
        day: "2026-08-16",
        userId: "seed-user-0",
        itemId: "seed-item-1",
        libraryId: null,
        playCount: 1,
        watchMs: 2_000,
      });

      const removed = await deleteSeededRollupRows(db);

      expect(removed).toBe(1);

      const rows = await db.select().from(playbackRollupDaily);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: realUserId });
    });
  });
});
