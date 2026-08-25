// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LibraryStatsResponse } from "../../api/queries";
import { LibraryStatsTable } from "./LibraryStatsTable";

afterEach(() => vi.restoreAllMocks());

const ACTIVE_LIBRARY: LibraryStatsResponse[number] = {
  libraryId: "library-active-1",
  name: "Movies",
  collectionType: "movies",
  plays: 108,
  watchMs: 36_000_000,
};

// A real zero-activity row, the same trap `UserStatsTable.test.tsx` guards
// against: a fixture with only active libraries would pass a "not filtered"
// assertion vacuously, since there'd be nothing for an over-aggressive
// filter to remove.
const ZERO_ACTIVITY_LIBRARY: LibraryStatsResponse[number] = {
  libraryId: "library-quiet-1",
  name: "Home Videos",
  collectionType: null,
  plays: 0,
  watchMs: 0,
};

const LIBRARIES: LibraryStatsResponse = [ACTIVE_LIBRARY, ZERO_ACTIVITY_LIBRARY];

function renderWithRouter(libraries: LibraryStatsResponse, loading = false) {
  const rootRoute = createRootRoute({
    component: () => <LibraryStatsTable libraries={libraries} loading={loading} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

describe("LibraryStatsTable", () => {
  it("renders an EmptyState for an empty list", async () => {
    renderWithRouter([]);

    expect(await screen.findByText("No libraries")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders skeleton rows, not the table or empty state, while loading", async () => {
    renderWithRouter([], true);

    await screen.findByLabelText("Loading libraries");
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText("No libraries")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders a zero-activity library's row with zeros, alongside an active library's row — neither is filtered out", async () => {
    renderWithRouter(LIBRARIES);

    const rows = await screen.findAllByTestId("library-stats-row");
    expect(rows).toHaveLength(2);

    expect(screen.getByText("Movies")).toBeInTheDocument();
    expect(screen.getByText("Home Videos")).toBeInTheDocument();

    const quietRow = rows.find((row) => within(row).queryByText("Home Videos") !== null);
    expect(quietRow).toBeDefined();
    if (quietRow !== undefined) {
      expect(within(quietRow).getByText("0")).toBeInTheDocument();
      expect(within(quietRow).getByText("0m")).toBeInTheDocument();
    }
  });

  it("shows a collectionType badge only when one exists", async () => {
    renderWithRouter(LIBRARIES);

    const rows = await screen.findAllByTestId("library-stats-row");
    const moviesRow = rows.find((row) => within(row).queryByText("Movies") !== null);
    const homeVideosRow = rows.find((row) => within(row).queryByText("Home Videos") !== null);

    expect(moviesRow).toBeDefined();
    expect(homeVideosRow).toBeDefined();
    if (moviesRow !== undefined && homeVideosRow !== undefined) {
      expect(within(moviesRow).getByText("movies")).toBeInTheDocument();
      // null collectionType renders no badge at all, not a literal "null" string.
      expect(within(homeVideosRow).queryByText("null")).not.toBeInTheDocument();
    }
  });

  it("links each library's name to its detail route", async () => {
    renderWithRouter(LIBRARIES);

    const link = await screen.findByRole("link", { name: "Movies" });
    expect(link).toHaveAttribute("href", "/libraries/library-active-1");
  });
});
