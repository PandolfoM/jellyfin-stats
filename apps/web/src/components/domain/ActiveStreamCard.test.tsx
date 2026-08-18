// @vitest-environment jsdom
import type { LiveSession } from "@jfstats/shared";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveStreamCard } from "./ActiveStreamCard";

afterEach(() => vi.restoreAllMocks());

// Synthetic — not a real Jellyfin session, item, user, or IP.
// 15 minutes into a 45-minute runtime; 203.0.113.0/24 is the IANA
// TEST-NET-3 block reserved for documentation.
const BASE_SESSION: LiveSession = {
  sessionId: "session-aaaa",
  userId: "user-aaaa",
  userName: "sample-viewer",
  itemId: "0123456789abcdef0123456789abcdef",
  itemName: "Sample Movie One",
  deviceId: "device-aaaa",
  deviceName: "Living Room TV",
  client: "Jellyfin Web",
  playMethod: "DirectPlay",
  positionTicks: 15 * 60 * 1000 * 10_000,
  runtimeTicks: 45 * 60 * 1000 * 10_000,
  isPaused: false,
  remoteEndpoint: "203.0.113.10",
};

describe("ActiveStreamCard", () => {
  it("renders the item name, viewer, and device for both variants", () => {
    render(<ActiveStreamCard session={BASE_SESSION} variant="compact" />);
    expect(screen.getByText("Sample Movie One")).toBeInTheDocument();
    expect(screen.getByText("sample-viewer · Living Room TV")).toBeInTheDocument();
  });

  it("shows elapsed and total duration, converted from Jellyfin's 100ns ticks", () => {
    render(<ActiveStreamCard session={BASE_SESSION} variant="full" />);
    // 15m elapsed of a 45m runtime — proves the ticks-to-ms conversion is
    // actually applied (10,000 ticks/ms), not e.g. ticks treated as ms
    // directly, which would print something absurd like "9000000m".
    expect(screen.getByText("15m / 45m")).toBeInTheDocument();
  });

  it("renders a progress bar sized to position/runtime when a runtime is known", () => {
    render(<ActiveStreamCard session={BASE_SESSION} variant="full" />);

    const bar = screen.getByRole("progressbar", { name: "Playback progress for Sample Movie One" });
    // 15/45 = 33.33...%, rounded.
    expect(bar).toHaveAttribute("aria-valuenow", "33");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  it("omits the progress bar, and shows only elapsed time, when runtime is unknown (e.g. live TV)", () => {
    const session: LiveSession = { ...BASE_SESSION, runtimeTicks: null };
    render(<ActiveStreamCard session={session} variant="full" />);

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("15m")).toBeInTheDocument();
    expect(screen.queryByText(/\//)).not.toBeInTheDocument();
  });

  it("full variant shows the client and play-method badges; compact hides them", () => {
    const { rerender } = render(<ActiveStreamCard session={BASE_SESSION} variant="full" />);
    expect(screen.getByText("Jellyfin Web")).toBeInTheDocument();
    expect(screen.getByText("DirectPlay")).toBeInTheDocument();

    rerender(<ActiveStreamCard session={BASE_SESSION} variant="compact" />);
    expect(screen.queryByText("Jellyfin Web")).not.toBeInTheDocument();
    expect(screen.queryByText("DirectPlay")).not.toBeInTheDocument();
  });

  it("full variant shows a Paused badge when the session is paused, and none when it isn't", () => {
    const paused: LiveSession = { ...BASE_SESSION, isPaused: true };
    const { rerender } = render(<ActiveStreamCard session={paused} variant="full" />);
    expect(screen.getByText("Paused")).toBeInTheDocument();

    rerender(<ActiveStreamCard session={BASE_SESSION} variant="full" />);
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
  });

  it("compact variant surfaces paused state as text, since it hides badges entirely", () => {
    const paused: LiveSession = { ...BASE_SESSION, isPaused: true };
    render(<ActiveStreamCard session={paused} variant="compact" />);
    expect(screen.getByText("15m / 45m · Paused")).toBeInTheDocument();
  });

  // The security-relevant assertion this component owns: LiveSession carries
  // no image tag, so this must never fabricate one and must never render a
  // real <img> pointed anywhere — only PosterImage's own placeholder.
  it("never renders an <img> element — LiveSession has no image tag to give PosterImage", () => {
    const { container } = render(<ActiveStreamCard session={BASE_SESSION} variant="full" />);

    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Poster for Sample Movie One" })).toBeInTheDocument();
  });

  it("renders one card per distinct session when used in a list, keyed by sessionId", () => {
    const other: LiveSession = { ...BASE_SESSION, sessionId: "session-bbbb", itemName: "Sample Movie Two" };
    render(
      <>
        <ActiveStreamCard session={BASE_SESSION} variant="full" />
        <ActiveStreamCard session={other} variant="full" />
      </>,
    );

    const cards = screen.getAllByTestId("active-stream-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByText("Sample Movie One")).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText("Sample Movie Two")).toBeInTheDocument();
  });
});
