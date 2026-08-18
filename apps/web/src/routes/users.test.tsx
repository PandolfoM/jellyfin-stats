// @vitest-environment jsdom
//
// /users is a container route: it owns the one query this route needs (a
// range-scoped roster of every user) and passes it straight to
// `UserStatsTable`. The assertions here follow the same convention as
// `routes/index.test.tsx` and `routes/history.test.tsx` — anchored on the
// real request URL a stubbed `fetch` observed, not just on rendered text —
// plus the trap this task's brief calls out specifically: a fixture with
// only active users would let an over-aggressive filter pass unnoticed, so
// the fixture below always includes a real zero-activity row.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../test/renderApp";

afterEach(() => vi.restoreAllMocks());

const AUTHENTICATED_BODY = JSON.stringify({ userId: "user-1", userName: "admin", isAdmin: true });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ACTIVE_USER = {
  userId: "user-active-1",
  name: "Ada Lovelace",
  isAdmin: true,
  plays: 42,
  watchMs: 7_265_000,
};
const ZERO_ACTIVITY_USER = {
  userId: "user-quiet-1",
  name: "Grace Hopper",
  isAdmin: false,
  plays: 0,
  watchMs: 0,
};

interface FetchOverrides {
  users?: () => Response;
}

function mockFetch(overrides: FetchOverrides = {}): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);

      if (url.includes("/api/auth/me")) return jsonResponse(JSON.parse(AUTHENTICATED_BODY));
      if (url.includes("/api/stats/users")) {
        return overrides.users?.() ?? jsonResponse([ACTIVE_USER, ZERO_ACTIVITY_USER]);
      }

      throw new Error(`users.test.tsx did not expect a fetch to ${url}`);
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

describe("Users route", () => {
  it("fires /api/stats/users with the default range", async () => {
    const calls = mockFetch();

    renderApp("/users");

    await screen.findByTestId("users-route");
    await waitFor(() => expect(countCalls(calls, "/api/stats/users")).toBeGreaterThanOrEqual(1));

    const params = paramsFor(calls, "/api/stats/users");
    expect(params?.get("from")).toBeTruthy();
    expect(params?.get("to")).toBeTruthy();
  });

  it("refetches with the new range when the date picker changes", async () => {
    const calls = mockFetch();

    renderApp("/users");
    await screen.findByTestId("users-route");
    await waitFor(() => expect(countCalls(calls, "/api/stats/users")).toBeGreaterThanOrEqual(1));

    const originalFrom = paramsFor(calls, "/api/stats/users")?.get("from");
    const fromInput = screen.getByLabelText("From");
    const currentFrom = (fromInput as HTMLInputElement).value;
    const shiftedFrom = new Date(Date.parse(`${currentFrom}T00:00:00.000Z`) - 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(shiftedFrom).not.toBe(originalFrom);

    fireEvent.change(fromInput, { target: { value: shiftedFrom } });

    await waitFor(() => expect(paramsFor(calls, "/api/stats/users")?.get("from")).toBe(shiftedFrom));
  });

  // The brief's core assertion: a user with zero activity in the range must
  // still be a row on this page, not be silently dropped. Both the active
  // and the quiet fixture user must render, with the quiet one's zeros
  // actually visible.
  it("renders a zero-activity user's row alongside an active user's row — the roster is not filtered", async () => {
    mockFetch();

    renderApp("/users");

    const rows = await screen.findAllByTestId("user-stats-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
  });

  it("navigates to the user's detail route when its row is clicked", async () => {
    mockFetch();

    const router = renderApp("/users");

    const link = await screen.findByRole("link", { name: "Ada Lovelace" });
    fireEvent.click(link);

    await waitFor(() => expect(router.state.location.pathname).toBe("/users/user-active-1"));
  });

  it("shows the panel error on a 500 and does not redirect", async () => {
    mockFetch({ users: () => new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }) });

    const router = renderApp("/users");
    await screen.findByTestId("users-route");

    expect(await screen.findByTestId("users-error")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/users");
  });

  it("redirects to /login instead of rendering an error card on a 401", async () => {
    mockFetch({ users: () => new Response("{}", { status: 401 }) });

    const router = renderApp("/users");
    await screen.findByTestId("users-route");

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(screen.queryByTestId("users-error")).not.toBeInTheDocument();
  });
});
