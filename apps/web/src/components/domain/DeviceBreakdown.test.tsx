// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeviceStat } from "./DeviceBreakdown";
import { DeviceBreakdown } from "./DeviceBreakdown";

afterEach(() => vi.restoreAllMocks());

const DEVICES: DeviceStat[] = [
  { deviceId: "device-1", name: "Living Room TV", plays: 30 },
  { deviceId: "device-2", name: "Unknown device", plays: 10 },
];

describe("DeviceBreakdown", () => {
  it("renders an EmptyState for an empty list", () => {
    render(<DeviceBreakdown devices={[]} loading={false} />);

    expect(screen.getByText("No devices")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("renders skeleton rows, not the empty state, while loading", () => {
    render(<DeviceBreakdown devices={[]} loading />);

    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText("No devices")).not.toBeInTheDocument();
  });

  it("renders every device's name and play count for a populated list", () => {
    render(<DeviceBreakdown devices={DEVICES} loading={false} />);

    const rows = screen.getAllByTestId("device-breakdown-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Living Room TV")).toBeInTheDocument();
    expect(screen.getByText("30 plays")).toBeInTheDocument();
    // "Unknown device" (the server's placeholder for a deleted device row,
    // per getUserDetail's `coalesce`) renders plainly, like any other name —
    // no special-cased branch here, matching PlaybackHistoryTable's
    // convention for placeholder strings.
    expect(screen.getByText("Unknown device")).toBeInTheDocument();
    expect(screen.getByText("10 plays")).toBeInTheDocument();
  });

  // The busiest device's bar must be full width regardless of the absolute
  // numbers involved — proves the scaling is relative to this list's own
  // max, not some fixed constant that would make a 3,000-play device's bar
  // look identical to a 3-play one on a much quieter user.
  it("scales the busiest device's bar to 100% width", () => {
    render(<DeviceBreakdown devices={DEVICES} loading={false} />);

    const rows = screen.getAllByTestId("device-breakdown-row");
    const bars = rows.map((row) => row.querySelector(".bg-primary"));
    expect(bars[0]).toHaveStyle({ width: "100%" });
    expect(bars[1]).toHaveStyle({ width: `${(10 / 30) * 100}%` });
  });

  // A non-empty list where every device has `plays: 0` would divide by
  // zero (`0 / Math.max(...[0, 0])`) without the floor in the component —
  // rendering `NaN%` bars, not `0%` ones. Not reachable through the real
  // API today (a device only appears with at least one completed session),
  // but nothing enforces that at the type level, so this is guarded
  // directly rather than left to hold by convention alone.
  it("renders 0%-width bars, not NaN%, when every device has zero plays", () => {
    const zeroDevices: DeviceStat[] = [
      { deviceId: "device-1", name: "Idle TV", plays: 0 },
      { deviceId: "device-2", name: "Idle Phone", plays: 0 },
    ];

    render(<DeviceBreakdown devices={zeroDevices} loading={false} />);

    const rows = screen.getAllByTestId("device-breakdown-row");
    const bars = rows.map((row) => row.querySelector(".bg-primary"));
    expect(bars[0]).toHaveStyle({ width: "0%" });
    expect(bars[1]).toHaveStyle({ width: "0%" });
  });
});
