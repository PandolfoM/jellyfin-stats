import { describe, expect, it } from "vitest";
import { dayCount, parseBackfillArgs } from "./backfill.js";

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
  it("counts the whole days a range covers", () => {
    expect(
      dayCount({ from: new Date("2026-08-10T00:00:00Z"), to: new Date("2026-08-17T00:00:00Z") }),
    ).toBe(7);
  });

  it("reports one day for a same-day range", () => {
    // recomputeRollupRange ceils a non-boundary `to` up to the next day, so --from and
    // --to on the same date rebuild exactly that one day, not zero.
    const day = new Date("2026-08-17T00:00:00Z");
    expect(dayCount({ from: day, to: day })).toBe(1);
  });
});
