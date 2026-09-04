import { afterAll, describe, expect, it } from "vitest";
import { items, jellyfinUsers, libraries, playbackRollupDaily } from "../schema.js";
import { stopTestDatabase, withTestDatabase } from "../testing/harness.js";
import { getItemDetail } from "./items.js";
import type { Db } from "../client.js";

afterAll(stopTestDatabase);

const RANGE = { from: "2026-08-01", to: "2026-08-31" };

async function seed(db: Db): Promise<void> {
  await db
    .insert(libraries)
    .values([{ id: "lib-shows", name: "Shows", collectionType: "tvshows" }]);
  await db.insert(jellyfinUsers).values([
    { id: "user-a", name: "alpha" },
    { id: "user-b", name: "beta" },
  ]);
  await db.insert(items).values([
    {
      id: "item-ep",
      name: "Fishes",
      type: "Episode",
      libraryId: "lib-shows",
      seriesId: "series-1",
      seriesName: "The Bear",
      seasonNumber: 2,
      episodeNumber: 6,
      productionYear: 2023,
      runtimeTicks: 39_000_000_000,
      imageTag: "tag-ep",
    },
    { id: "item-quiet", name: "Never Played", type: "Movie", libraryId: "lib-shows" },
  ]);
  await db.insert(playbackRollupDaily).values([
    { day: "2026-08-10", userId: "user-a", itemId: "item-ep", playCount: 2, watchMs: 60_000 },
    { day: "2026-08-11", userId: "user-a", itemId: "item-ep", playCount: 1, watchMs: 20_000 },
    { day: "2026-08-12", userId: "user-b", itemId: "item-ep", playCount: 1, watchMs: 30_000 },
    // Outside the range: must not count.
    { day: "2026-07-01", userId: "user-b", itemId: "item-ep", playCount: 9, watchMs: 999_000 },
  ]);
}

describe("getItemDetail", () => {
  it("returns the reference row with play totals and unique users for the range", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const detail = await getItemDetail(db, "item-ep", RANGE);

      expect(detail).toEqual({
        itemId: "item-ep",
        name: "Fishes",
        type: "Episode",
        libraryId: "lib-shows",
        libraryName: "Shows",
        seriesId: "series-1",
        seriesName: "The Bear",
        seasonNumber: 2,
        episodeNumber: 6,
        productionYear: 2023,
        runtimeTicks: 39_000_000_000,
        imageTag: "tag-ep",
        plays: 4,
        watchMs: 110_000,
        uniqueUsers: 2,
      });
    });
  });

  it("returns zeroed stats for an item with no plays in the range", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const detail = await getItemDetail(db, "item-quiet", RANGE);

      expect(detail).toMatchObject({ name: "Never Played", plays: 0, watchMs: 0, uniqueUsers: 0 });
    });
  });

  it("returns null for an id that is not in the reference table", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      await expect(getItemDetail(db, "nope", RANGE)).resolves.toBeNull();
    });
  });
});
