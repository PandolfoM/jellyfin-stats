import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { items, jellyfinUsers, libraries, playbackRollupDaily } from "../schema.js";
import { stopTestDatabase, withTestDatabase } from "../testing/harness.js";
import {
  getLibraryStats,
  getOverview,
  getTopItems,
  getUserDetail,
  getUserStats,
  getWatchTimeSeries,
} from "./stats.js";
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

// A watch_ms this large has no real-world counterpart (roughly 285,000 years of
// playback) — it is chosen purely to sit past Number.MAX_SAFE_INTEGER
// (9_007_199_254_740_991) and pin the precision contract: the SQL layer must hand back
// the exact decimal string so the only rounding that happens is the single, visible
// `Number(...)` conversion in TypeScript, not an earlier, invisible one inside the
// driver. Do not "simplify" this to a realistic value; that would defeat the point.
//
// The literal is passed as a SQL string parameter (not a JS number literal) so the
// value itself is never rounded before it reaches Postgres.
const HUGE_WATCH_MS = "9007199254740993";

async function seedHugeWatchTime(db: Db): Promise<void> {
  await db.insert(libraries).values([{ id: "lib-movies", name: "Movies", collectionType: "movies" }]);
  await db.insert(jellyfinUsers).values([{ id: "user-a", name: "alpha", isAdmin: true }]);
  await db.insert(items).values([{ id: "item-huge", name: "Huge Watch", type: "Movie", libraryId: "lib-movies" }]);
  await db.execute(sql`
    INSERT INTO ${playbackRollupDaily} (day, user_id, item_id, library_id, play_count, watch_ms)
    VALUES ('2026-08-10', 'user-a', 'item-huge', 'lib-movies', 1, ${HUGE_WATCH_MS}::bigint)
  `);
}

describe("getUserStats", () => {
  it("returns every known user, including those with no activity in range", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const stats = await getUserStats(db, { from: "2026-08-12", to: "2026-08-12" });

      // user-b watched nothing that day but must not disappear from the list.
      expect(stats).toEqual([
        expect.objectContaining({ userId: "user-a", name: "alpha", plays: 3, watchMs: 90_000 }),
        expect.objectContaining({ userId: "user-b", name: "beta", plays: 0, watchMs: 0 }),
      ]);
    });
  });

  it("orders by watch time descending", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const stats = await getUserStats(db, RANGE);

      expect(stats.map((row) => row.userId)).toEqual(["user-a", "user-b"]);
    });
  });

  it("excludes archived users", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);
      await db.insert(jellyfinUsers).values({ id: "user-gone", name: "gone", archived: true });

      const stats = await getUserStats(db, RANGE);

      expect(stats.map((row) => row.userId)).not.toContain("user-gone");
    });
  });
});

describe("getLibraryStats", () => {
  it("returns every library with its totals, zero-filled", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const stats = await getLibraryStats(db, { from: "2026-08-12", to: "2026-08-12" });

      expect(stats).toEqual([
        expect.objectContaining({ libraryId: "lib-shows", name: "Shows", plays: 3, watchMs: 90_000 }),
        expect.objectContaining({ libraryId: "lib-movies", name: "Movies", plays: 0, watchMs: 0 }),
      ]);
    });
  });
});

describe("getUserDetail", () => {
  it("returns totals for one user", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const detail = await getUserDetail(db, "user-a", RANGE);

      expect(detail).toMatchObject({ userId: "user-a", name: "alpha", plays: 5, watchMs: 150_000 });
    });
  });

  it("returns null for an unknown user rather than an empty shell", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      expect(await getUserDetail(db, "nobody", RANGE)).toBeNull();
    });
  });

  it("returns a known user with zeros when they watched nothing in range", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const detail = await getUserDetail(db, "user-b", { from: "2026-08-12", to: "2026-08-12" });

      expect(detail).toMatchObject({ userId: "user-b", plays: 0, watchMs: 0 });
    });
  });
});

describe("watch time precision beyond Number.MAX_SAFE_INTEGER", () => {
  it("getTopItems converts the full decimal value rather than an already-mangled one", async () => {
    await withTestDatabase(async (db) => {
      await seedHugeWatchTime(db);

      const top = await getTopItems(db, { from: "2026-08-10", to: "2026-08-10" }, { limit: 10 });

      expect(top[0]?.watchMs).toBe(Number(HUGE_WATCH_MS));
    });
  });

  it("getOverview converts the full decimal value rather than an already-mangled one", async () => {
    await withTestDatabase(async (db) => {
      await seedHugeWatchTime(db);

      const overview = await getOverview(db, { from: "2026-08-10", to: "2026-08-10" });

      expect(overview.watchMs).toBe(Number(HUGE_WATCH_MS));
    });
  });
});
