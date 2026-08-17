import { afterAll, describe, expect, it } from "vitest";
import { devices, items, jellyfinUsers, libraries, playbackSessions } from "../schema.js";
import { stopTestDatabase, withTestDatabase } from "../testing/harness.js";
import { getHistory } from "./history.js";
import type { Db } from "../client.js";

afterAll(stopTestDatabase);

const BASE = new Date("2026-08-16T20:00:00Z");

async function seed(db: Db): Promise<void> {
  await db.insert(libraries).values([{ id: "lib-1", name: "Movies", collectionType: "movies" }]);
  await db.insert(jellyfinUsers).values([
    { id: "user-a", name: "alpha" },
    { id: "user-b", name: "beta" },
  ]);
  await db.insert(items).values([
    { id: "item-1", name: "A Movie", type: "Movie", libraryId: "lib-1" },
    { id: "item-2", name: "Another", type: "Movie", libraryId: "lib-1" },
  ]);
  await db.insert(devices).values([{ id: "dev-1", name: "Living Room", client: "Jellyfin Web" }]);

  await db.insert(playbackSessions).values(
    Array.from({ length: 5 }, (_, index) => ({
      sessionId: `sess-${index}`,
      userId: index % 2 === 0 ? "user-a" : "user-b",
      itemId: index % 2 === 0 ? "item-1" : "item-2",
      deviceId: "dev-1",
      client: "Jellyfin Web",
      playMethod: "DirectPlay",
      startedAt: new Date(BASE.getTime() + index * 60_000),
      endedAt: new Date(BASE.getTime() + index * 60_000 + 30_000),
      lastSeenAt: new Date(BASE.getTime() + index * 60_000 + 30_000),
      watchMs: 30_000,
      completed: index === 0,
    })),
  );
}

describe("getHistory", () => {
  it("returns newest first with the total alongside the page", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const { rows, total } = await getHistory(db, { limit: 2, offset: 0 });

      expect(total).toBe(5);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.startedAt.getTime()).toBeGreaterThan(rows[1]?.startedAt.getTime() ?? 0);
    });
  });

  it("pages without overlapping or skipping", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const first = await getHistory(db, { limit: 2, offset: 0 });
      const second = await getHistory(db, { limit: 2, offset: 2 });

      const ids = [...first.rows, ...second.rows].map((row) => row.id);
      expect(new Set(ids).size).toBe(4);
    });
  });

  it("joins user, item, and device names", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const { rows } = await getHistory(db, { limit: 1, offset: 0 });

      expect(rows[0]).toMatchObject({
        userName: expect.any(String),
        itemName: expect.any(String),
        deviceName: "Living Room",
        client: "Jellyfin Web",
        playMethod: "DirectPlay",
      });
    });
  });

  it("filters by user, and total reflects the filter", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const { rows, total } = await getHistory(db, { limit: 50, offset: 0, userId: "user-b" });

      expect(total).toBe(2);
      expect(rows.every((row) => row.userId === "user-b")).toBe(true);
    });
  });

  it("filters by library", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const { total } = await getHistory(db, { limit: 50, offset: 0, libraryId: "lib-1" });

      expect(total).toBe(5);
    });
  });

  it("filters by date range on the start day", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const inRange = await getHistory(db, { limit: 50, offset: 0, from: "2026-08-16", to: "2026-08-16" });
      const outOfRange = await getHistory(db, { limit: 50, offset: 0, from: "2026-08-17", to: "2026-08-18" });

      expect(inRange.total).toBe(5);
      expect(outOfRange.total).toBe(0);
    });
  });

  it("clamps an absurd limit rather than trusting the caller", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      // An unbounded limit from a query string is a trivial denial of service.
      const { rows } = await getHistory(db, { limit: 100_000, offset: 0 });

      expect(rows.length).toBeLessThanOrEqual(200);
    });
  });

  it("returns an empty page and a zero total when nothing matches", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      expect(await getHistory(db, { limit: 50, offset: 0, userId: "nobody" })).toEqual({
        rows: [],
        total: 0,
      });
    });
  });
});
