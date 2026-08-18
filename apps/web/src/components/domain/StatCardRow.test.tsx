// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OverviewResponse } from "../../api/queries";
import { StatCardRow } from "./StatCardRow";

afterEach(() => vi.restoreAllMocks());

const STATS: OverviewResponse = { plays: 42, watchMs: 7_265_000, activeUsers: 3, activeItems: 12 };

describe("StatCardRow", () => {
  it("renders zeros, not blanks, for a null stats object once loaded", () => {
    render(<StatCardRow stats={null} loading={false} />);

    // formatCount(0) === "0" and formatDuration(0) === "0m" — a component
    // that rendered `undefined`/`NaN`/an empty string here (e.g. from
    // `stats.plays` on a null `stats`) would fail this, whereas one that
    // silently omitted the tiles entirely would fail the `getAllByText`
    // count below.
    const zeroCounts = screen.getAllByText("0");
    expect(zeroCounts).toHaveLength(3); // plays, active users, active items
    expect(screen.getByText("0m")).toBeInTheDocument();
  });

  it("renders the real numbers once stats resolve", () => {
    render(<StatCardRow stats={STATS} loading={false} />);

    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("2h 1m")).toBeInTheDocument();
  });

  it("renders four skeletons while loading, regardless of stats", () => {
    render(<StatCardRow stats={STATS} loading />);

    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(4);
    expect(screen.queryByText("42")).not.toBeInTheDocument();
  });

  it("labels all four tiles", () => {
    render(<StatCardRow stats={STATS} loading={false} />);

    expect(screen.getByText("Plays")).toBeInTheDocument();
    expect(screen.getByText("Watch time")).toBeInTheDocument();
    expect(screen.getByText("Active users")).toBeInTheDocument();
    expect(screen.getByText("Active items")).toBeInTheDocument();
  });
});
