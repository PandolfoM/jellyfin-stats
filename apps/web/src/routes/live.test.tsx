// @vitest-environment jsdom
//
// Integration-level coverage for the Live route: real router + real
// SessionProvider (via renderApp), with a FakeEventSource standing in for
// the browser API jsdom doesn't implement. useLiveSessions.test.ts already
// covers the hook's own contract in isolation; this file covers what only
// exists once the hook is actually mounted inside the route — the visible
// disconnected state (the brief's "frozen list" failure mode, trap 3) and
// the EventSource actually closing when React unmounts the route via real
// navigation, not just a bare `unmount()` call.
import type { LiveSession } from "@jfstats/shared";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../test/renderApp";
import { dispatchSessions, FakeEventSource, installFakeEventSource } from "../test/fakeEventSource";

afterEach(() => vi.restoreAllMocks());

const AUTHENTICATED_BODY = JSON.stringify({ userId: "user-1", userName: "admin", isAdmin: true });

// Synthetic — not real Jellyfin data. 203.0.113.0/24 is the IANA TEST-NET-3
// documentation block, never a routable address.
const SESSION_A: LiveSession = {
  sessionId: "session-aaaa",
  userId: "user-aaaa",
  userName: "sample-viewer",
  itemId: "0123456789abcdef0123456789abcdef",
  itemName: "Sample Movie One",
  deviceId: "device-aaaa",
  deviceName: "Living Room TV",
  client: "Jellyfin Web",
  playMethod: "DirectPlay",
  positionTicks: 5 * 60 * 1000 * 10_000,
  runtimeTicks: 20 * 60 * 1000 * 10_000,
  isPaused: false,
  remoteEndpoint: "203.0.113.10",
};

/** Stubs `fetch` for `/api/auth/me` (always authenticated); anything else throws loudly. */
function mockAuthenticated(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/api/auth/me")) {
        return new Response(AUTHENTICATED_BODY, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`live.test.tsx did not expect a fetch to ${url}`);
    }),
  );
}

describe("Live route", () => {
  it("renders a card for each session the feed pushes", async () => {
    installFakeEventSource();
    mockAuthenticated();

    renderApp("/live");
    await screen.findByTestId("live-route");

    dispatchSessions(FakeEventSource.latest(), [SESSION_A]);

    expect(await screen.findByText("Sample Movie One")).toBeInTheDocument();
    expect(screen.getAllByTestId("active-stream-card")).toHaveLength(1);
  });

  it("shows the empty state when the feed reports no active sessions", async () => {
    installFakeEventSource();
    mockAuthenticated();

    renderApp("/live");
    await screen.findByTestId("live-route");

    dispatchSessions(FakeEventSource.latest(), []);

    expect(await screen.findByText("Nothing playing")).toBeInTheDocument();
    expect(screen.queryByTestId("active-stream-card")).not.toBeInTheDocument();
  });

  // Trap 3: proving the frozen-list failure mode is actually prevented, not
  // just that a `connected` boolean somewhere flipped. After the feed drops,
  // the UI must visibly say so — a hidden flag that never reaches anything
  // rendered would still fail this.
  it("on a dropped connection, visibly marks the screen disconnected instead of silently keeping the last snapshot looking live", async () => {
    installFakeEventSource();
    mockAuthenticated();

    renderApp("/live");
    await screen.findByTestId("live-route");
    const source = FakeEventSource.latest();

    dispatchSessions(source, [SESSION_A]);
    await screen.findByText("Sample Movie One");

    // Connected: the status pill says so, and the grid carries no
    // stale-data marker.
    expect(screen.getByTestId("live-connection-status")).toHaveAttribute("data-connected", "true");
    expect(screen.getByTestId("live-connection-status")).toHaveTextContent("Live");
    expect(screen.getByTestId("live-sessions-grid")).toHaveAttribute("data-connected", "true");

    source.dispatchEvent(new Event("error"));

    await waitFor(() =>
      expect(screen.getByTestId("live-connection-status")).toHaveAttribute(
        "data-connected",
        "false",
      ),
    );
    expect(screen.getByTestId("live-connection-status")).toHaveTextContent("Disconnected");
    // The last-known session is still shown (not blanked) ...
    expect(screen.getByText("Sample Movie One")).toBeInTheDocument();
    // ... but the grid itself now carries the same disconnected marker, so
    // nothing about the rendered output claims this is a live view.
    expect(screen.getByTestId("live-sessions-grid")).toHaveAttribute("data-connected", "false");
  });

  it("closes the EventSource when navigating away from /live", async () => {
    installFakeEventSource();
    mockAuthenticated();

    const router = renderApp("/live");
    await screen.findByTestId("live-route");
    const source = FakeEventSource.latest();
    expect(source.close).not.toHaveBeenCalled();

    await router.navigate({ to: "/login" });

    await waitFor(() => expect(source.close).toHaveBeenCalledTimes(1));
  });
});
