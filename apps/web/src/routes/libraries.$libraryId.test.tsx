// @vitest-environment jsdom
//
// /libraries/$libraryId reads a route param, same as /users/$userId, but
// with one real difference confirmed against the server before writing
// this (see this task's report): there is no `/api/stats/libraries/:id`
// endpoint, so this route finds its one library inside the full
// `libraryStatsQuery` roster instead. "Not found" here means "absent from
// that roster", not a dedicated 404 — this file tests that distinction
// directly: a real zero-activity library (present in the roster with
// zeroed stats) must not be confused with a libraryId that isn't in the
// roster at all.
//
// Every navigation below goes through `renderApp` with a real path, never
// a hand-picked id passed straight to the component (brief's trap #3).
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../test/renderApp";

afterEach(() => vi.restoreAllMocks());

const AUTHENTICATED_BODY = JSON.stringify({
  userId: "session-user",
  userName: "admin",
  isAdmin: true,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ROSTER = [
  {
    libraryId: "library-alpha-1",
    name: "Movies",
    collectionType: "movies",
    plays: 42,
    watchMs: 7_265_000,
  },
  { libraryId: "library-quiet-1", name: "Home Videos", collectionType: null, plays: 0, watchMs: 0 },
];

interface FetchOverrides {
  libraries?: () => Response;
  topItems?: (params: URLSearchParams) => Response;
  history?: (params: URLSearchParams) => Response;
}

function mockFetch(overrides: FetchOverrides = {}): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);

      if (url.includes("/api/auth/me")) return jsonResponse(JSON.parse(AUTHENTICATED_BODY));
      if (url.includes("/api/stats/libraries"))
        return overrides.libraries?.() ?? jsonResponse(ROSTER);
      if (url.includes("/api/stats/top-items")) {
        const params = new URL(url, "http://localhost").searchParams;
        return overrides.topItems?.(params) ?? jsonResponse([]);
      }
      if (url.includes("/api/history")) {
        const params = new URL(url, "http://localhost").searchParams;
        return overrides.history?.(params) ?? jsonResponse({ rows: [], total: 0 });
      }

      throw new Error(`libraries.$libraryId.test.tsx did not expect a fetch to ${url}`);
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

describe("Library detail route", () => {
  // A single test, two sequential navigations (with an explicit `cleanup()`
  // between them, since `renderApp` mounts a fresh tree each call and this
  // repo's global `afterEach(cleanup)` only runs between `it` blocks, not
  // within one). This is deliberately one test rather than two separately-
  // worded ones: a route that hardcoded (or defaulted to) the roster's
  // first entry would pass the first assertion below and then fail the
  // second, where a different id must resolve to a different library. Two
  // independent tests — one per id — would not catch that regression,
  // since each would only ever exercise its own single id in isolation.
  // This also doubles as the not-found/zero-activity distinction: the
  // second navigation's target is a *real*, zero-activity library, and
  // asserting the not-found testid is absent there is what proves "not
  // found" means "absent from the roster" rather than "nothing to show".
  it("reads the libraryId from the real router param — a hardcoded id would pass one navigation but fail the other", async () => {
    mockFetch();
    renderApp("/libraries/library-alpha-1");
    expect(await screen.findByTestId("library-detail-route")).toBeInTheDocument();
    expect(await screen.findByText("Movies")).toBeInTheDocument();

    cleanup();
    renderApp("/libraries/library-quiet-1");
    expect(await screen.findByTestId("library-detail-route")).toBeInTheDocument();
    expect(screen.queryByTestId("library-detail-not-found")).not.toBeInTheDocument();
    expect(await screen.findByText("Home Videos")).toBeInTheDocument();
  });

  it("renders the not-found state for a libraryId absent from the roster", async () => {
    mockFetch();

    renderApp("/libraries/library-does-not-exist");

    expect(await screen.findByTestId("library-detail-not-found")).toBeInTheDocument();
    expect(screen.getByText("Library not found")).toBeInTheDocument();
    expect(screen.queryByTestId("library-detail-route")).not.toBeInTheDocument();
  });

  it("shows Plays/Watch time but not Active users/Active items", async () => {
    mockFetch();

    renderApp("/libraries/library-alpha-1");

    expect(await screen.findByText("Plays")).toBeInTheDocument();
    expect(screen.getByText("Watch time")).toBeInTheDocument();
    expect(screen.queryByText("Active users")).not.toBeInTheDocument();
    expect(screen.queryByText("Active items")).not.toBeInTheDocument();
  });

  it("filters top-items to this library via topItemsQuery's libraryId option", async () => {
    const calls = mockFetch();

    renderApp("/libraries/library-alpha-1");

    await waitFor(() =>
      expect(countCalls(calls, "/api/stats/top-items")).toBeGreaterThanOrEqual(1),
    );
    expect(paramsFor(calls, "/api/stats/top-items")?.get("libraryId")).toBe("library-alpha-1");
  });

  it("filters playback history to this library, with page 1's limit/offset", async () => {
    const calls = mockFetch();

    renderApp("/libraries/library-alpha-1");

    await waitFor(() => expect(countCalls(calls, "/api/history")).toBeGreaterThanOrEqual(1));
    const params = paramsFor(calls, "/api/history");
    expect(params?.get("libraryId")).toBe("library-alpha-1");
    expect(params?.get("offset")).toBe("0");
  });

  it("clicking Next on the playback history table requests the next page's offset", async () => {
    const calls = mockFetch({
      history: (params) => {
        const offset = Number(params.get("offset") ?? 0);
        const rows = Array.from({ length: Math.min(25, 40 - offset) }, (_, i) => ({
          id: `row-${offset + i}`,
          userId: "user-1",
          userName: "admin",
          itemId: `item-${offset + i}`,
          itemName: `Example Movie ${offset + i}`,
          itemType: "Movie",
          seriesId: null,
          libraryId: "library-alpha-1",
          deviceName: null,
          client: null,
          playMethod: null,
          startedAt: "2026-01-01T12:00:00.000Z",
          endedAt: "2026-01-01T13:00:00.000Z",
          watchMs: 1_800_000,
          completed: true,
        }));
        return jsonResponse({ rows, total: 40 });
      },
    });

    renderApp("/libraries/library-alpha-1");
    await waitFor(() => expect(paramsFor(calls, "/api/history")?.get("offset")).toBe("0"));

    fireEvent.click(await screen.findByRole("button", { name: "Next" }));

    await waitFor(() => expect(paramsFor(calls, "/api/history")?.get("offset")).toBe("25"));
  });

  it("shows only the failing panel's error when top-items 500s, and still renders the rest", async () => {
    mockFetch({
      topItems: () => new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    });

    renderApp("/libraries/library-alpha-1");

    expect(await screen.findByTestId("library-top-items-error")).toBeInTheDocument();
    expect(await screen.findByText("Movies")).toBeInTheDocument();
    expect(await screen.findByText("Plays")).toBeInTheDocument();
    expect(screen.queryByTestId("library-detail-error")).not.toBeInTheDocument();
  });

  it("redirects to /login instead of rendering an error card on a 401", async () => {
    mockFetch({ libraries: () => new Response("{}", { status: 401 }) });

    const router = renderApp("/libraries/library-alpha-1");

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(screen.queryByTestId("library-detail-not-found")).not.toBeInTheDocument();
  });
});
