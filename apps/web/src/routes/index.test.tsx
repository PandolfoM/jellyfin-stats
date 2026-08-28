// @vitest-environment jsdom
//
// Overview is the first route container: it owns four queries (overview,
// series, top-items, history) and the range state that feeds all of them.
// Every assertion here is anchored on the actual request URLs a stubbed
// `fetch` observed — never on a bare call count — because a mock that only
// counts calls cannot tell "four distinct endpoints fired" apart from "one
// endpoint fired four times", and cannot tell "the range picker's new value
// reached the query" apart from "the component merely re-rendered".
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../test/renderApp";
import { changeFromDate } from "../test/dateRangePicker";

afterEach(() => vi.restoreAllMocks());

const AUTHENTICATED_BODY = JSON.stringify({ userId: "user-1", userName: "admin", isAdmin: true });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchOverrides {
  overview?: () => Response;
  series?: () => Response;
  topItems?: () => Response;
  history?: () => Response;
}

/**
 * Stubs `fetch` for every endpoint the Overview route can call and records
 * every URL it was asked for, in call order — the raw material every
 * assertion below is built from. Throws for anything unexpected (a route
 * this test doesn't know about) instead of silently resolving, so a request
 * to the wrong endpoint fails loudly rather than passing by accident.
 */
function mockFetch(overrides: FetchOverrides = {}): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);

      if (url.includes("/api/auth/me")) return jsonResponse(JSON.parse(AUTHENTICATED_BODY));
      if (url.includes("/api/stats/overview")) {
        return (
          overrides.overview?.() ??
          jsonResponse({ plays: 10, watchMs: 600_000, activeUsers: 2, activeItems: 3 })
        );
      }
      if (url.includes("/api/stats/series")) return overrides.series?.() ?? jsonResponse([]);
      if (url.includes("/api/stats/top-items")) return overrides.topItems?.() ?? jsonResponse([]);
      if (url.includes("/api/history"))
        return overrides.history?.() ?? jsonResponse({ rows: [], total: 0 });

      throw new Error(`index.test.tsx did not expect a fetch to ${url}`);
    }),
  );
  return calls;
}

function renderOverview() {
  return renderApp("/");
}

/** URL query params for one recorded call, or `undefined` if nothing matched `pathIncludes`. */
function paramsFor(calls: string[], pathIncludes: string): URLSearchParams | undefined {
  const match = calls.filter((url) => url.includes(pathIncludes)).at(-1);
  return match !== undefined ? new URL(match, "http://localhost").searchParams : undefined;
}

function countCalls(calls: string[], pathIncludes: string): number {
  return calls.filter((url) => url.includes(pathIncludes)).length;
}

describe("Overview route", () => {
  it("fires exactly the four expected queries, each exactly once, sharing the same range", async () => {
    const calls = mockFetch();

    renderOverview();

    await screen.findByTestId("overview-route");
    await waitFor(() => expect(countCalls(calls, "/api/history")).toBeGreaterThanOrEqual(1));

    // Pinning each endpoint to exactly one call is what catches "the same
    // query fired four times" (e.g. all four `useQuery` calls accidentally
    // reusing `overviewQuery`) — a bare `expect(fetch).toHaveBeenCalledTimes(4)`
    // would pass identically in that broken case.
    expect(countCalls(calls, "/api/stats/overview")).toBe(1);
    expect(countCalls(calls, "/api/stats/series")).toBe(1);
    expect(countCalls(calls, "/api/stats/top-items")).toBe(1);
    expect(countCalls(calls, "/api/history")).toBe(1);

    const overviewParams = paramsFor(calls, "/api/stats/overview");
    const seriesParams = paramsFor(calls, "/api/stats/series");
    const topItemsParams = paramsFor(calls, "/api/stats/top-items");
    const historyParams = paramsFor(calls, "/api/history");

    expect(overviewParams?.get("from")).toBeTruthy();
    expect(overviewParams?.get("to")).toBeTruthy();

    // All four must carry the *same* range — a factory that dropped `range`
    // for one of the four (falling back to some other default) would still
    // pass the per-endpoint call-count checks above but fail here.
    expect(seriesParams?.get("from")).toBe(overviewParams?.get("from"));
    expect(seriesParams?.get("to")).toBe(overviewParams?.get("to"));
    expect(topItemsParams?.get("from")).toBe(overviewParams?.get("from"));
    expect(topItemsParams?.get("to")).toBe(overviewParams?.get("to"));
    expect(historyParams?.get("from")).toBe(overviewParams?.get("from"));
    expect(historyParams?.get("to")).toBe(overviewParams?.get("to"));
  });

  it("refetches all four queries with the new range when the date picker changes", async () => {
    const calls = mockFetch();

    renderOverview();
    await screen.findByTestId("overview-route");
    await waitFor(() => expect(countCalls(calls, "/api/history")).toBeGreaterThanOrEqual(1));

    const originalFrom = paramsFor(calls, "/api/stats/overview")?.get("from");
    const originalTo = paramsFor(calls, "/api/stats/overview")?.get("to");
    expect(originalFrom).toBeTruthy();
    expect(originalTo).toBeTruthy();

    // Shifted relative to whatever the picker's own initial value is (real
    // "today", not a value this test controls), so the assertion holds no
    // matter what day the suite runs on — and only `from` moves, `to` is
    // left alone, so this exercises DateRangePicker's real onChange path
    // instead of hand-constructing a range this test happens to expect.
    // Driven through the real picker, which is a calendar now: `changeFromDate`
    // opens it, clicks a selectable day, and reports back the date the
    // component actually committed. Which day it lands on does not matter here
    // — only that changing the range refetches with the new value.
    const shiftedFrom = changeFromDate();
    expect(shiftedFrom).not.toBe(originalFrom);

    await waitFor(() => expect(countCalls(calls, "/api/stats/overview")).toBeGreaterThanOrEqual(2));

    // Every one of the four must have actually refetched (not just one of
    // them, and not the same query key reused) — this is what catches a
    // range-state bug where only the picker's own display updates but the
    // queries keep whatever range they were constructed with on first render.
    expect(countCalls(calls, "/api/stats/series")).toBeGreaterThanOrEqual(2);
    expect(countCalls(calls, "/api/stats/top-items")).toBeGreaterThanOrEqual(2);
    expect(countCalls(calls, "/api/history")).toBeGreaterThanOrEqual(2);

    expect(paramsFor(calls, "/api/stats/overview")?.get("from")).toBe(shiftedFrom);
    expect(paramsFor(calls, "/api/stats/series")?.get("from")).toBe(shiftedFrom);
    expect(paramsFor(calls, "/api/stats/top-items")?.get("from")).toBe(shiftedFrom);
    expect(paramsFor(calls, "/api/history")?.get("from")).toBe(shiftedFrom);

    // Only `from` was edited — `to` must survive unchanged. An `onChange`
    // handler that rebuilt the range from a default instead of merging with
    // the picker's current value (e.g. `setRange(defaultRange())`) would
    // still move `from` somewhere and pass every assertion above, but would
    // clobber `to` with today's date in the process.
    expect(paramsFor(calls, "/api/stats/overview")?.get("to")).toBe(originalTo);
    expect(paramsFor(calls, "/api/stats/series")?.get("to")).toBe(originalTo);
    expect(paramsFor(calls, "/api/stats/top-items")?.get("to")).toBe(originalTo);
    expect(paramsFor(calls, "/api/history")?.get("to")).toBe(originalTo);
  });

  it("renders resolved data from all four queries", async () => {
    mockFetch({
      overview: () =>
        jsonResponse({ plays: 42, watchMs: 7_265_000, activeUsers: 3, activeItems: 12 }),
      series: () => jsonResponse([{ day: "2026-01-01", plays: 2, watchMs: 120_000 }]),
      topItems: () =>
        jsonResponse([
          {
            itemId: "item-1",
            name: "Example Movie One",
            type: "Movie",
            libraryId: "library-a",
            seriesId: null,
            imageTag: null,
            plays: 5,
            watchMs: 3_600_000,
          },
        ]),
      history: () =>
        jsonResponse({
          rows: [
            {
              id: "row-1",
              userId: "user-1",
              userName: "admin",
              itemId: "item-1",
              itemName: "Example Movie One",
              itemType: "Movie",
              seriesId: null,
              libraryId: "library-a",
              deviceName: null,
              client: null,
              playMethod: null,
              startedAt: "2026-01-01T12:00:00.000Z",
              endedAt: "2026-01-01T13:00:00.000Z",
              watchMs: 3_600_000,
              completed: true,
            },
          ],
          total: 1,
        }),
    });

    renderOverview();

    expect(await screen.findByText("42")).toBeInTheDocument(); // plays, from StatCardRow
    expect(await screen.findAllByText("Example Movie One")).toHaveLength(2); // top content + activity feed

    // Wait for every panel's loading skeleton to clear — not just the two
    // panels asserted on above — before checking `series`'s effect below.
    // Without this, a `series` query that was still mid-flight would also
    // show no "No watch time yet" text (WatchTimeChart renders a Skeleton
    // while loading, not the empty state), which would make that check pass
    // vacuously regardless of whether the series data ever arrived.
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0),
    );

    // `series` specifically: WatchTimeChart renders its EmptyState ("No
    // watch time yet") if and only if `points.length === 0`. The mocked
    // response above has one point, so this text's absence — now that
    // loading has definitely finished — is what proves the series response
    // actually reached the chart. A route that dropped the `series` query
    // and passed `[]` to `WatchTimeChart` would pass every assertion above
    // unchanged but show this text.
    expect(screen.queryByText("No watch time yet")).not.toBeInTheDocument();

    expect(screen.queryByTestId("overview-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("series-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("top-items-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("history-error")).not.toBeInTheDocument();
  });

  it("redirects to /login instead of rendering an error card when a query gets a 401", async () => {
    mockFetch({ overview: () => new Response("{}", { status: 401 }) });

    const router = renderOverview();
    await screen.findByTestId("overview-route");

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(screen.queryByTestId("overview-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overview-route")).not.toBeInTheDocument();
  });

  it("shows an error card and does NOT redirect when a query gets a 500", async () => {
    mockFetch({
      overview: () => new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    });

    const router = renderOverview();
    await screen.findByTestId("overview-route");

    expect(await screen.findByTestId("overview-error")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
  });

  it("shows only the failing panel's error, and still renders the other three panels' data", async () => {
    // Only `history` fails here; the other three get real, distinguishable
    // data — a route that blanked the whole dashboard on any single query
    // error (the pre-fix behavior) would fail this by never rendering "42"
    // or "Example Movie One" at all, not just by mislabeling the error.
    mockFetch({
      overview: () =>
        jsonResponse({ plays: 42, watchMs: 7_265_000, activeUsers: 3, activeItems: 12 }),
      series: () => jsonResponse([{ day: "2026-01-01", plays: 2, watchMs: 120_000 }]),
      topItems: () =>
        jsonResponse([
          {
            itemId: "item-1",
            name: "Example Movie One",
            type: "Movie",
            libraryId: "library-a",
            seriesId: null,
            imageTag: null,
            plays: 5,
            watchMs: 3_600_000,
          },
        ]),
      history: () => new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    });

    renderOverview();

    expect(await screen.findByTestId("history-error")).toBeInTheDocument();
    expect(await screen.findByText("42")).toBeInTheDocument(); // StatCardRow, from `overview`
    expect(await screen.findByText("Example Movie One")).toBeInTheDocument(); // TopContentList, from `topItems`

    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0),
    );
    expect(screen.queryByText("No watch time yet")).not.toBeInTheDocument(); // WatchTimeChart, from `series`

    // The three healthy panels must not show an error of their own.
    expect(screen.queryByTestId("overview-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("series-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("top-items-error")).not.toBeInTheDocument();
  });
});
