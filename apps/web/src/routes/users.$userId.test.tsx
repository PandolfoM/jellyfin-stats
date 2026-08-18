// @vitest-environment jsdom
//
// /users/$userId is a container route that reads a route param and fires
// three queries (userDetailQuery, topItemsQuery, historyQuery) scoped to
// that one user. Every navigation below goes through `renderApp` with a
// real path (`/users/<id>`), never a hand-picked id passed straight to the
// component — the brief's trap #3: a test that hardcodes the id proves
// nothing about the router's own `$userId` param parsing.
//
// The other trap this file guards against (the brief's #2): a 404 and a
// real user with zero activity in range must render *differently*. Both
// resolve to "nothing to show" in a naive read, but only one of them is
// actually the not-found screen.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../test/renderApp";

afterEach(() => vi.restoreAllMocks());

const AUTHENTICATED_BODY = JSON.stringify({ userId: "session-user", userName: "admin", isAdmin: true });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function userIdFromDetailUrl(url: string): string {
  const withoutQuery = url.split("?")[0] ?? url;
  return withoutQuery.split("/api/stats/users/")[1] ?? "";
}

interface FetchOverrides {
  detail?: (userId: string) => Response;
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
      if (url.includes("/api/stats/users/")) {
        return overrides.detail?.(userIdFromDetailUrl(url)) ?? jsonResponse({ error: "not_found" }, 404);
      }
      if (url.includes("/api/stats/top-items")) {
        const params = new URL(url, "http://localhost").searchParams;
        return overrides.topItems?.(params) ?? jsonResponse([]);
      }
      if (url.includes("/api/history")) {
        const params = new URL(url, "http://localhost").searchParams;
        return overrides.history?.(params) ?? jsonResponse({ rows: [], total: 0 });
      }

      throw new Error(`users.$userId.test.tsx did not expect a fetch to ${url}`);
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

describe("User detail route", () => {
  it("reads the userId from the real router param — navigating to a different id fetches a different user", async () => {
    const calls = mockFetch({
      detail: (userId) =>
        jsonResponse({
          userId,
          name: userId === "user-alpha-1" ? "Ada Lovelace" : "Someone else",
          isAdmin: false,
          plays: 10,
          watchMs: 600_000,
          devices: [],
        }),
    });

    renderApp("/users/user-alpha-1");

    await screen.findByTestId("user-detail-route");
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(paramsFor(calls, "/api/stats/users/user-alpha-1")).toBeDefined();
  });

  it("renders the not-found state for an id the API answers 404 for", async () => {
    mockFetch({ detail: () => jsonResponse({ error: "not_found" }, 404) });

    renderApp("/users/user-missing-1");

    expect(await screen.findByTestId("user-detail-not-found")).toBeInTheDocument();
    expect(screen.getByText("User not found")).toBeInTheDocument();
    expect(screen.queryByTestId("user-detail-route")).not.toBeInTheDocument();
  });

  // The critical negative case: a real user with zero plays/watch time must
  // resolve successfully (getUserDetail's LEFT JOIN guarantees a row) and
  // render the normal page with zeros — never the not-found screen. A route
  // that collapsed "no data" and "no such user" into the same check would
  // fail this while still passing the 404 test above.
  it("does NOT render the not-found state for a real user with zero activity in the range", async () => {
    mockFetch({
      detail: (userId) =>
        jsonResponse({ userId, name: "Grace Hopper", isAdmin: false, plays: 0, watchMs: 0, devices: [] }),
    });

    renderApp("/users/user-quiet-1");

    expect(await screen.findByTestId("user-detail-route")).toBeInTheDocument();
    expect(screen.queryByTestId("user-detail-not-found")).not.toBeInTheDocument();
    expect(await screen.findByText("Grace Hopper")).toBeInTheDocument();
  });

  // StatCardRow reused with only `plays`/`watchMs` — this user detail page
  // has no equivalent of "active users"/"active items", so those two tiles
  // must not appear at all (see StatCardRow.tsx's doc comment).
  it("shows Plays/Watch time but not Active users/Active items", async () => {
    mockFetch({
      detail: (userId) =>
        jsonResponse({ userId, name: "Ada Lovelace", isAdmin: false, plays: 7, watchMs: 90_000, devices: [] }),
    });

    renderApp("/users/user-alpha-1");

    await screen.findByTestId("user-detail-route");
    expect(await screen.findByText("Plays")).toBeInTheDocument();
    expect(screen.getByText("Watch time")).toBeInTheDocument();
    expect(screen.queryByText("Active users")).not.toBeInTheDocument();
    expect(screen.queryByText("Active items")).not.toBeInTheDocument();
  });

  it("renders the device breakdown from userDetail's devices list", async () => {
    mockFetch({
      detail: (userId) =>
        jsonResponse({
          userId,
          name: "Ada Lovelace",
          isAdmin: false,
          plays: 7,
          watchMs: 90_000,
          devices: [{ deviceId: "device-1", name: "Living Room TV", plays: 7 }],
        }),
    });

    renderApp("/users/user-alpha-1");

    expect(await screen.findByText("Living Room TV")).toBeInTheDocument();
    expect(screen.getByText("7 plays")).toBeInTheDocument();
  });

  it("filters top-items to this user via topItemsQuery's userId option", async () => {
    const calls = mockFetch({
      detail: (userId) =>
        jsonResponse({ userId, name: "Ada Lovelace", isAdmin: false, plays: 7, watchMs: 90_000, devices: [] }),
    });

    renderApp("/users/user-alpha-1");

    await waitFor(() => expect(countCalls(calls, "/api/stats/top-items")).toBeGreaterThanOrEqual(1));
    expect(paramsFor(calls, "/api/stats/top-items")?.get("userId")).toBe("user-alpha-1");
  });

  it("filters playback history to this user, with page 1's limit/offset", async () => {
    const calls = mockFetch({
      detail: (userId) =>
        jsonResponse({ userId, name: "Ada Lovelace", isAdmin: false, plays: 7, watchMs: 90_000, devices: [] }),
    });

    renderApp("/users/user-alpha-1");

    await waitFor(() => expect(countCalls(calls, "/api/history")).toBeGreaterThanOrEqual(1));
    const params = paramsFor(calls, "/api/history");
    expect(params?.get("userId")).toBe("user-alpha-1");
    expect(params?.get("offset")).toBe("0");
  });

  it("clicking Next on the playback history table requests the next page's offset", async () => {
    const calls = mockFetch({
      detail: (userId) =>
        jsonResponse({ userId, name: "Ada Lovelace", isAdmin: false, plays: 7, watchMs: 90_000, devices: [] }),
      history: (params) => {
        const offset = Number(params.get("offset") ?? 0);
        const rows = Array.from({ length: Math.min(25, 40 - offset) }, (_, i) => ({
          id: `row-${offset + i}`,
          userId: "user-alpha-1",
          userName: "Ada Lovelace",
          itemId: `item-${offset + i}`,
          itemName: `Example Movie ${offset + i}`,
          itemType: "Movie",
          seriesId: null,
          libraryId: "library-example",
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

    renderApp("/users/user-alpha-1");
    await waitFor(() => expect(paramsFor(calls, "/api/history")?.get("offset")).toBe("0"));

    fireEvent.click(await screen.findByRole("button", { name: "Next" }));

    await waitFor(() => expect(paramsFor(calls, "/api/history")?.get("offset")).toBe("25"));
  });

  // Per-panel error handling, same convention as routes/index.tsx: a
  // failing top-items query must not blank the stats or history panels that
  // loaded fine.
  it("shows only the failing panel's error when top-items 500s, and still renders the rest", async () => {
    mockFetch({
      detail: (userId) =>
        jsonResponse({ userId, name: "Ada Lovelace", isAdmin: false, plays: 7, watchMs: 90_000, devices: [] }),
      topItems: () => new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    });

    renderApp("/users/user-alpha-1");

    expect(await screen.findByTestId("user-top-items-error")).toBeInTheDocument();
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(await screen.findByText("Plays")).toBeInTheDocument();
    expect(screen.queryByTestId("user-detail-error")).not.toBeInTheDocument();
  });

  it("redirects to /login instead of rendering an error card on a 401", async () => {
    mockFetch({ detail: () => new Response("{}", { status: 401 }) });

    const router = renderApp("/users/user-alpha-1");

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(screen.queryByTestId("user-detail-not-found")).not.toBeInTheDocument();
  });
});
