import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { items, jellyfinUsers } from "../schema.js";
import { stopTestDatabase, withTestDatabase } from "../testing/harness.js";
import { archiveMissingItems, upsertItems, upsertUsers } from "./reference.js";

afterAll(stopTestDatabase);

describe("reference repositories", () => {
  it("inserts users on first sync", async () => {
    await withTestDatabase(async (db) => {
      await upsertUsers(db, [{ id: "u1", name: "alice", isAdmin: true }]);

      const rows = await db.select().from(jellyfinUsers);
      expect(rows).toEqual([
        expect.objectContaining({ id: "u1", name: "alice", isAdmin: true, archived: false }),
      ]);
    });
  });

  it("updates rather than duplicating on repeat sync", async () => {
    await withTestDatabase(async (db) => {
      await upsertUsers(db, [{ id: "u1", name: "alice", isAdmin: false }]);
      await upsertUsers(db, [{ id: "u1", name: "alice-renamed", isAdmin: true }]);

      const rows = await db.select().from(jellyfinUsers);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: "alice-renamed", isAdmin: true });
    });
  });

  it("un-archives a user who reappears in Jellyfin", async () => {
    await withTestDatabase(async (db) => {
      await upsertUsers(db, [{ id: "u1", name: "alice", isAdmin: false }]);
      await db.update(jellyfinUsers).set({ archived: true }).where(eq(jellyfinUsers.id, "u1"));

      await upsertUsers(db, [{ id: "u1", name: "alice", isAdmin: false }]);

      const rows = await db.select().from(jellyfinUsers);
      expect(rows[0]?.archived).toBe(false);
    });
  });

  it("accepts an empty batch without error", async () => {
    await withTestDatabase(async (db) => {
      await expect(upsertUsers(db, [])).resolves.toBeUndefined();
      await expect(upsertItems(db, [])).resolves.toBeUndefined();
    });
  });

  it("archives items that vanished from Jellyfin instead of deleting them", async () => {
    await withTestDatabase(async (db) => {
      await upsertItems(db, [
        { id: "i1", type: "Movie", name: "Kept", libraryId: "lib1" },
        { id: "i2", type: "Movie", name: "Deleted From Disk", libraryId: "lib1" },
      ]);

      const archived = await archiveMissingItems(db, ["i1"]);

      expect(archived).toBe(1);
      const rows = await db.select().from(items).orderBy(items.id);
      // History for a removed file must survive, so the row stays.
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ id: "i2", archived: true });
    });
  });

  it("archives nothing when Jellyfin reports no items, to survive a failed sync", async () => {
    await withTestDatabase(async (db) => {
      await upsertItems(db, [{ id: "i1", type: "Movie", name: "Kept", libraryId: "lib1" }]);

      const archived = await archiveMissingItems(db, []);

      expect(archived).toBe(0);
      const rows = await db.select().from(items);
      expect(rows[0]?.archived).toBe(false);
    });
  });

  it("un-archives an item that reappears after being archived", async () => {
    await withTestDatabase(async (db) => {
      await upsertItems(db, [
        { id: "i1", type: "Movie", name: "Kept", libraryId: "lib1" },
        { id: "i2", type: "Movie", name: "Returned", libraryId: "lib1" },
      ]);

      // Archive i2 by reporting only i1 as present.
      await archiveMissingItems(db, ["i1"]);
      let rows = await db.select().from(items).orderBy(items.id);
      expect(rows[1]).toMatchObject({ id: "i2", archived: true });

      // Reappear i2 in the next sync.
      await upsertItems(db, [
        { id: "i1", type: "Movie", name: "Kept", libraryId: "lib1" },
        { id: "i2", type: "Movie", name: "Returned", libraryId: "lib1" },
      ]);

      rows = await db.select().from(items).orderBy(items.id);
      expect(rows[1]).toMatchObject({ id: "i2", archived: false });
    });
  });
});
