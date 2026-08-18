// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserStatsResponse } from "../../api/queries";
import { UserStatsTable } from "./UserStatsTable";

afterEach(() => vi.restoreAllMocks());

const ACTIVE_USER: UserStatsResponse[number] = {
  userId: "user-active-1",
  name: "Ada Lovelace",
  isAdmin: true,
  plays: 42,
  watchMs: 7_265_000,
};

// A real zero-activity row — not a hypothetical. Without this row actually
// present in the fixture, a test that merely checks "the active user
// renders" would pass identically whether or not the component secretly
// filtered out rows with plays === 0, since there would be nothing in the
// fixture for that filter to remove. This is the exact shape of hollow
// assertion the brief calls out.
const ZERO_ACTIVITY_USER: UserStatsResponse[number] = {
  userId: "user-quiet-1",
  name: "Grace Hopper",
  isAdmin: false,
  plays: 0,
  watchMs: 0,
};

const USERS: UserStatsResponse = [ACTIVE_USER, ZERO_ACTIVITY_USER];

/**
 * `UserStatsTable` links each row to `/users/$userId`, so — like
 * `AppShell.test.tsx` — it needs a router context for `Link` to read, not
 * application providers. A bespoke single-route tree is enough.
 */
function renderWithRouter(users: UserStatsResponse, loading = false) {
  const rootRoute = createRootRoute({
    component: () => <UserStatsTable users={users} loading={loading} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

describe("UserStatsTable", () => {
  it("renders an EmptyState for an empty list", async () => {
    renderWithRouter([]);

    expect(await screen.findByText("No users")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders skeleton rows, not the table or empty state, while loading", async () => {
    renderWithRouter([], true);

    await screen.findByLabelText("Loading users");
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText("No users")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  // The core assertion the brief demands: a user with zero plays in the
  // range must still be a row in the table, not be dropped by the
  // component. Both rows from the fixture must be present, and specifically
  // the quiet user's zeros must render as "0"/"0m", not be blank or missing.
  it("renders a zero-activity user's row with zeros, alongside an active user's row — neither is filtered out", async () => {
    renderWithRouter(USERS);

    const rows = await screen.findAllByTestId("user-stats-row");
    expect(rows).toHaveLength(2);

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();

    const quietRow = rows.find((row) => within(row).queryByText("Grace Hopper") !== null);
    expect(quietRow).toBeDefined();
    if (quietRow !== undefined) {
      expect(within(quietRow).getByText("0")).toBeInTheDocument(); // plays
      expect(within(quietRow).getByText("0m")).toBeInTheDocument(); // watch time
    }
  });

  it("shows an Admin badge only for admin users", async () => {
    renderWithRouter(USERS);

    const rows = await screen.findAllByTestId("user-stats-row");
    const adminRow = rows.find((row) => within(row).queryByText("Ada Lovelace") !== null);
    const nonAdminRow = rows.find((row) => within(row).queryByText("Grace Hopper") !== null);

    expect(adminRow).toBeDefined();
    expect(nonAdminRow).toBeDefined();
    if (adminRow !== undefined && nonAdminRow !== undefined) {
      expect(within(adminRow).getByText("Admin")).toBeInTheDocument();
      expect(within(nonAdminRow).queryByText("Admin")).not.toBeInTheDocument();
    }
  });

  it("links each user's name to their detail route", async () => {
    renderWithRouter(USERS);

    const link = await screen.findByRole("link", { name: "Ada Lovelace" });
    expect(link).toHaveAttribute("href", "/users/user-active-1");
  });
});
