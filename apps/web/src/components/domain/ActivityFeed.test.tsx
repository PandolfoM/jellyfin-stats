// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HistoryResponse } from "../../api/queries";
import { ActivityFeed } from "./ActivityFeed";

afterEach(() => vi.restoreAllMocks());

const ROWS: HistoryResponse["rows"] = [
  {
    id: "row-1",
    userId: "user-1",
    userName: "ada",
    itemId: "item-1",
    itemName: "Example Movie One",
    itemType: "Movie",
    seriesId: null,
    seriesName: null,
    seasonNumber: null,
    episodeNumber: null,
    libraryId: "library-a",
    deviceName: "Living Room TV",
    client: "Jellyfin Web",
    playMethod: "DirectPlay",
    startedAt: "2026-01-05T20:15:00.000Z",
    endedAt: "2026-01-05T22:00:00.000Z",
    watchMs: 6_300_000,
    completed: true,
  },
  {
    id: "row-2",
    userId: "user-2",
    userName: "grace",
    itemId: "item-2",
    itemName: "Example Show Episode",
    itemType: "Episode",
    seriesId: "series-a",
    seriesName: "Example Show",
    seasonNumber: 2,
    episodeNumber: 5,
    libraryId: "library-b",
    deviceName: null,
    client: null,
    playMethod: null,
    startedAt: "2026-01-06T09:00:00.000Z",
    endedAt: null,
    watchMs: 1_500_000,
    completed: false,
  },
];

describe("ActivityFeed", () => {
  it("renders skeletons, not the list or empty state, while loading", () => {
    render(<ActivityFeed rows={[]} loading />);

    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText("No recent activity")).not.toBeInTheDocument();
  });

  it("renders an EmptyState for an empty list once loaded", () => {
    render(<ActivityFeed rows={[]} loading={false} />);

    expect(screen.getByText("No recent activity")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("renders one row per entry, with the item name, user, and duration", () => {
    render(<ActivityFeed rows={ROWS} loading={false} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Example Movie One")).toBeInTheDocument();
    expect(screen.getByText("Example Show Episode")).toBeInTheDocument();
    expect(screen.getByText("ada", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("grace", { exact: false })).toBeInTheDocument();
    // formatDuration(6_300_000) === "1h 45m", formatDuration(1_500_000) === "25m"
    expect(screen.getByText("1h 45m")).toBeInTheDocument();
    expect(screen.getByText("25m")).toBeInTheDocument();
  });

  it("does not fetch anything itself", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("ActivityFeed must not fetch anything itself");
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<ActivityFeed rows={ROWS} loading={false} />);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
