import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { playbackSessions } from "./schema.js";
import { stopTestDatabase, withTestDatabase } from "./testing/harness.js";

afterAll(stopTestDatabase);

describe("schema", () => {
  it("applies migrations and creates every expected table", async () => {
    await withTestDatabase(async (db) => {
      const result = await db.execute<{ table_name: string }>(
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      const tables = result.rows.map((row) => row.table_name);

      expect(tables).toEqual(
        expect.arrayContaining([
          "jellyfin_users",
          "libraries",
          "items",
          "devices",
          "playback_sessions",
          "playback_rollup_daily",
        ]),
      );
    });
  });

  it("rejects a duplicate play session and item pair", async () => {
    await withTestDatabase(async (db) => {
      const row = {
        playSessionId: "ps-1",
        userId: "user-1",
        itemId: "item-1",
        startedAt: new Date(),
        lastSeenAt: new Date(),
      };

      await db.insert(playbackSessions).values(row);

      // This is the guarantee that makes a replayed poll harmless.
      await expect(db.insert(playbackSessions).values(row)).rejects.toThrow(
        /playback_sessions_identity_uniq/,
      );
    });
  });

  it("allows the same play session id with a different item", async () => {
    await withTestDatabase(async (db) => {
      const base = {
        playSessionId: "ps-1",
        userId: "user-1",
        startedAt: new Date(),
        lastSeenAt: new Date(),
      };

      await db.insert(playbackSessions).values({ ...base, itemId: "episode-1" });
      await db.insert(playbackSessions).values({ ...base, itemId: "episode-2" });

      const rows = await db.select().from(playbackSessions);
      expect(rows).toHaveLength(2);
    });
  });
});
