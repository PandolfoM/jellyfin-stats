import { sessions as sessionsTable, type Db } from "@jfstats/db";
import { stopTestDatabase, withTestDatabase } from "@jfstats/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createSessionStore } from "./sessions.js";

afterAll(stopTestDatabase);

const RECORD = { userId: "u-1", userName: "admin", isAdmin: true, createdAt: 1_777_000_000_000 };

async function readExpiresAt(db: Db, id: string): Promise<Date | null> {
  const rows = await db
    .select({ expiresAt: sessionsTable.expiresAt })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, id));
  return rows[0]?.expiresAt ?? null;
}

describe("session store", () => {
  it("round-trips a session by its id", async () => {
    await withTestDatabase(async (db) => {
      const store = createSessionStore(db);

      const id = await store.create(RECORD);

      expect(await store.get(id)).toEqual(RECORD);
    });
  });

  it("issues unguessable ids", async () => {
    await withTestDatabase(async (db) => {
      const store = createSessionStore(db);

      const a = await store.create(RECORD);
      const b = await store.create(RECORD);

      expect(a).not.toBe(b);
      // 32 random bytes, base64url encoded.
      expect(a.length).toBeGreaterThanOrEqual(43);
      expect(a).not.toContain(RECORD.userId);
    });
  });

  it("returns null for an unknown id", async () => {
    await withTestDatabase(async (db) => {
      const store = createSessionStore(db);

      expect(await store.get("not-a-real-session-id")).toBeNull();
    });
  });

  it("returns null after destroy, so logout actually revokes", async () => {
    await withTestDatabase(async (db) => {
      const store = createSessionStore(db);
      const id = await store.create(RECORD);

      await store.destroy(id);

      expect(await store.get(id)).toBeNull();
    });
  });

  it("slides the expiry on read so an active admin is not logged out", async () => {
    await withTestDatabase(async (db) => {
      const store = createSessionStore(db, 100);
      const id = await store.create(RECORD);
      // Force the row to look like it is about to expire, the same way the old
      // Redis version of this test forced a short TTL with `redis.expire`.
      await db
        .update(sessionsTable)
        .set({ expiresAt: new Date(Date.now() + 5_000) })
        .where(eq(sessionsTable.id, id));

      await store.get(id);

      const expiresAt = await readExpiresAt(db, id);
      expect(expiresAt).not.toBeNull();
      expect(expiresAt?.getTime()).toBeGreaterThan(Date.now() + 50_000);
    });
  });
});
