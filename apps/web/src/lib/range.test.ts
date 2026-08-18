import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_RANGE_DAYS, clampRangeDays, defaultRange } from "./range";

// Pinned to a negative-UTC-offset zone for the same reason lib/format.test.ts
// pins one for formatDay: without it, a regression from the deliberate
// `toISOString()`/epoch-ms arithmetic in range.ts back to `new Date(day)` read
// with local accessors would pass silently on any UTC-or-positive-offset
// machine (most CI runners) even though it shifts the day west of Greenwich
// on this one.
beforeAll(() => {
  vi.stubEnv("TZ", "America/Los_Angeles");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("defaultRange", () => {
  it("is exactly 30 inclusive days ending 'today', from an injected clock", () => {
    // Crosses a year boundary, so an off-by-one in the month/year rollover
    // (not just the day) would also be caught here.
    const now = () => Date.parse("2026-01-05T09:30:00.000Z");

    expect(defaultRange(now)).toEqual({ from: "2025-12-07", to: "2026-01-05" });
  });

  it("defaults to the real wall clock when no clock is injected", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-18T12:00:00.000Z"));

    expect(defaultRange()).toEqual({ from: "2026-07-20", to: "2026-08-18" });

    vi.useRealTimers();
  });
});

describe("clampRangeDays", () => {
  it("passes an already-valid range through unchanged", () => {
    const range = { from: "2026-01-01", to: "2026-01-31" };
    expect(clampRangeDays(range)).toEqual(range);
  });

  it("leaves a range exactly at the MAX_RANGE_DAYS boundary unchanged", () => {
    // from..to below spans exactly 1000 inclusive days — one day short of the
    // clamp trigger. If the clamp used `>=` instead of `>`, or the span
    // arithmetic were off by one, this would come back clamped when it
    // should not.
    const range = { from: "2023-11-23", to: "2026-08-18" };
    expect(clampRangeDays(range)).toEqual(range);
  });

  it("clamps a range longer than MAX_RANGE_DAYS from the `from` end", () => {
    // One day longer than the boundary case above — 1001 inclusive days —
    // must be pulled in to exactly MAX_RANGE_DAYS, keeping `to` fixed.
    const result = clampRangeDays({ from: "2023-11-22", to: "2026-08-18" });

    expect(result).toEqual({ from: "2023-11-23", to: "2026-08-18" });

    const spanDays =
      (Date.parse(`${result.to}T00:00:00.000Z`) - Date.parse(`${result.from}T00:00:00.000Z`)) /
        86_400_000 +
      1;
    expect(spanDays).toBe(MAX_RANGE_DAYS);
  });

  it("corrects a reversed range by swapping the endpoints, rather than sending it as-is", () => {
    const result = clampRangeDays({ from: "2026-05-10", to: "2026-05-01" });
    expect(result).toEqual({ from: "2026-05-01", to: "2026-05-10" });
  });
});
