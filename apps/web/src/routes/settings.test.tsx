// @vitest-environment jsdom
//
// Settings is a container route: it owns the one query this route needs
// (`GET /api/settings`) and reads the signed-in account from `useSession()`.
// Assertions follow the same convention as `routes/history.test.tsx` and
// `routes/users.test.tsx` — anchored on real fetch calls and rendered text,
// not just "did a query run".
//
// The rendered tree includes AppShell's own sidebar "Log out" button as well
// as this route's Account-card "Log out" button, so every test that needs
// the route's own button scopes its query with `within(settings-route)`
// rather than a bare `screen.getByRole`, which would find two matches.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../test/renderApp";

afterEach(() => vi.restoreAllMocks());

const AUTHENTICATED_BODY = JSON.stringify({
  userId: "user-1",
  userName: "Ada Lovelace",
  isAdmin: true,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Synthetic values only — see the repo-wide rule against real hostnames in
// tracked files. This URL resolves nowhere.
const SETTINGS_FIXTURE = {
  sessionPollIntervalMs: 5_000,
  referenceSyncIntervalMs: 900_000,
  completionThreshold: 0.9,
  jellyfinUrl: "http://jellyfin.example.invalid",
  customCss: "",
};

interface FetchOverrides {
  settings?: () => Response;
  logout?: () => Response;
}

function mockFetch(overrides: FetchOverrides = {}): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);

      if (url.includes("/api/auth/me")) return jsonResponse(JSON.parse(AUTHENTICATED_BODY));
      if (url.includes("/api/auth/logout"))
        return overrides.logout?.() ?? jsonResponse({ ok: true });
      if (url.includes("/api/settings"))
        return overrides.settings?.() ?? jsonResponse(SETTINGS_FIXTURE);

      throw new Error(`settings.test.tsx did not expect a fetch to ${url}`);
    }),
  );
  return calls;
}

describe("Settings route", () => {
  it("fires /api/settings and renders the account name and effective configuration", async () => {
    mockFetch();

    renderApp("/settings");

    const route = await screen.findByTestId("settings-route");
    expect(within(route).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(await within(route).findByText("http://jellyfin.example.invalid")).toBeInTheDocument();
    expect(within(route).getByText("90%")).toBeInTheDocument();
  });

  it("states plainly that the configuration comes from environment variables", async () => {
    mockFetch();

    renderApp("/settings");

    expect(await screen.findByText(/environment variable/i)).toBeInTheDocument();
  });

  it("renders no editable control in the configuration card", async () => {
    // Scoped to that card rather than the whole page, which now also carries
    // the custom-CSS editor. The guard itself still matters and is unchanged
    // in intent: everything the configuration card shows comes from
    // environment variables fixed at deploy time, so a control that looked
    // editable there could never save.
    mockFetch();

    renderApp("/settings");

    const card = within(await screen.findByTestId("settings-config-card"));
    expect(card.queryAllByRole("textbox")).toHaveLength(0);
    expect(card.queryAllByRole("checkbox")).toHaveLength(0);
    expect(card.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
  });

  it("renders the custom CSS editor, which is editable", async () => {
    // The counterpart to the assertion above: exactly one thing on this page
    // is writable, and it is backed by a real endpoint.
    mockFetch();

    renderApp("/settings");

    expect(await screen.findByLabelText("Custom CSS")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("shows the panel error for configuration but still shows the account and logout control on a 500", async () => {
    mockFetch({
      settings: () => new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    });

    renderApp("/settings");

    const route = await screen.findByTestId("settings-route");
    expect(await within(route).findByTestId("settings-error")).toBeInTheDocument();
    // The failed config fetch must not take the account card down with it —
    // the same "one query's error doesn't blank an unrelated panel"
    // convention routes/index.tsx and routes/history.tsx use.
    expect(within(route).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(route).getByRole("button", { name: /log out/i })).toBeInTheDocument();
  });

  it("redirects to /login instead of rendering an error card on a 401 from /api/settings", async () => {
    mockFetch({ settings: () => new Response("{}", { status: 401 }) });

    const router = renderApp("/settings");
    await screen.findByTestId("settings-route");

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(screen.queryByTestId("settings-error")).not.toBeInTheDocument();
  });

  it("clicking the page's own logout control signs the user out", async () => {
    mockFetch();

    const router = renderApp("/settings");
    const route = await screen.findByTestId("settings-route");

    await userEvent.click(within(route).getByRole("button", { name: /log out/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });
});
