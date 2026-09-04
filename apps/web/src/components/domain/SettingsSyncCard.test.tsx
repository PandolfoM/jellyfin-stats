// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsSyncCard } from "./SettingsSyncCard";

afterEach(() => vi.restoreAllMocks());

const IDLE = { available: true, running: false, lastRunAt: null };

describe("SettingsSyncCard", () => {
  it("offers a Sync now button when idle", () => {
    render(<SettingsSyncCard status={IDLE} loading={false} onSync={async () => {}} />);

    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
  });

  it("calls onSync when the button is clicked", async () => {
    const onSync = vi.fn(async () => {});
    render(<SettingsSyncCard status={IDLE} loading={false} onSync={onSync} />);

    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));

    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("disables the button and says so while a sync is running", () => {
    render(
      <SettingsSyncCard
        status={{ ...IDLE, running: true }}
        loading={false}
        onSync={async () => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /syncing/i })).toBeDisabled();
  });

  it("shows when the last sync completed, relative to now", () => {
    const lastRunAt = new Date(Date.now() - 12 * 60_000).toISOString();
    render(
      <SettingsSyncCard status={{ ...IDLE, lastRunAt }} loading={false} onSync={async () => {}} />,
    );

    expect(screen.getByText(/last synced 12 min ago/i)).toBeInTheDocument();
  });

  it("says a sync has never completed when there is no last run", () => {
    render(<SettingsSyncCard status={IDLE} loading={false} onSync={async () => {}} />);

    expect(screen.getByText(/never synced/i)).toBeInTheDocument();
  });

  it("explains and disables the button when sync is unavailable on this server", () => {
    render(
      <SettingsSyncCard
        status={{ ...IDLE, available: false }}
        loading={false}
        onSync={async () => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
    expect(screen.getByText(/not available/i)).toBeInTheDocument();
  });

  it("renders a skeleton, not the button, while loading", () => {
    render(<SettingsSyncCard status={null} loading onSync={async () => {}} />);

    expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it("surfaces a failed trigger instead of silently doing nothing", async () => {
    render(
      <SettingsSyncCard
        status={IDLE}
        loading={false}
        onSync={async () => {
          throw new Error("boom");
        }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not start/i);
  });
});
