// @vitest-environment jsdom
//
// The gate is the point of Task 4: a route that renders its container before
// the session resolves fires queries that are guaranteed to 401, and a route
// that renders for an anonymous visitor shows an empty dashboard instead of
// a login prompt. Every case here asserts on rendered output for the actual
// route tree (via `createAppRouter`, the same assembly `main.tsx` uses) —
// never on whether the gate merely *stopped short* of rendering the wrong
// thing, since the ordinary "loading" default already does that on the
// first tick regardless of what the gate does next.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../auth/session";
import { createAppRouter } from "../router";

afterEach(() => vi.restoreAllMocks());

const AUTHENTICATED_BODY = JSON.stringify({ userId: "u-1", userName: "admin", isAdmin: true });

function mockAuthMe(respond: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/api/auth/me")) {
        return respond();
      }
      throw new Error(`guard.test.tsx did not expect a fetch to ${url}`);
    }),
  );
}

/**
 * Same as `mockAuthMe`, but also answers the four queries the Overview
 * route (Task 7) fires once it actually renders — only the "authenticated"
 * case below reaches that route, but since the gate itself doesn't know or
 * care what Overview does with its content, this file's job is still just
 * "does the gate render the right thing", not "does Overview render
 * correctly" (index.test.tsx owns that).
 */
function mockAuthMeAndOverviewQueries(respond: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/api/auth/me")) return respond();
      if (url.includes("/api/stats/overview")) {
        return new Response(JSON.stringify({ plays: 0, watchMs: 0, activeUsers: 0, activeItems: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/stats/series") || url.includes("/api/stats/top-items")) {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/history")) {
        return new Response(JSON.stringify({ rows: [], total: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`guard.test.tsx did not expect a fetch to ${url}`);
    }),
  );
}

function renderAt(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [initialPath] }));
  render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe("protected-route gate", () => {
  it("while the session is loading, renders a shell skeleton and no route content", async () => {
    // Never resolves — the assertion has to hold for as long as "loading" lasts.
    mockAuthMe(() => new Promise<Response>(() => {}));

    renderAt("/");

    expect(await screen.findByTestId("shell-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-route")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
  });

  it("redirects an anonymous visitor from a protected route to /login instead of rendering it", async () => {
    mockAuthMe(() => new Response("{}", { status: 401 }));

    const router = renderAt("/");

    await waitFor(() => expect(screen.getByLabelText("Username")).toBeInTheDocument());
    expect(screen.queryByTestId("overview-route")).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("renders the protected route for an authenticated session", async () => {
    mockAuthMeAndOverviewQueries(
      () => new Response(AUTHENTICATED_BODY, { status: 200, headers: { "content-type": "application/json" } }),
    );

    const router = renderAt("/");

    expect(await screen.findByTestId("overview-route")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("leaves /login reachable for an anonymous visitor and does not redirect away from it", async () => {
    mockAuthMe(() => new Response("{}", { status: 401 }));

    const router = renderAt("/login");

    await waitFor(() => expect(screen.getByLabelText("Username")).toBeInTheDocument());
    expect(screen.queryByTestId("overview-route")).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  // "error" is the fourth session status — the API is unreachable or broke —
  // and it must not be collapsed into "anonymous". Showing the login form
  // here would invite a login attempt that cannot possibly succeed.
  it("shows an error state — neither the protected route nor the login form — when the session cannot be resolved", async () => {
    mockAuthMe(() => new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }));

    renderAt("/");

    expect(await screen.findByTestId("session-error")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-route")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
  });

  it("shows the error state on /login too, rather than the login form a broken server can't honor", async () => {
    mockAuthMe(() => new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }));

    renderAt("/login");

    expect(await screen.findByTestId("session-error")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
  });
});
