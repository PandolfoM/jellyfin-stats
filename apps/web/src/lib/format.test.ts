import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formatCount, formatDay, formatDuration, formatPercent } from "./format";

describe("formatDuration", () => {
  it("renders hours and minutes above an hour", () => {
    expect(formatDuration(8_040_000)).toBe("2h 14m");
  });

  it("renders minutes only below an hour", () => {
    expect(formatDuration(2_820_000)).toBe("47m");
  });

  it("renders seconds below a minute, so a short sample is not just '0m'", () => {
    expect(formatDuration(38_000)).toBe("38s");
  });

  it("renders zero as 0m rather than an empty string", () => {
    expect(formatDuration(0)).toBe("0m");
  });

  it("omits a zero minute component", () => {
    expect(formatDuration(7_200_000)).toBe("2h");
  });

  it("does not produce a negative duration from a negative input", () => {
    expect(formatDuration(-5_000)).toBe("0m");
  });
});

describe("formatDay", () => {
  // Pinned to a negative-UTC-offset zone so this suite's timezone-boundary
  // guard is deterministic. Without a pinned TZ, a regression to
  // `new Date(day)` + local-time reads would pass silently on any
  // UTC-or-positive-offset machine — which is what most CI runners default
  // to — even though it fails on machines west of Greenwich.
  beforeAll(() => {
    vi.stubEnv("TZ", "America/Los_Angeles");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("renders an ISO day as a short human date", () => {
    expect(formatDay("2026-08-16")).toBe("16 Aug");
  });

  it("does not shift the day across a timezone boundary", () => {
    // Parsing "2026-01-01" as local time in a negative-offset zone yields
    // 31 Dec. The formatter must treat the string as a calendar date.
    expect(formatDay("2026-01-01")).toBe("1 Jan");
  });
});

describe("formatCount", () => {
  it("separates thousands", () => {
    expect(formatCount(12_345)).toBe("12,345");
  });

  it("leaves small numbers alone", () => {
    expect(formatCount(7)).toBe("7");
  });
});

describe("formatPercent", () => {
  it("renders a 0-1 fraction as a rounded whole-number percentage", () => {
    expect(formatPercent(0.9)).toBe("90%");
  });

  it("rounds rather than truncates", () => {
    // 0.905 * 100 = 90.5 — truncation would give "90%"; rounding gives "91%".
    expect(formatPercent(0.905)).toBe("91%");
  });

  it("renders the 0 and 1 boundaries", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(1)).toBe("100%");
  });
});
