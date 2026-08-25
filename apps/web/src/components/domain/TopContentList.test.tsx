// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TopItemsResponse } from "../../api/queries";
import { TopContentList } from "./TopContentList";

afterEach(() => vi.restoreAllMocks());

const TAGGED_ITEM: TopItemsResponse[number] = {
  itemId: "0123456789abcdef0123456789abcdef",
  name: "Example Movie One",
  type: "Movie",
  libraryId: "library-a",
  seriesId: null,
  imageTag: "tag-a",
  plays: 12,
  watchMs: 7_200_000,
};

const UNTAGGED_ITEM: TopItemsResponse[number] = {
  itemId: "fedcba9876543210fedcba9876543210",
  name: "Example Show Episode",
  type: "Episode",
  libraryId: "library-b",
  seriesId: "series-a",
  imageTag: null,
  plays: 4,
  watchMs: 1_500_000,
};

const ITEMS: TopItemsResponse = [TAGGED_ITEM, UNTAGGED_ITEM];

describe("TopContentList", () => {
  it("renders an EmptyState for an empty list", () => {
    render(<TopContentList items={[]} loading={false} />);

    expect(screen.getByText("No plays in this range")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders a custom emptyMessage when given one", () => {
    render(
      <TopContentList items={[]} loading={false} emptyMessage="No plays for this library yet" />,
    );

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

  // PosterImage (see its own test file) requests an item's primary image
  // even when `imageTag` is null — a missing tag is a missing cache-busting
  // hint, not a missing image, since apps/server/src/api/routes/images.ts
  // treats `tag` as optional. TopContentList's own job is only to pass each
  // item's real `imageTag` straight through unmodified; this proves it does
  // exactly that for both an item that has one and one that doesn't, rather
  // than special-casing either.
  it("passes each item's real imageTag straight through to PosterImage, tagged or not", () => {
    render(<TopContentList items={ITEMS} loading={false} />);

    const images = Array.from(document.querySelectorAll("img"));
    expect(images).toHaveLength(2);

    const taggedSrc = images
      .find((img) => img.getAttribute("src")?.includes(TAGGED_ITEM.itemId))
      ?.getAttribute("src");
    const untaggedSrc = images
      .find((img) => img.getAttribute("src")?.includes(UNTAGGED_ITEM.itemId))
      ?.getAttribute("src");

    expect(taggedSrc).toBe(`/api/images/items/${TAGGED_ITEM.itemId}?tag=${TAGGED_ITEM.imageTag}`);
    // No tag= at all for the untagged item — not a stringified null/undefined.
    expect(untaggedSrc).toBe(`/api/images/items/${UNTAGGED_ITEM.itemId}`);
  });
});
