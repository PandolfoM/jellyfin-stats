import { afterAll, describe, expect, it } from "vitest";
import { items, jellyfinUsers, libraries, playbackRollupDaily } from "../schema.js";
import { stopTestDatabase, withTestDatabase } from "../testing/harness.js";
import { getOverview, getTopItems, getWatchTimeSeries } from "./stats.js";
import type { Db } from "../client.js";

afterAll(stopTestDatabase);

async function seed(db: Db): Promise<void> {
  await db.insert(libraries).values([
    { id: "lib-movies", name: "Movies", collectionType: "movies" },
    { id: "lib-shows", name: "Shows", collectionType: "tvshows" },
  ]);
  await db.insert(jellyfinUsers).values([
    { id: "user-a", name: "alpha", isAdmin: true },
    { id: "user-b", name: "beta", isAdmin: false },
  ]);
  await db.insert(items).values([
    { id: "item-1", name: "First Movie", type: "Movie", libraryId: "lib-movies", imageTag: "tag-1" },
    { id: "item-2", name: "Second Movie", type: "Movie", libraryId: "lib-movies" },
    { id: "item-3", name: "An Episode", type: "Episode", libraryId: "lib-shows", seriesId: "series-1" },
  ]);
  await db.insert(playbackRollupDaily).values([
    { day: "2026-08-10", userId: "user-a", itemId: "item-1", libraryId: "lib-movies", playCount: 2, watchMs: 60_000 },
    { day: "2026-08-10", userId: "user-b", itemId: "item-2", libraryId: "lib-movies", playCount: 1, watchMs: 30_000 },
    { day: "2026-08-12", userId: "user-a", itemId: "item-3", libraryId: "lib-shows", playCount: 3, watchMs: 90_000 },
    // Outside every range used below.
    { day: "2026-07-01", userId: "user-a", itemId: "item-1", libraryId: "lib-movies", playCount: 9, watchMs: 999_000 },
  ]);
}

const RANGE = { from: "2026-08-10", to: "2026-08-12" };

describe("getOverview", () => {
  it("totals plays, watch time, and distinct users in range", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      expect(await getOverview(db, RANGE)).toEqual({
        plays: 6,
        watchMs: 180_000,
        activeUsers: 2,
        activeItems: 3,
      });
    });
  });

  it("excludes rows outside the range", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const result = await getOverview(db, { from: "2026-08-11", to: "2026-08-12" });

      expect(result).toEqual({ plays: 3, watchMs: 90_000, activeUsers: 1, activeItems: 1 });
    });
  });

  it("returns zeros rather than nulls for an empty range", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      expect(await getOverview(db, { from: "2020-01-01", to: "2020-01-02" })).toEqual({
        plays: 0,
        watchMs: 0,
        activeUsers: 0,
        activeItems: 0,
      });
    });
  });

  it("treats the range as inclusive of both endpoints", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const single = await getOverview(db, { from: "2026-08-12", to: "2026-08-12" });

      expect(single.plays).toBe(3);
    });
  });
});

describe("getWatchTimeSeries", () => {
  it("emits one row per day including days with no activity", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const series = await getWatchTimeSeries(db, RANGE);

      // A chart that skips empty days connects across them and misreports a quiet week.
      expect(series).toEqual([
        { day: "2026-08-10", plays: 3, watchMs: 90_000 },
        { day: "2026-08-11", plays: 0, watchMs: 0 },
        { day: "2026-08-12", plays: 3, watchMs: 90_000 },
      ]);
    });
  });

  it("returns all-zero rows for a range with no data at all", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const series = await getWatchTimeSeries(db, { from: "2020-01-01", to: "2020-01-03" });

      expect(series).toHaveLength(3);
      expect(series.every((row) => row.plays === 0 && row.watchMs === 0)).toBe(true);
    });
  });
});

describe("getTopItems", () => {
  it("ranks by watch time and joins item metadata", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const top = await getTopItems(db, RANGE, { limit: 10 });

      expect(top[0]).toMatchObject({ itemId: "item-3", name: "An Episode", type: "Episode", plays: 3, watchMs: 90_000 });
      expect(top[1]).toMatchObject({ itemId: "item-1", name: "First Movie", watchMs: 60_000 });
      expect(top).toHaveLength(3);
    });
  });

  it("honours the limit", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      expect(await getTopItems(db, RANGE, { limit: 2 })).toHaveLength(2);
    });
  });

  it("filters by library", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const top = await getTopItems(db, RANGE, { limit: 10, libraryId: "lib-shows" });

      expect(top.map((row) => row.itemId)).toEqual(["item-3"]);
    });
  });

  it("filters by user", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const top = await getTopItems(db, RANGE, { limit: 10, userId: "user-b" });

      expect(top.map((row) => row.itemId)).toEqual(["item-2"]);
    });
  });

  it("carries the image tag through so posters can be requested", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const top = await getTopItems(db, RANGE, { limit: 10, libraryId: "lib-movies" });

      expect(top.find((row) => row.itemId === "item-1")?.imageTag).toBe("tag-1");
      expect(top.find((row) => row.itemId === "item-2")?.imageTag).toBeNull();
    });
  });
});
