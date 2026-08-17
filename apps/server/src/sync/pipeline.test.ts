import {
  applyRollupDelta,
  closeSession,
  openSession,
  playbackRollupDaily,
  playbackSessions,
  recomputeRollupRange,
  touchSession,
  upsertDevice,
  upsertItems,
} from "@jfstats/db";
import { stopTestDatabase, withTestDatabase } from "@jfstats/db/testing";
import type { LiveSession, SessionSnapshot } from "@jfstats/shared";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { generateSeedData } from "../seed.js";
import { runSessionPoll } from "./applier.js";
import type { SnapshotStore } from "./snapshot-store.js";

afterAll(stopTestDatabase);

const START = new Date("2026-08-16T20:00:00Z").getTime();

function memorySnapshotStore(): SnapshotStore {
  let snapshot: SessionSnapshot = {};
  let live: LiveSession[] = [];
  return {
    load: async () => snapshot,
    save: async (next) => void (snapshot = next),
    publish: async (sessions) => void (live = sessions),
    loadLive: async () => live,
  };
}

function liveSession(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    sessionId: "ps-1",
    userId: "user-1",
    userName: "alice",
    itemId: "item-1",
    itemName: "Demo Movie",
    deviceId: "device-1",
    deviceName: "Living Room TV",
    client: "Jellyfin Web",
    playMethod: "DirectPlay",
    positionTicks: 0,
    runtimeTicks: 60_000 * 10_000,
    isPaused: false,
    remoteEndpoint: "192.0.2.10",
    ...overrides,
  };
}

describe("sync pipeline", () => {
  it("records a full stream and agrees with the nightly recompute", async () => {
    await withTestDatabase(async (db) => {
      await upsertItems(db, [
        { id: "item-1", type: "Movie", name: "Demo Movie", libraryId: "lib-1", runtimeTicks: 60_000 * 10_000 },
      ]);

      const snapshots = memorySnapshotStore();
      let clock = START;

      const deps = {
        db,
        jellyfin: { getSessions: async () => current } as never,
        snapshots,
        completionThreshold: 0.9,
        maxWatchDeltaMs: 7_500,
        now: () => clock,
        openSession,
        touchSession,
        closeSession,
        applyRollupDelta,
        upsertDevice,
      };

      // Three polls of playback, five seconds apart, then the stream disappears.
      let current: LiveSession[] = [liveSession({ positionTicks: 0 })];
      await runSessionPoll(deps);

      clock = START + 5_000;
      current = [liveSession({ positionTicks: 5_000 * 10_000 })];
      await runSessionPoll(deps);

      clock = START + 10_000;
      current = [liveSession({ positionTicks: 10_000 * 10_000 })];
      await runSessionPoll(deps);

      clock = START + 15_000;
      current = [];
      await runSessionPoll(deps);

      const sessions = await db.select().from(playbackSessions);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.endedAt).not.toBeNull();
      // Three five-second intervals were observed.
      expect(sessions[0]?.watchMs).toBe(15_000);

      const before = await db.select().from(playbackRollupDaily);
      const incrementalWatchMs = before.reduce((total, row) => total + row.watchMs, 0);

      await recomputeRollupRange(db, new Date(START - 86_400_000), new Date(START + 86_400_000));

      const after = await db.select().from(playbackRollupDaily);
      const recomputedWatchMs = after.reduce((total, row) => total + row.watchMs, 0);

      // The whole point: the fast incremental path and the authoritative recompute
      // must not disagree.
      expect(recomputedWatchMs).toBe(incrementalWatchMs);
      expect(recomputedWatchMs).toBe(15_000);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ userId: "user-1", itemId: "item-1", playCount: 1 });
    });
  });

  it("does not double count when the same poll is replayed", async () => {
    await withTestDatabase(async (db) => {
      await upsertItems(db, [{ id: "item-1", type: "Movie", name: "Demo Movie", libraryId: "lib-1" }]);

      const snapshots = memorySnapshotStore();
      const current = [liveSession()];
      const deps = {
        db,
        jellyfin: { getSessions: async () => current } as never,
        snapshots,
        completionThreshold: 0.9,
        maxWatchDeltaMs: 7_500,
        now: () => START,
        openSession,
        touchSession,
        closeSession,
        applyRollupDelta,
        upsertDevice,
      };

      await runSessionPoll(deps);
      await runSessionPoll(deps);
      await runSessionPoll(deps);

      const sessions = await db.select().from(playbackSessions);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.watchMs).toBe(0);
    });
  });

  it("agrees with the recompute for a stream that crosses midnight", async () => {
    await withTestDatabase(async (db) => {
      await upsertItems(db, [{ id: "item-1", type: "Movie", name: "Demo Movie", libraryId: "lib-1" }]);

      const beforeMidnight = new Date("2026-08-16T23:55:00Z").getTime();
      const snapshots = memorySnapshotStore();
      let clock = beforeMidnight;
      let current: LiveSession[] = [liveSession()];

      const deps = {
        db,
        jellyfin: { getSessions: async () => current } as never,
        snapshots,
        completionThreshold: 0.9,
        maxWatchDeltaMs: 7_500,
        now: () => clock,
        openSession,
        touchSession,
        closeSession,
        applyRollupDelta,
        upsertDevice,
      };

      await runSessionPoll(deps);

      // Next poll lands on the following calendar day.
      clock = new Date("2026-08-17T00:05:00Z").getTime();
      current = [liveSession({ positionTicks: 600_000 * 10_000 })];
      await runSessionPoll(deps);

      clock += 5_000;
      current = [];
      await runSessionPoll(deps);

      const incremental = await db.select().from(playbackRollupDaily);
      // One row, on the start day — not split across the 16th and 17th.
      expect(incremental).toHaveLength(1);
      expect(incremental[0]?.day).toBe("2026-08-16");

      const incrementalWatchMs = incremental[0]?.watchMs ?? 0;

      await recomputeRollupRange(db, new Date("2026-08-15T00:00:00Z"), new Date("2026-08-18T00:00:00Z"));

      const recomputed = await db.select().from(playbackRollupDaily);
      expect(recomputed).toHaveLength(1);
      expect(recomputed[0]?.day).toBe("2026-08-16");
      expect(recomputed[0]?.watchMs).toBe(incrementalWatchMs);
      expect(recomputed[0]?.playCount).toBe(1);
    });
  });

  it("keeps rollup totals equal to session totals for seeded data", async () => {
    await withTestDatabase(async (db) => {
      // A fixed injected clock (rather than Date.now()) makes both the generated
      // window and the recompute range below deterministic and mutually consistent,
      // regardless of when the test actually runs.
      const seedClock = new Date("2026-08-17T00:00:00Z").getTime();
      const data = generateSeedData({ days: 30, users: 3, items: 20, seed: 5, now: () => seedClock });

      await upsertItems(db, data.items);
      await db.insert(playbackSessions).values(data.sessions);
      await recomputeRollupRange(
        db,
        new Date(seedClock - 31 * 86_400_000),
        new Date(seedClock + 86_400_000),
      );

      const totals = await db.execute<{ sessions: string; rollup: string }>(sql`
        SELECT
          (SELECT coalesce(sum(watch_ms), 0) FROM playback_sessions)::text     AS sessions,
          (SELECT coalesce(sum(watch_ms), 0) FROM playback_rollup_daily)::text AS rollup
      `);

      expect(totals.rows[0]?.rollup).toBe(totals.rows[0]?.sessions);
    });
  });
});
