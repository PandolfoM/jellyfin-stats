import { describe, expect, it } from "vitest";
import { formatCount, formatDay, formatDuration } from "./format";

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
