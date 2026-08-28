// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SettingsResponse } from "../../api/queries";
import { SettingsConfigCard } from "./SettingsConfigCard";

afterEach(() => vi.restoreAllMocks());

// Synthetic values only — see the repo-wide rule against real hostnames in
// tracked files. This URL resolves nowhere.
const CONFIG: SettingsResponse = {
  sessionPollIntervalMs: 5_000,
  referenceSyncIntervalMs: 900_000,
  completionThreshold: 0.9,
  jellyfinUrl: "http://jellyfin.example.invalid",
  customCss: "",
};

describe("SettingsConfigCard", () => {
  it("renders the sync intervals as human durations, not raw milliseconds", () => {
    render(<SettingsConfigCard config={CONFIG} loading={false} />);

    // 5_000ms -> "5s", 900_000ms -> "15m" via formatDuration. The raw
    // millisecond numbers must never appear as text a human reads.
    expect(screen.getByText("5s")).toBeInTheDocument();
    expect(screen.getByText("15m")).toBeInTheDocument();
    expect(screen.queryByText("5000")).not.toBeInTheDocument();
    expect(screen.queryByText("900000")).not.toBeInTheDocument();
  });

  it("renders the completion threshold as a percentage, not a raw fraction", () => {
    render(<SettingsConfigCard config={CONFIG} loading={false} />);

    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.queryByText("0.9")).not.toBeInTheDocument();
  });

  it("renders the Jellyfin server URL plainly", () => {
    render(<SettingsConfigCard config={CONFIG} loading={false} />);

    expect(screen.getByText("http://jellyfin.example.invalid")).toBeInTheDocument();
  });

  it("states plainly that these values come from environment variables and are not editable here", () => {
    render(<SettingsConfigCard config={CONFIG} loading={false} />);

    expect(screen.getByText(/environment variable/i)).toBeInTheDocument();
  });

  it("renders no input, switch, or save control — read-only display only", () => {
    render(<SettingsConfigCard config={CONFIG} loading={false} />);

    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("shows skeletons instead of values while loading, with a null config", () => {
    render(<SettingsConfigCard config={null} loading />);

    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText("http://jellyfin.example.invalid")).not.toBeInTheDocument();
  });
});
