import { desc } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { devices, items, jellyfinUsers, libraries, playbackSessions } from "../schema.js";
import { stopTestDatabase, withTestDatabase } from "../testing/harness.js";
import { getHistory, MAX_HISTORY_LIMIT } from "./history.js";
import type { Db } from "../client.js";

afterAll(stopTestDatabase);

const BASE = new Date("2026-08-16T20:00:00Z");

async function seed(db: Db, sessionCount = 5): Promise<void> {
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
    Array.from({ length: sessionCount }, (_, index) => ({
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

  it("pages across the entire fixture with no duplicates and no gaps", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      // Ground truth comes straight from the table via the query builder, not from
      // another getHistory() call — so a bug shared by every getHistory() call (e.g.
      // in the offset clamp itself) can't cancel out and hide from this assertion.
      const allSessions = await db
        .select({ id: playbackSessions.id })
        .from(playbackSessions)
        .orderBy(desc(playbackSessions.startedAt), desc(playbackSessions.id));
      const expectedIds = allSessions.map((row) => row.id);
      expect(expectedIds).toHaveLength(5);

      const pageSize = 2;
      const pagedIds: string[] = [];
      for (let offset = 0; offset < expectedIds.length; offset += pageSize) {
        const { rows } = await getHistory(db, { limit: pageSize, offset });
        pagedIds.push(...rows.map((row) => row.id));
      }

      // Exact order match (not just same set) catches both a row skipped by an
      // off-by-one OFFSET and a row duplicated across adjacent pages — a plain
      // Set-size comparison would miss a skip, since a skip and a clean page both
      // yield the same number of distinct ids.
      expect(pagedIds).toEqual(expectedIds);
    });
  });

  it("carries the episode's series name and season/episode numbers through the join", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      // Season 0 on purpose: it is Jellyfin's specials season, a real value that a
      // truthiness check anywhere along the path would turn into a null.
      await db.insert(items).values([
        {
          id: "item-ep",
          name: "Fishes",
          type: "Episode",
          libraryId: "lib-1",
          seriesId: "series-1",
          seriesName: "The Bear",
          seasonNumber: 0,
          episodeNumber: 6,
        },
      ]);
      await db.insert(playbackSessions).values([
        {
          sessionId: "sess-ep",
          userId: "user-a",
          itemId: "item-ep",
          deviceId: "dev-1",
          // Later than every seeded session so it lands first on the newest-first page.
          startedAt: new Date(BASE.getTime() + 3_600_000),
          endedAt: new Date(BASE.getTime() + 3_630_000),
          lastSeenAt: new Date(BASE.getTime() + 3_630_000),
          watchMs: 30_000,
          completed: false,
        },
      ]);

      const { rows } = await getHistory(db, { limit: 1, offset: 0 });

      expect(rows[0]).toMatchObject({
        itemName: "Fishes",
        seriesId: "series-1",
        seriesName: "The Bear",
        seasonNumber: 0,
        episodeNumber: 6,
      });
    });
  });

  it("leaves the episode fields null for a movie", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const { rows } = await getHistory(db, { limit: 1, offset: 0 });

      expect(rows[0]?.seriesName).toBeNull();
      expect(rows[0]?.seasonNumber).toBeNull();
      expect(rows[0]?.episodeNumber).toBeNull();
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

  it("still renders history for a session whose item and user were deleted from Jellyfin", async () => {
    await withTestDatabase(async (db) => {
      // No items/jellyfinUsers/devices rows at all — the session's foreign ids
      // reference nothing, the way they would once the source records are deleted.
      await db.insert(playbackSessions).values({
        sessionId: "sess-orphan",
        userId: "ghost-user",
        itemId: "ghost-item",
        deviceId: null,
        client: "Jellyfin Web",
        playMethod: "DirectPlay",
        startedAt: BASE,
        endedAt: new Date(BASE.getTime() + 30_000),
        lastSeenAt: new Date(BASE.getTime() + 30_000),
        watchMs: 30_000,
        completed: true,
      });

      const { rows, total } = await getHistory(db, { limit: 50, offset: 0 });

      expect(total).toBe(1);
      expect(rows[0]).toMatchObject({
        userId: "ghost-user",
        userName: "Unknown user",
        itemId: "ghost-item",
        itemName: "Unknown item",
        itemType: "Unknown",
        libraryId: null,
        deviceName: null,
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

  it("filters by library, excluding sessions from a different library", async () => {
    await withTestDatabase(async (db) => {
      await seed(db); // lib-1: 5 sessions

      await db.insert(libraries).values([{ id: "lib-2", name: "TV", collectionType: "tvshows" }]);
      await db
        .insert(items)
        .values([{ id: "item-3", name: "A Show", type: "Series", libraryId: "lib-2" }]);
      await db.insert(playbackSessions).values({
        sessionId: "sess-other-lib",
        userId: "user-a",
        itemId: "item-3",
        deviceId: "dev-1",
        client: "Jellyfin Web",
        playMethod: "DirectPlay",
        startedAt: new Date(BASE.getTime() + 10 * 60_000),
        endedAt: new Date(BASE.getTime() + 10 * 60_000 + 30_000),
        lastSeenAt: new Date(BASE.getTime() + 10 * 60_000 + 30_000),
        watchMs: 30_000,
        completed: false,
      });

      // 6 sessions exist in total across both libraries; filtering by lib-1 must
      // exclude the lib-2 row rather than counting it.
      const { total, rows } = await getHistory(db, { limit: 50, offset: 0, libraryId: "lib-1" });

      expect(total).toBe(5);
      expect(rows.every((row) => row.libraryId === "lib-1")).toBe(true);
    });
  });

  it("returns a zero total for a library with no sessions", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);
      await db
        .insert(libraries)
        .values([{ id: "lib-empty", name: "Empty", collectionType: "movies" }]);

      const { total, rows } = await getHistory(db, {
        limit: 50,
        offset: 0,
        libraryId: "lib-empty",
      });

      expect(total).toBe(0);
      expect(rows).toEqual([]);
    });
  });

  it("filters by date range on the start day", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const inRange = await getHistory(db, {
        limit: 50,
        offset: 0,
        from: "2026-08-16",
        to: "2026-08-16",
      });
      const outOfRange = await getHistory(db, {
        limit: 50,
        offset: 0,
        from: "2026-08-17",
        to: "2026-08-18",
      });

      expect(inRange.total).toBe(5);
      expect(outOfRange.total).toBe(0);
    });
  });

  it("clamps an absurd limit to MAX_HISTORY_LIMIT rather than trusting the caller", async () => {
    await withTestDatabase(async (db) => {
      // More rows than the cap, so the clamp is the only thing that can produce a
      // page shorter than the request — with only 5 rows in the table (as the other
      // cases seed), a request for 100_000 would return 5 regardless of whether the
      // clamp exists at all.
      await seed(db, MAX_HISTORY_LIMIT + 1);

      const { rows } = await getHistory(db, { limit: 100_000, offset: 0 });

      expect(rows).toHaveLength(MAX_HISTORY_LIMIT);
    });
  });

  it("treats a non-finite limit as a safe default instead of erroring at the driver", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      // Math.max/Math.min propagate NaN rather than clamping it, so this is the
      // specific input class the clamp has to guard explicitly.
      const { rows } = await getHistory(db, { limit: Number.NaN, offset: 0 });

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(MAX_HISTORY_LIMIT);
    });
  });

  it("treats a non-finite offset as zero instead of erroring at the driver", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const withNanOffset = await getHistory(db, { limit: 2, offset: Number.NaN });
      const withZeroOffset = await getHistory(db, { limit: 2, offset: 0 });

      expect(withNanOffset.rows.map((row) => row.id)).toEqual(
        withZeroOffset.rows.map((row) => row.id),
      );
    });
  });

  it("clamps a negative limit up to at least 1", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const { rows } = await getHistory(db, { limit: -5, offset: 0 });

      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("truncates a fractional limit rather than relying on driver coercion", async () => {
    await withTestDatabase(async (db) => {
      await seed(db);

      const { rows } = await getHistory(db, { limit: 2.9, offset: 0 });

      expect(rows).toHaveLength(2);
    });
  });

  // Zero-duration rows are start/stop churn from a session flapping in and out of
  // Jellyfin's /Sessions payload, not viewings anyone wants to read. They are
  // filtered out of history entirely.
  describe("zero-duration rows", () => {
    async function seedWithEmptyRows(db: Db): Promise<void> {
      await seed(db);
      await db.insert(playbackSessions).values(
        Array.from({ length: 3 }, (_, index) => ({
          sessionId: `empty-${index}`,
          userId: "user-a",
          itemId: "item-1",
          deviceId: "dev-1",
          client: "Chrome",
          playMethod: "DirectPlay",
          // Newer than every seeded row, so a missing filter puts these first and
          // the assertions below cannot pass by accident of ordering.
          startedAt: new Date(BASE.getTime() + 3_600_000 + index * 60_000),
          endedAt: new Date(BASE.getTime() + 3_600_000 + index * 60_000),
          lastSeenAt: new Date(BASE.getTime() + 3_600_000 + index * 60_000),
          watchMs: 0,
          completed: false,
        })),
      );
    }

    it("omits them from the returned rows", async () => {
      await withTestDatabase(async (db) => {
        await seedWithEmptyRows(db);

        const { rows } = await getHistory(db, { limit: MAX_HISTORY_LIMIT, offset: 0 });

        expect(rows).toHaveLength(5);
        expect(rows.every((row) => row.watchMs > 0)).toBe(true);
      });
    });

    // The row assertion above passes even if the filter is applied only to the row
    // query and not the count — which would leave `total` claiming 8 and paginate
    // into an empty final page. This is the case that catches that.
    it("omits them from the total as well, so pagination does not run off the end", async () => {
      await withTestDatabase(async (db) => {
        await seedWithEmptyRows(db);

        const { total } = await getHistory(db, { limit: 2, offset: 0 });

        expect(total).toBe(5);
      });
    });

    it("keeps a short but non-zero play, which is a real viewing", async () => {
      await withTestDatabase(async (db) => {
        await seedWithEmptyRows(db);
        await db.insert(playbackSessions).values({
          sessionId: "brief",
          userId: "user-a",
          itemId: "item-1",
          deviceId: "dev-1",
          startedAt: new Date(BASE.getTime() + 7_200_000),
          endedAt: new Date(BASE.getTime() + 7_200_000 + 1),
          lastSeenAt: new Date(BASE.getTime() + 7_200_000 + 1),
          // One millisecond. formatDuration renders anything under a minute as
          // seconds, never "0m", so the boundary the UI shows is watch_ms > 0 —
          // not some larger "too short to matter" threshold.
          watchMs: 1,
          completed: false,
        });

        const { rows, total } = await getHistory(db, { limit: MAX_HISTORY_LIMIT, offset: 0 });

        expect(total).toBe(6);
        expect(rows.some((row) => row.watchMs === 1)).toBe(true);
      });
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
