import { afterAll, describe, expect, it } from "vitest";
import { stopTestDatabase, withTestDatabase } from "../testing/harness.js";
import { readJobRuns, writeJobRun } from "./jobs.js";

afterAll(stopTestDatabase);

describe("job run repository", () => {
  it("returns an empty map before anything has run", async () => {
    await withTestDatabase(async (db) => {
      expect((await readJobRuns(db)).size).toBe(0);
    });
  });

  it("writes and reads back a run time", async () => {
    await withTestDatabase(async (db) => {
      const at = new Date("2026-08-18T03:00:00Z");
      await writeJobRun(db, "item-sync", at);
      expect((await readJobRuns(db)).get("item-sync")).toEqual(at);
    });
  });

  it("overwrites a previous run time rather than inserting a second row", async () => {
    await withTestDatabase(async (db) => {
      await writeJobRun(db, "session-poll", new Date("2026-08-18T03:00:00Z"));
      const later = new Date("2026-08-18T04:00:00Z");
      await writeJobRun(db, "session-poll", later);

      const runs = await readJobRuns(db);
      expect(runs.get("session-poll")).toEqual(later);
      expect(runs.size).toBe(1);
    });
  });

  // Distinct job names must not collide on a shared row. Without a real
  // second row here, a bug that always upserts against a single hard-coded
  // key would still pass every test above.
  it("keeps distinct job names in separate rows", async () => {
    await withTestDatabase(async (db) => {
      await writeJobRun(db, "session-poll", new Date("2026-08-18T03:00:00Z"));
      await writeJobRun(db, "reference-sync", new Date("2026-08-18T04:00:00Z"));

      const runs = await readJobRuns(db);
      expect(runs.size).toBe(2);
      expect(runs.get("session-poll")).toEqual(new Date("2026-08-18T03:00:00Z"));
      expect(runs.get("reference-sync")).toEqual(new Date("2026-08-18T04:00:00Z"));
    });
  });
});
