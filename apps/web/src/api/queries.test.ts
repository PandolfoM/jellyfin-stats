import { describe, expect, it } from "vitest";
import type { DateRange } from "../lib/range";
import {
  historyQuery,
  libraryStatsQuery,
  overviewQuery,
  seriesQuery,
  topItemsQuery,
  userDetailQuery,
  userStatsQuery,
} from "./queries";

const RANGE_A: DateRange = { from: "2026-01-01", to: "2026-01-31" };
// Differs from RANGE_A only in `to` — the exact shape of bug this test class
// exists to catch: a query key that captured `from` but dropped `to` would
// still call this "the same key" and TanStack Query would serve January's
// numbers under a label that says the range runs through February.
const RANGE_B: DateRange = { from: "2026-01-01", to: "2026-02-28" };
// Differs from RANGE_A only in `from`.
const RANGE_C: DateRange = { from: "2025-12-01", to: "2026-01-31" };

describe("query key distinctness across factories", () => {
  it("gives each range-taking factory its own distinct queryKey for the same range", () => {
    const keys = [
      overviewQuery(RANGE_A).queryKey,
      seriesQuery(RANGE_A).queryKey,
      topItemsQuery(RANGE_A, {}).queryKey,
      userStatsQuery(RANGE_A).queryKey,
      userDetailQuery("user-1", RANGE_A).queryKey,
      libraryStatsQuery(RANGE_A).queryKey,
      historyQuery({}).queryKey,
    ];

    const serialized = keys.map((key) => JSON.stringify(key));
    expect(new Set(serialized).size).toBe(keys.length);
  });
});

describe("query key stability", () => {
  it("produces equal keys for identical inputs passed as distinct object instances", () => {
    // A fresh object literal each call — proves the key is built from the
    // *values*, not from object identity (which would never match twice and
    // would defeat caching entirely).
    const first = overviewQuery({ from: "2026-03-01", to: "2026-03-31" }).queryKey;
    const second = overviewQuery({ from: "2026-03-01", to: "2026-03-31" }).queryKey;
    expect(first).toEqual(second);
  });
});

describe("range changes refetch instead of reusing a stale key", () => {
  it.each([
    ["overviewQuery", overviewQuery],
    ["seriesQuery", seriesQuery],
    ["userStatsQuery", userStatsQuery],
    ["libraryStatsQuery", libraryStatsQuery],
  ] as const)("%s produces a different key when `to` changes", (_name, factory) => {
    expect(factory(RANGE_A).queryKey).not.toEqual(factory(RANGE_B).queryKey);
  });

  it.each([
    ["overviewQuery", overviewQuery],
    ["seriesQuery", seriesQuery],
    ["userStatsQuery", userStatsQuery],
    ["libraryStatsQuery", libraryStatsQuery],
  ] as const)("%s produces a different key when `from` changes", (_name, factory) => {
    expect(factory(RANGE_A).queryKey).not.toEqual(factory(RANGE_C).queryKey);
  });

  it("topItemsQuery's key changes when the range changes, with opts held fixed", () => {
    expect(topItemsQuery(RANGE_A, { limit: 10 }).queryKey).not.toEqual(
      topItemsQuery(RANGE_B, { limit: 10 }).queryKey,
    );
  });

  it("userDetailQuery's key changes when the range changes, with userId held fixed", () => {
    expect(userDetailQuery("user-1", RANGE_A).queryKey).not.toEqual(
      userDetailQuery("user-1", RANGE_B).queryKey,
    );
  });

  it("userDetailQuery's key changes when userId changes, with the range held fixed", () => {
    expect(userDetailQuery("user-1", RANGE_A).queryKey).not.toEqual(
      userDetailQuery("user-2", RANGE_A).queryKey,
    );
  });
});

describe("historyQuery includes its filters in the key", () => {
  it("changes when `from`/`to` change", () => {
    expect(historyQuery({}).queryKey).not.toEqual(historyQuery({ from: "2026-01-01", to: "2026-01-31" }).queryKey);
  });

  it("changes when `limit` changes, all else held fixed", () => {
    expect(historyQuery({ limit: 50 }).queryKey).not.toEqual(historyQuery({ limit: 100 }).queryKey);
  });

  it("changes when `offset` changes, all else held fixed", () => {
    expect(historyQuery({ offset: 0 }).queryKey).not.toEqual(historyQuery({ offset: 50 }).queryKey);
  });

  it("changes when `userId` changes, all else held fixed", () => {
    expect(historyQuery({ userId: "user-1" }).queryKey).not.toEqual(historyQuery({ userId: "user-2" }).queryKey);
  });

  it("changes when `libraryId` changes, all else held fixed", () => {
    expect(historyQuery({ libraryId: "library-1" }).queryKey).not.toEqual(
      historyQuery({ libraryId: "library-2" }).queryKey,
    );
  });

  it("gives identical filter sets equal keys regardless of property insertion order", () => {
    const first = historyQuery({ userId: "user-1", limit: 50, from: "2026-01-01" }).queryKey;
    const second = historyQuery({ from: "2026-01-01", limit: 50, userId: "user-1" }).queryKey;
    expect(first).toEqual(second);
  });
});
