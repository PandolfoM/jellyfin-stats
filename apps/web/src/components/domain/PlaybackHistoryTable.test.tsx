// @vitest-environment jsdom
//
// PlaybackHistoryTable is a fully controlled, props-only component — no
// fetching, no page state of its own. Its two hardest failure modes are the
// ones called out in this task's brief:
//
//   1. A pagination bug that skips or repeats rows across pages. The trap a
//      previous plan fell into here was asserting only "no id appears
//      twice" — that catches repeats but not gaps, so an off-by-one that
//      silently skipped a row would still pass. Every pagination test below
//      instead walks every page of a fixture large enough to span three of
//      them and asserts the *exact, ordered* concatenation of collected ids
//      equals the full expected sequence — which fails on a gap just as
//      loudly as it fails on a repeat.
//   2. A hollow "showing X–Y of total" assertion that would pass with
//      hardcoded numbers, and that's specifically wrong on the last page
//      (where the upper bound is the total, not `page * pageSize`). Every
//      totals assertion below computes its expected numbers from the
//      fixture's own constants, independently of the component's formula,
//      and one test targets the last (partial) page specifically.
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { PlaybackHistoryTable, type PlaybackHistoryRow } from "./PlaybackHistoryTable";

const PAGE_SIZE = 50;
// Three pages (50 / 50 / 25) — enough to prove ordering holds across more
// than two pages, and the last page is deliberately partial so the totals
// line's upper-bound math gets exercised on the exact case that's easy to
// get wrong.
const TOTAL_ROWS = 125;

function makeRow(index: number, overrides: Partial<PlaybackHistoryRow> = {}): PlaybackHistoryRow {
  const padded = String(index).padStart(3, "0");
  return {
    id: `row-${padded}`,
    userId: `user-${index % 3}`,
    userName: `Example User ${index % 3}`,
    itemId: `item-${padded}`,
    itemName: `Example Item ${padded}`,
    itemType: "Movie",
    seriesId: null,
    seriesName: null,
    seasonNumber: null,
    episodeNumber: null,
    libraryId: "library-example",
    deviceName: "Example Living Room TV",
    client: "Jellyfin Web",
    playMethod: "DirectPlay",
    startedAt: "2026-01-01T12:00:00.000Z",
    endedAt: "2026-01-01T13:00:00.000Z",
    watchMs: 3_600_000,
    completed: true,
    ...overrides,
  };
}

const ALL_ROWS: PlaybackHistoryRow[] = Array.from({ length: TOTAL_ROWS }, (_, index) =>
  makeRow(index),
);

function pageSlice(page: number): PlaybackHistoryRow[] {
  const start = (page - 1) * PAGE_SIZE;
  return ALL_ROWS.slice(start, start + PAGE_SIZE);
}

function visibleRowIds(): string[] {
  return screen
    .getAllByTestId("playback-history-row")
    .map((row) => row.getAttribute("data-row-id") ?? "");
}

/**
 * Owns real page state and slices `ALL_ROWS` for it, standing in for the
 * route container that would otherwise own pagination in production — the
 * table itself is fully controlled and has no state to hold.
 */
function PaginatedHarness() {
  const [page, setPage] = useState(1);
  return (
    <PlaybackHistoryTable
      rows={pageSlice(page)}
      total={TOTAL_ROWS}
      page={page}
      pageSize={PAGE_SIZE}
      onPageChange={setPage}
      loading={false}
    />
  );
}

describe("PlaybackHistoryTable pagination", () => {
  it("walking every page collects the full row sequence exactly once each, in order — catches gaps as well as repeats", () => {
    render(<PaginatedHarness />);

    const collected: string[] = [...visibleRowIds()];
    expect(collected).toHaveLength(50);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    collected.push(...visibleRowIds());
    expect(collected).toHaveLength(100);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    collected.push(...visibleRowIds());
    expect(collected).toHaveLength(125);

    // Exact, ordered equality — not a Set/uniqueness check — is what makes
    // this catch a skipped row. `new Set(collected).size === collected.length`
    // would still pass if e.g. row-049 were silently dropped from every page.
    expect(collected).toEqual(ALL_ROWS.map((row) => row.id));
  });

  it("calls onPageChange with the next page number, and the rows shown afterward reflect it", () => {
    render(<PaginatedHarness />);

    expect(visibleRowIds()[0]).toBe("row-000");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(visibleRowIds()[0]).toBe("row-050");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(visibleRowIds()[0]).toBe("row-100");
    expect(visibleRowIds()).toHaveLength(25);

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(visibleRowIds()[0]).toBe("row-050");
  });

  it("disables Previous on the first page and Next on the last page, and neither on a middle page", () => {
    render(<PaginatedHarness />);

    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Previous" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Previous" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});

describe("PlaybackHistoryTable totals line", () => {
  it("renders 'showing 1–50 of 125' on the first (full) page, from fixture-derived values", () => {
    render(
      <PlaybackHistoryTable
        rows={pageSlice(1)}
        total={TOTAL_ROWS}
        page={1}
        pageSize={PAGE_SIZE}
        onPageChange={() => {}}
        loading={false}
      />,
    );

    const expectedStart = 1;
    const expectedEnd = PAGE_SIZE;
    expect(screen.getByTestId("playback-history-summary")).toHaveTextContent(
      `Showing ${expectedStart}–${expectedEnd} of ${TOTAL_ROWS}`,
    );
  });

  it("renders the correct bound on the LAST (partial) page — total, not page * pageSize", () => {
    const lastPage = 3;

    render(
      <PlaybackHistoryTable
        rows={pageSlice(lastPage)}
        total={TOTAL_ROWS}
        page={lastPage}
        pageSize={PAGE_SIZE}
        onPageChange={() => {}}
        loading={false}
      />,
    );

    // Computed independently from the fixture's own constants, not copied
    // from the component's formula. Page 3 starts at row 101 (two full
    // pages of 50 before it); since 125 isn't a multiple of 50, it ends at
    // the true total, 125 — not at 3 * 50 = 150.
    const expectedStart = (lastPage - 1) * PAGE_SIZE + 1;
    const expectedEnd = TOTAL_ROWS;
    expect(expectedEnd).not.toBe(lastPage * PAGE_SIZE); // sanity: this really is the partial-page case
    expect(screen.getByTestId("playback-history-summary")).toHaveTextContent(
      `Showing ${expectedStart}–${expectedEnd} of ${TOTAL_ROWS}`,
    );
  });
});

describe("PlaybackHistoryTable rendering", () => {
  it("renders a row with placeholder names for deleted media plainly, with no special-casing", () => {
    render(
      <PlaybackHistoryTable
        rows={[
          makeRow(0, { itemName: "Unknown item", userName: "Unknown user", itemType: "Unknown" }),
        ]}
        total={1}
        page={1}
        pageSize={PAGE_SIZE}
        onPageChange={() => {}}
        loading={false}
      />,
    );

    expect(screen.getByText("Unknown item")).toBeInTheDocument();
    expect(screen.getByText("Unknown user")).toBeInTheDocument();
    // "Plainly" means this is the same table row, not a degraded rendering
    // path — no error/warning affordance attached to it.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a loading skeleton and no table while loading", () => {
    render(
      <PlaybackHistoryTable
        rows={[]}
        total={0}
        page={1}
        pageSize={PAGE_SIZE}
        onPageChange={() => {}}
        loading={true}
      />,
    );

    expect(screen.getByLabelText("Loading playback history")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows an empty state, not a table, when there are no rows and loading has finished", () => {
    render(
      <PlaybackHistoryTable
        rows={[]}
        total={0}
        page={1}
        pageSize={PAGE_SIZE}
        onPageChange={() => {}}
        loading={false}
      />,
    );

    expect(screen.getByText("No playback history")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("PlaybackHistoryTable episode context", () => {
  // "Fishes" or "Chapter 4" is unidentifiable on its own in a history that
  // mixes shows together, so an episode row has to carry its series and its
  // S/E numbering alongside the episode's own name.
  function renderRows(rows: PlaybackHistoryRow[]) {
    render(
      <PlaybackHistoryTable
        rows={rows}
        total={rows.length}
        page={1}
        pageSize={PAGE_SIZE}
        onPageChange={() => {}}
        loading={false}
      />,
    );
  }

  it("shows the series, season and episode number alongside the episode name", () => {
    renderRows([
      makeRow(0, {
        itemName: "Fishes",
        itemType: "Episode",
        seriesId: "series-a",
        seriesName: "The Bear",
        seasonNumber: 2,
        episodeNumber: 6,
      }),
    ]);

    expect(screen.getByTestId("playback-history-episode-label")).toHaveTextContent(
      "The Bear · S2E6",
    );
    // The episode's own name is still rendered — the series line is added
    // beside it, not swapped in for it.
    expect(screen.getByText("Fishes")).toBeInTheDocument();
  });

  it("renders no episode line for a movie", () => {
    renderRows([makeRow(0, { itemName: "Example Movie", itemType: "Movie" })]);

    expect(screen.queryByTestId("playback-history-episode-label")).not.toBeInTheDocument();
    expect(screen.getByText("Example Movie")).toBeInTheDocument();
  });

  it("renders what it has for an episode Jellyfin never numbered", () => {
    // Extras and specials can arrive with a series but no IndexNumber, and
    // episodes synced before the columns existed have neither until the next
    // full item sync. Neither case should render an empty line or "SundefinedE".
    renderRows([
      makeRow(0, {
        itemName: "Behind the Scenes",
        itemType: "Episode",
        seriesName: "The Bear",
        seasonNumber: null,
        episodeNumber: null,
      }),
    ]);

    expect(screen.getByTestId("playback-history-episode-label")).toHaveTextContent("The Bear");
  });
});
