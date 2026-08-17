import { applyRollupDelta, playbackRollupDaily, playbackSessions } from "@jfstats/db";
import { stopTestDatabase, withTestDatabase } from "@jfstats/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { dayCount, parseBackfillArgs, runBackfill } from "./backfill.js";

afterAll(stopTestDatabase);

function range(argv: string[]): { from: string; to: string } {
  const parsed = parseBackfillArgs(argv);
  if ("error" in parsed) throw new Error(`expected a range, got: ${parsed.error}`);
  return { from: parsed.from.toISOString(), to: parsed.to.toISOString() };
}

function error(argv: string[]): string {
  const parsed = parseBackfillArgs(argv);
  if (!("error" in parsed)) throw new Error("expected an error, got a range");
  return parsed.error;
}

describe("parseBackfillArgs", () => {
  it("parses both dates as UTC day starts", () => {
    // UTC, not local: parsing in local time would shift the whole window by the
    // operator's offset and rebuild the wrong days without any error.
    expect(range(["--from", "2026-08-10", "--to", "2026-08-17"])).toEqual({
      from: "2026-08-10T00:00:00.000Z",
      to: "2026-08-17T00:00:00.000Z",
    });
  });

  it("accepts --flag=value as well as --flag value", () => {
    expect(range(["--from=2026-08-10", "--to=2026-08-17"])).toEqual({
      from: "2026-08-10T00:00:00.000Z",
      to: "2026-08-17T00:00:00.000Z",
    });
  });

  it("names every missing argument rather than failing on the first", () => {
    expect(error([])).toContain("--from, --to");
    expect(error(["--from", "2026-08-10"])).toContain("--to");
    expect(error(["--to", "2026-08-17"])).toContain("--from");
  });

  it("includes usage in every error", () => {
    expect(error([])).toContain("pnpm --filter @jfstats/server backfill");
  });

  it("rejects a date it cannot parse", () => {
    expect(error(["--from", "yesterday", "--to", "2026-08-17"])).toContain("yesterday");
    expect(error(["--from", "2026-08-10", "--to", "not-a-date"])).toContain("not-a-date");
  });

  it("rejects a well-formed but impossible date", () => {
    expect(error(["--from", "2026-02-30", "--to", "2026-08-17"])).toContain("2026-02-30");
  });

  it("rejects a loose date rather than parsing it in local time", () => {
    // new Date("2026-8-1") parses successfully — in the local timezone. Accepting it
    // would silently move the window, so the shape check refuses it outright.
    expect(error(["--from", "2026-8-1", "--to", "2026-08-17"])).toContain("2026-8-1");
  });

  it("rejects an inverted range instead of rebuilding nothing", () => {
    expect(error(["--from", "2026-08-17", "--to", "2026-08-10"])).toContain("is before");
  });

  it("accepts a single-day range", () => {
    expect(range(["--from", "2026-08-17", "--to", "2026-08-17"])).toEqual({
      from: "2026-08-17T00:00:00.000Z",
      to: "2026-08-17T00:00:00.000Z",
    });
  });
});

describe("dayCount", () => {
  it("counts the inclusive whole days a range covers", () => {
    // --to is inclusive, so Aug 10 through Aug 17 is 8 named days (10, 11, ..., 17),
    // not the 7-day difference between the two boundaries.
    expect(
      dayCount({ from: new Date("2026-08-10T00:00:00Z"), to: new Date("2026-08-17T00:00:00Z") }),
    ).toBe(8);
  });

  it("reports one day for a same-day range", () => {
    // --to is inclusive (runBackfill advances it by one UTC day before calling
    // recomputeRollupRange), so --from and --to on the same date cover exactly that
    // one day, not zero.
    const day = new Date("2026-08-17T00:00:00Z");
    expect(dayCount({ from: day, to: day })).toBe(1);
  });
});

describe("runBackfill", () => {
  it("restores a seeded day's rollup rows via the same path --from D --to D uses", async () => {
    await withTestDatabase(async (db) => {
      const day = "2026-08-16";
      const startedAt = new Date(`${day}T20:00:00.000Z`);

      // A closed session on the day being repaired, plus the rollup row it should
      // produce — as if an earlier incremental write had already landed correctly.
      await db.insert(playbackSessions).values({
        sessionId: "seed-ps-1",
        itemId: "seed-item-1",
        userId: "seed-user-1",
        startedAt,
        lastSeenAt: startedAt,
        endedAt: new Date(startedAt.getTime() + 60_000),
        watchMs: 5_000,
      });
      await applyRollupDelta(db, {
        day,
        userId: "seed-user-1",
        itemId: "seed-item-1",
        libraryId: null,
        playCount: 1,
        watchMs: 5_000,
      });

      // Simulate the drift a backfill is meant to repair: the rollup row for the day
      // is gone, but the session it was derived from is still there.
      await db.delete(playbackRollupDaily);
      expect(await db.select().from(playbackRollupDaily)).toEqual([]);

      const range = parseBackfillArgs(["--from", day, "--to", day]);
      if ("error" in range) throw new Error(`expected a range, got: ${range.error}`);

      const days = await runBackfill(db, range);

      expect(days).toBe(1);
      const rows = await db.select().from(playbackRollupDaily);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        day,
        userId: "seed-user-1",
        itemId: "seed-item-1",
        playCount: 1,
        watchMs: 5_000,
      });
    });
  });
});
