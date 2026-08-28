// @vitest-environment jsdom
//
// /libraries mirrors /users exactly (routes/users.test.tsx): one
// range-scoped query, handed straight to `LibraryStatsTable`. Same trap
// guarded against — a fixture with only active libraries would let an
// over-aggressive filter pass unnoticed — so a real zero-activity library
// is always in the fixture below.
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

const ACTIVE_LIBRARY = {
  libraryId: "library-active-1",
  name: "Movies",
  collectionType: "movies",
  plays: 108,
  watchMs: 36_000_000,
};
const ZERO_ACTIVITY_LIBRARY = {
  libraryId: "library-quiet-1",
  name: "Home Videos",
  collectionType: null,
  plays: 0,
  watchMs: 0,
};

interface FetchOverrides {
  libraries?: () => Response;
}

function mockFetch(overrides: FetchOverrides = {}): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);

      if (url.includes("/api/auth/me")) return jsonResponse(JSON.parse(AUTHENTICATED_BODY));
      if (url.includes("/api/stats/libraries")) {
        return overrides.libraries?.() ?? jsonResponse([ACTIVE_LIBRARY, ZERO_ACTIVITY_LIBRARY]);
      }

      throw new Error(`libraries.test.tsx did not expect a fetch to ${url}`);
    }),
  );
  return calls;
}

function paramsFor(calls: string[], pathIncludes: string): URLSearchParams | undefined {
  const match = calls.filter((url) => url.includes(pathIncludes)).at(-1);
  return match !== undefined ? new URL(match, "http://localhost").searchParams : undefined;
}

function countCalls(calls: string[], pathIncludes: string): number {
  return calls.filter((url) => url.includes(pathIncludes)).length;
}

describe("Libraries route", () => {
  it("fires /api/stats/libraries with the default range", async () => {
    const calls = mockFetch();

    renderApp("/libraries");

    await screen.findByTestId("libraries-route");
    await waitFor(() =>
      expect(countCalls(calls, "/api/stats/libraries")).toBeGreaterThanOrEqual(1),
    );

    const params = paramsFor(calls, "/api/stats/libraries");
    expect(params?.get("from")).toBeTruthy();
    expect(params?.get("to")).toBeTruthy();
  });

  it("refetches with the new range when the date picker changes", async () => {
    const calls = mockFetch();

    renderApp("/libraries");
    await screen.findByTestId("libraries-route");
    await waitFor(() =>
      expect(countCalls(calls, "/api/stats/libraries")).toBeGreaterThanOrEqual(1),
    );

    const originalFrom = paramsFor(calls, "/api/stats/libraries")?.get("from");
    // Driven through the real picker, which is a calendar now: `changeFromDate`
    // opens it, clicks a selectable day, and reports back the date the
    // component actually committed. Which day it lands on does not matter here
    // — only that changing the range refetches with the new value.
    const shiftedFrom = changeFromDate();
    expect(shiftedFrom).not.toBe(originalFrom);

    await waitFor(() =>
      expect(paramsFor(calls, "/api/stats/libraries")?.get("from")).toBe(shiftedFrom),
    );
  });

  it("renders a zero-activity library's row alongside an active library's row — the roster is not filtered", async () => {
    mockFetch();

    renderApp("/libraries");

    const rows = await screen.findAllByTestId("library-stats-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Movies")).toBeInTheDocument();
    expect(screen.getByText("Home Videos")).toBeInTheDocument();
  });

  it("navigates to the library's detail route when its row is clicked", async () => {
    mockFetch();

    const router = renderApp("/libraries");

    const link = await screen.findByRole("link", { name: "Movies" });
    fireEvent.click(link);

    await waitFor(() => expect(router.state.location.pathname).toBe("/libraries/library-active-1"));
  });

  it("shows the panel error on a 500 and does not redirect", async () => {
    mockFetch({
      libraries: () => new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    });

    const router = renderApp("/libraries");
    await screen.findByTestId("libraries-route");

    expect(await screen.findByTestId("libraries-error")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/libraries");
  });

  it("redirects to /login instead of rendering an error card on a 401", async () => {
    mockFetch({ libraries: () => new Response("{}", { status: 401 }) });

    const router = renderApp("/libraries");
    await screen.findByTestId("libraries-route");

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(screen.queryByTestId("libraries-error")).not.toBeInTheDocument();
  });
});
