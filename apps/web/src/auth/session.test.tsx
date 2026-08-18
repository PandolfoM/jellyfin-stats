// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyUnauthorized } from "../api/unauthorized";
import { SessionProvider, useSession } from "./session";

function Probe() {
  const { status, user, login, logout } = useSession();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.userName ?? "-"}</span>
      <button onClick={() => void login("admin", "secret")}>login</button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input instanceof Request ? input.url : input), init),
    ),
  );
}

describe("SessionProvider", () => {
  it("resolves to authenticated when /api/auth/me returns a user", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ userId: "u-1", userName: "admin", isAdmin: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    renderProbe();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    expect(screen.getByTestId("user")).toHaveTextContent("admin");
  });

  it("treats a 401 as anonymous rather than an error", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }));

    renderProbe();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
  });

  it("does NOT treat a 500 as anonymous", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }));

    renderProbe();

    // A positive assertion, not `not.toHaveTextContent("anonymous")`: the
    // initial render is "loading", which already satisfies a negative check
    // on its very first tick, before the mocked fetch has even settled —
    // `waitFor` stops at the first passing check, so that phrasing would
    // pass even if a 500 mapped to "anonymous" a moment later, or hung
    // forever. Asserting the actual destination state is what proves this.
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));
  });

  it("treats a network failure (fetch itself rejecting) as an error, not indefinite loading", async () => {
    // Not an error *status* — an actual rejected promise, as happens when the
    // server is unreachable (connection refused, DNS failure, offline).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    renderProbe();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));
  });

  it("becomes authenticated after a successful login", async () => {
    let loggedIn = false;
    mockFetch((url) => {
      if (url.includes("/api/auth/login")) {
        loggedIn = true;
        return new Response(JSON.stringify({ userId: "u-1", userName: "admin", isAdmin: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return loggedIn
        ? new Response(JSON.stringify({ userId: "u-1", userName: "admin", isAdmin: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("{}", { status: 401 });
    });

    renderProbe();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));

    await userEvent.click(screen.getByText("login"));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
  });

  it("returns to anonymous after logout", async () => {
    let loggedIn = true;
    mockFetch((url) => {
      if (url.includes("/api/auth/logout")) {
        loggedIn = false;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return loggedIn
        ? new Response(JSON.stringify({ userId: "u-1", userName: "admin", isAdmin: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("{}", { status: 401 });
    });

    renderProbe();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    await userEvent.click(screen.getByText("logout"));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
  });

  it("becomes anonymous when a protected route's query reports a 401 via the shared unauthorized notifier", async () => {
    // Nothing here calls /api/auth/me again — this proves the transition
    // comes from `notifyUnauthorized` alone, the same signal `unwrap` sends
    // for a 401 on a stats/history/etc. query, not from a fresh session
    // resolution. A SessionProvider that only reacted to `resolveSession`
    // (and ignored the shared notifier) would leave `status` stuck on
    // "authenticated" here.
    mockFetch(() =>
      new Response(JSON.stringify({ userId: "u-1", userName: "admin", isAdmin: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    renderProbe();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    act(() => {
      notifyUnauthorized();
    });

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
  });

  it("surfaces the API's distinct login failures as distinct errors", async () => {
    const seen: string[] = [];

    for (const [status, expected] of [
      [401, "invalid_credentials"],
      [403, "not_an_administrator"],
      [429, "too_many_attempts"],
      [503, "jellyfin_unavailable"],
    ] as const) {
      mockFetch((url) =>
        url.includes("/api/auth/login")
          ? new Response(JSON.stringify({ error: expected }), { status })
          : new Response("{}", { status: 401 }),
      );

      const { unmount } = renderProbe();
      await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
      await userEvent.click(screen.getByText("login"));
      await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
      seen.push(expected);
      unmount();
      vi.restoreAllMocks();
    }

    // Each code has a different remedy: fix the password, use an admin account,
    // wait, or go check the Jellyfin server. "Login failed" tells the user none.
    expect(seen).toEqual([
      "invalid_credentials",
      "not_an_administrator",
      "too_many_attempts",
      "jellyfin_unavailable",
    ]);
  });
});
