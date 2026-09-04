import { describe, expect, it, vi } from "vitest";
import type { DateRange } from "../lib/range";
import {
  historyQuery,
  itemDetailQuery,
  triggerSync,
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

describe("topItemsQuery includes its filters in the key", () => {
  // The range-varies-opts-fixed direction is already covered above ("range
  // changes refetch..."); these cover the complementary direction — opts
  // varying with the range held fixed — which nothing above exercised. A
  // `queryKeys.topItems` that dropped `opts` entirely (keying only on
  // `range`) would still pass every other test in this file.
  it("changes when `limit` changes, with the range held fixed", () => {
    expect(topItemsQuery(RANGE_A, { limit: 10 }).queryKey).not.toEqual(
      topItemsQuery(RANGE_A, { limit: 25 }).queryKey,
    );
  });

  it("changes when `libraryId` changes, with the range held fixed", () => {
    expect(topItemsQuery(RANGE_A, { libraryId: "library-1" }).queryKey).not.toEqual(
      topItemsQuery(RANGE_A, { libraryId: "library-2" }).queryKey,
    );
  });

  it("changes when `userId` changes, with the range held fixed", () => {
    expect(topItemsQuery(RANGE_A, { userId: "user-1" }).queryKey).not.toEqual(
      topItemsQuery(RANGE_A, { userId: "user-2" }).queryKey,
    );
  });
});

describe("historyQuery includes its filters in the key", () => {
  it("changes when `from`/`to` change", () => {
    expect(historyQuery({}).queryKey).not.toEqual(
      historyQuery({ from: "2026-01-01", to: "2026-01-31" }).queryKey,
    );
  });

  it("changes when `limit` changes, all else held fixed", () => {
    expect(historyQuery({ limit: 50 }).queryKey).not.toEqual(historyQuery({ limit: 100 }).queryKey);
  });

  it("changes when `offset` changes, all else held fixed", () => {
    expect(historyQuery({ offset: 0 }).queryKey).not.toEqual(historyQuery({ offset: 50 }).queryKey);
  });

  it("changes when `userId` changes, all else held fixed", () => {
    expect(historyQuery({ userId: "user-1" }).queryKey).not.toEqual(
      historyQuery({ userId: "user-2" }).queryKey,
    );
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

/**
 * Type-only guards, checked by `tsc --build` (`pnpm typecheck`) and never
 * executed by vitest — the same mechanism apps/web/src/api/client.test.ts
 * uses for its four RPC-chain guards.
 *
 * `queries.ts` pins every `InferResponseType<..., 200>` call to the route's
 * success status specifically. Without that pin, `InferResponseType`
 * defaults to a union across *all* the statuses the handler can return —
 * including each route's `{ error: string }` 400 (or, for userDetailQuery,
 * 404) body — and a union that includes `{ error: string }` does not have
 * the field accessed below on it, so that access stops typechecking. Each
 * type here is derived from the real exported factory (via its actual
 * `queryFn`'s resolved type), not re-declared independently, so a guard
 * breaks for real if the pin is ever dropped from queries.ts rather than
 * only from a parallel copy here. One guard per factory — a guard that
 * covers only one of the seven pinned types would leave the other six free
 * to regress silently, which is exactly what a single `overviewQuery`-only
 * guard did in an earlier pass of this file.
 */
type OverviewQueryData = Awaited<
  ReturnType<NonNullable<ReturnType<typeof overviewQuery>["queryFn"]>>
>;
type _OverviewFieldAccessTypechecks = OverviewQueryData["plays"];

type SeriesQueryData = Awaited<ReturnType<NonNullable<ReturnType<typeof seriesQuery>["queryFn"]>>>;
type _SeriesFieldAccessTypechecks = SeriesQueryData[number]["watchMs"];

type TopItemsQueryData = Awaited<
  ReturnType<NonNullable<ReturnType<typeof topItemsQuery>["queryFn"]>>
>;
type _TopItemsFieldAccessTypechecks = TopItemsQueryData[number]["itemId"];

type UserStatsQueryData = Awaited<
  ReturnType<NonNullable<ReturnType<typeof userStatsQuery>["queryFn"]>>
>;
type _UserStatsFieldAccessTypechecks = UserStatsQueryData[number]["userId"];

type UserDetailQueryData = Awaited<
  ReturnType<NonNullable<ReturnType<typeof userDetailQuery>["queryFn"]>>
>;
// `devices` exists only on UserDetail (not on UserStat, its base interface),
// so this also proves the guard resolved the right one of the two shapes.
type _UserDetailFieldAccessTypechecks = UserDetailQueryData["devices"];

type LibraryStatsQueryData = Awaited<
  ReturnType<NonNullable<ReturnType<typeof libraryStatsQuery>["queryFn"]>>
>;
type _LibraryStatsFieldAccessTypechecks = LibraryStatsQueryData[number]["libraryId"];

type HistoryQueryData = Awaited<
  ReturnType<NonNullable<ReturnType<typeof historyQuery>["queryFn"]>>
>;
type _HistoryFieldAccessTypechecks = HistoryQueryData["total"];

describe("itemDetailQuery", () => {
  it("has a key distinct from every other factory for the same range", () => {
    const others = [
      overviewQuery(RANGE_A).queryKey,
      topItemsQuery(RANGE_A, {}).queryKey,
      userDetailQuery("item-1", RANGE_A).queryKey,
      historyQuery({ itemId: "item-1" }).queryKey,
    ].map((key) => JSON.stringify(key));

    expect(others).not.toContain(JSON.stringify(itemDetailQuery("item-1", RANGE_A).queryKey));
  });

  it("changes its key when the range changes, with itemId held fixed", () => {
    expect(itemDetailQuery("item-1", RANGE_A).queryKey).not.toEqual(
      itemDetailQuery("item-1", RANGE_B).queryKey,
    );
  });

  it("changes its key when itemId changes, with the range held fixed", () => {
    expect(itemDetailQuery("item-1", RANGE_A).queryKey).not.toEqual(
      itemDetailQuery("item-2", RANGE_A).queryKey,
    );
  });
});

describe("historyQuery itemId filter", () => {
  it("changes the key when `itemId` changes, all else held fixed", () => {
    expect(historyQuery({ itemId: "item-1" }).queryKey).not.toEqual(
      historyQuery({ itemId: "item-2" }).queryKey,
    );
  });

  it("sends itemId as a query parameter", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ rows: [], total: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await historyQuery({ itemId: "item-1" }).queryFn!({} as never);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(new URL(url, "http://localhost").searchParams.get("itemId")).toBe("item-1");
  });
});

describe("triggerSync", () => {
  it("POSTs to the sync-now endpoint and resolves with whether a sync started", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ started: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(triggerSync()).resolves.toEqual({ started: true });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/api/settings/sync-now");
    expect(init?.method).toBe("POST");
  });
});
