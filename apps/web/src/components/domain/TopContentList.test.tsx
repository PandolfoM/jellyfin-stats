// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TopItemsResponse } from "../../api/queries";
import { TopContentList } from "./TopContentList";

afterEach(() => vi.restoreAllMocks());

const ITEMS: TopItemsResponse = [
  {
    itemId: "0123456789abcdef0123456789abcdef",
    name: "Example Movie One",
    type: "Movie",
    libraryId: "library-a",
    seriesId: null,
    imageTag: "tag-a",
    plays: 12,
    watchMs: 7_200_000,
  },
  {
    itemId: "fedcba9876543210fedcba9876543210",
    name: "Example Show Episode",
    type: "Episode",
    libraryId: "library-b",
    seriesId: "series-a",
    imageTag: null,
    plays: 4,
    watchMs: 1_500_000,
  },
];

describe("TopContentList", () => {
  it("renders an EmptyState for an empty list", () => {
    render(<TopContentList items={[]} loading={false} />);

    expect(screen.getByText("No plays in this range")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders a custom emptyMessage when given one", () => {
    render(<TopContentList items={[]} loading={false} emptyMessage="No plays for this library yet" />);

    expect(screen.getByText("No plays for this library yet")).toBeInTheDocument();
  });

  it("renders item names for a populated list", () => {
    render(<TopContentList items={ITEMS} loading={false} />);

    expect(screen.getByText("Example Movie One")).toBeInTheDocument();
    expect(screen.getByText("Example Show Episode")).toBeInTheDocument();
  });

  it("renders skeleton rows, not the empty state or the table, while loading", () => {
    render(<TopContentList items={[]} loading />);

    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText("No plays in this range")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("never renders a broken-image icon for an item with no poster tag", () => {
    render(<TopContentList items={ITEMS} loading={false} />);

    // "Example Show Episode" has imageTag: null — its row must fall back to
    // PosterImage's placeholder, not an <img> the browser can fail to load.
    const images = document.querySelectorAll("img");
    expect(images).toHaveLength(1); // only the item that has a tag
  });
});
