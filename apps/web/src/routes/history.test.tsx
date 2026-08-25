// @vitest-environment jsdom
//
// History is a container route: it owns the range, the userId/libraryId
// filters, and the current page, and threads all of them into a single
// `historyQuery`. Every assertion here is anchored on the actual request
// URLs a stubbed `fetch` observed — the same convention `routes/index.test.tsx`
// uses — because the two defects this task's brief calls out both hide
// behind a mock that only counts calls or only checks rendered text:
//
//   - A filter (userId/libraryId) silently dropped from the request would
//     still fire a request; only reading the query string catches it.
//   - Paging via Next/Previous has to change `offset` in the request, not
//     just the page number shown on screen.
//
// The user/library filters are name-backed `<Select>`s (Task 10), fed by
// `userStatsQuery`/`libraryStatsQuery` — so every test below also has to
// answer `/api/stats/users` and `/api/stats/libraries`, and the two
// "threads the filter" tests select a real fixture user/library by name
// rather than typing an arbitrary id (there is no longer a text field to
// type into).
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../test/renderApp";

afterEach(() => vi.restoreAllMocks());

const AUTHENTICATED_BODY = JSON.stringify({ userId: "user-1", userName: "admin", isAdmin: true });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface HistoryRowFixture {
  id: string;
  itemName: string;
  userName: string;
}

function makeHistoryRow({ id, itemName, userName }: HistoryRowFixture) {
  return {
    id,
    userId: "user-1",
    userName,
    itemId: `item-${id}`,
    itemName,
    itemType: "Movie",
    seriesId: null,
    libraryId: "library-example",
    deviceName: "Example TV",
    client: "Jellyfin Web",
    playMethod: "DirectPlay",
    startedAt: "2026-01-01T12:00:00.000Z",
    endedAt: "2026-01-01T13:00:00.000Z",
    watchMs: 3_600_000,
    completed: true,
  };
}

const FIXTURE_USERS = [
  { userId: "user-fixture-1", name: "Ada Lovelace", isAdmin: false, plays: 5, watchMs: 300_000 },
];
const FIXTURE_LIBRARIES = [
  {
    libraryId: "library-fixture-1",
    name: "Movies",
    collectionType: "movies",
    plays: 5,
    watchMs: 300_000,
  },
];

interface FetchOverrides {
  history?: (params: URLSearchParams) => Response;
  users?: () => Response;
  libraries?: () => Response;
}

/**
 * Stubs `fetch` for every endpoint the History route can call, and records
 * every URL requested in call order. Throws on anything unexpected, so a
 * request to the wrong endpoint fails loudly instead of quietly resolving —
 * the same convention `routes/index.test.tsx` uses.
 */
function mockFetch(overrides: FetchOverrides = {}): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);

      if (url.includes("/api/auth/me")) return jsonResponse(JSON.parse(AUTHENTICATED_BODY));
      if (url.includes("/api/history")) {
        const params = new URL(url, "http://localhost").searchParams;
        return overrides.history?.(params) ?? jsonResponse({ rows: [], total: 0 });
      }
      if (url.includes("/api/stats/users"))
        return overrides.users?.() ?? jsonResponse(FIXTURE_USERS);
      if (url.includes("/api/stats/libraries"))
        return overrides.libraries?.() ?? jsonResponse(FIXTURE_LIBRARIES);

      throw new Error(`history.test.tsx did not expect a fetch to ${url}`);
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

describe("History route", () => {
  it("fires /api/history with the default range and page 1's limit/offset", async () => {
    const calls = mockFetch({
      history: () =>
        jsonResponse({
          rows: [makeHistoryRow({ id: "row-1", itemName: "Example Movie", userName: "admin" })],
          total: 1,
        }),
    });

    renderApp("/history");

    await screen.findByTestId("history-route");
    await waitFor(() => expect(countCalls(calls, "/api/history")).toBeGreaterThanOrEqual(1));

    const params = paramsFor(calls, "/api/history");
    expect(params?.get("from")).toBeTruthy();
    expect(params?.get("to")).toBeTruthy();
    expect(params?.get("limit")).toBe("50");
    expect(params?.get("offset")).toBe("0");
    // Untouched filters must not appear in the request at all.
    expect(params?.has("userId")).toBe(false);
    expect(params?.has("libraryId")).toBe(false);

    expect(await screen.findByText("Example Movie")).toBeInTheDocument();
  });

  it("lists every fixture user by name in the User select, with 'All users' as the default", async () => {
    mockFetch();

    renderApp("/history");

    const select = (await screen.findByLabelText("User")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "Ada Lovelace" });

    const optionLabels = Array.from(select.options).map((option) => option.text);
    expect(optionLabels).toEqual(["All users", "Ada Lovelace"]);
    expect(select.value).toBe("");
  });

  it("threads the userId filter into the request — not dropped, and not stuck on some other query key", async () => {
    const calls = mockFetch();

    renderApp("/history");
    await screen.findByTestId("history-route");
    await waitFor(() => expect(countCalls(calls, "/api/history")).toBeGreaterThanOrEqual(1));

    const select = await screen.findByLabelText("User");
    // Wait for the real fixture option to actually be in the DOM before
    // selecting it — otherwise `fireEvent.change` below would set a value
    // with no matching `<option>` yet, which jsdom (like a real browser)
    // silently ignores rather than erroring on.
    await screen.findByRole("option", { name: "Ada Lovelace" });
    // A real fixture user's name, not a hand-typed GUID — proves the select
    // is actually backed by `userStatsQuery`'s data, not a stand-in text
    // field the test happens to accept any string into.
    fireEvent.change(select, { target: { value: "user-fixture-1" } });

    await waitFor(() =>
      expect(paramsFor(calls, "/api/history")?.get("userId")).toBe("user-fixture-1"),
    );
  });

  it("threads the libraryId filter into the request independently of userId", async () => {
    const calls = mockFetch();

    renderApp("/history");
    await screen.findByTestId("history-route");
    await waitFor(() => expect(countCalls(calls, "/api/history")).toBeGreaterThanOrEqual(1));

    const select = await screen.findByLabelText("Library");
    await screen.findByRole("option", { name: "Movies" });
    fireEvent.change(select, { target: { value: "library-fixture-1" } });

    await waitFor(() =>
      expect(paramsFor(calls, "/api/history")?.get("libraryId")).toBe("library-fixture-1"),
    );
    // userId must still be absent — proves the two filters are independent
    // fields, not one shared piece of state that clobbers the other.
    expect(paramsFor(calls, "/api/history")?.has("userId")).toBe(false);
  });

  it("clicking Next requests the next page's offset, and resets to offset 0 when the range changes", async () => {
    const calls = mockFetch({
      history: (params) => {
        const offset = Number(params.get("offset") ?? 0);
        // 125 total rows, page size 50 — enough for Next to be enabled on
        // page 1 and to prove the real offset math, not just that *a*
        // second request happened.
        const rows = Array.from({ length: Math.min(50, 125 - offset) }, (_, i) =>
          makeHistoryRow({
            id: `row-${offset + i}`,
            itemName: `Example Movie ${offset + i}`,
            userName: "admin",
          }),
        );
        return jsonResponse({ rows, total: 125 });
      },
    });

    renderApp("/history");
    await screen.findByTestId("history-route");
    await waitFor(() => expect(paramsFor(calls, "/api/history")?.get("offset")).toBe("0"));

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(countCalls(calls, "/api/history")).toBeGreaterThanOrEqual(2));
    expect(paramsFor(calls, "/api/history")?.get("offset")).toBe("50");

    // Changing the range while on page 2 must reset back to offset 0 — a
    // route that forgot to reset `page` on a filter/range change would ask
    // for offset 50 against the new, possibly much smaller filtered set,
    // which can render an empty page even though matching rows exist.
    const fromInput = screen.getByLabelText("From");
    const currentFrom = (fromInput as HTMLInputElement).value;
    const shiftedFrom = new Date(Date.parse(`${currentFrom}T00:00:00.000Z`) - 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    fireEvent.change(fromInput, { target: { value: shiftedFrom } });

    await waitFor(() => expect(paramsFor(calls, "/api/history")?.get("from")).toBe(shiftedFrom));
    expect(paramsFor(calls, "/api/history")?.get("offset")).toBe("0");
  });

  it("renders the 'showing X–Y of total' line from the real response, not a hardcoded number", async () => {
    mockFetch({
      history: () =>
        jsonResponse({
          rows: [makeHistoryRow({ id: "row-1", itemName: "Example Movie", userName: "admin" })],
          total: 812,
        }),
    });

    renderApp("/history");

    expect(await screen.findByTestId("playback-history-summary")).toHaveTextContent(
      "Showing 1–50 of 812",
    );
  });

  it("renders a row with placeholder item/user names plainly, without an error state", async () => {
    mockFetch({
      history: () =>
        jsonResponse({
          rows: [
            makeHistoryRow({ id: "row-1", itemName: "Unknown item", userName: "Unknown user" }),
          ],
          total: 1,
        }),
    });

    renderApp("/history");

    expect(await screen.findByText("Unknown item")).toBeInTheDocument();
    expect(await screen.findByText("Unknown user")).toBeInTheDocument();
    expect(screen.queryByTestId("history-error")).not.toBeInTheDocument();
  });

  it("shows the panel error and does not blank the filters when the query gets a 500", async () => {
    mockFetch({
      history: () => new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    });

    const router = renderApp("/history");
    await screen.findByTestId("history-route");

    expect(await screen.findByTestId("history-error")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/history");
    // The filter selects and date picker are route chrome, not part of the
    // failed query's own render — a 500 on `history` must not take them
    // down with it.
    expect(screen.getByLabelText("User")).toBeInTheDocument();
    expect(screen.getByLabelText("Library")).toBeInTheDocument();
  });

  it("redirects to /login instead of rendering an error card on a 401", async () => {
    mockFetch({ history: () => new Response("{}", { status: 401 }) });

    const router = renderApp("/history");
    await screen.findByTestId("history-route");

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(screen.queryByTestId("history-error")).not.toBeInTheDocument();
  });
});
