// @vitest-environment jsdom
//
// useLiveSessions is the one hook in this app driven by a push stream
// instead of a request/response — jsdom has no EventSource, so every test
// here drives a FakeEventSource (apps/web/src/test/fakeEventSource.ts)
// explicitly rather than relying on any timer or auto-fired event. See that
// file's doc comment for why a fake that dispatches on its own would make
// these assertions pass for the wrong reason.
import { renderHook, waitFor } from "@testing-library/react";
import type { LiveSession } from "@jfstats/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as unauthorized from "./unauthorized";
import { useLiveSessions } from "./useLiveSessions";
import { dispatchSessions, FakeEventSource, installFakeEventSource } from "../test/fakeEventSource";

afterEach(() => vi.restoreAllMocks());

// Synthetic — not a real Jellyfin session, item, or IP. 203.0.113.0/24 is the
// IANA TEST-NET-3 block reserved for documentation, never a routable address.
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
  positionTicks: 12_000_000_00,
  runtimeTicks: 72_000_000_00,
  isPaused: false,
  remoteEndpoint: "203.0.113.10",
};

const SESSION_B: LiveSession = {
  ...SESSION_A,
  sessionId: "session-bbbb",
  userName: "another-viewer",
  itemName: "Sample Movie Two",
};

/** Stubs `fetch` for `/api/auth/me` only; anything else throws loudly. */
function mockAuthMe(respond: () => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/auth/me")) return respond();
    throw new Error(`useLiveSessions.test.ts did not expect a fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("useLiveSessions", () => {
  it("opens exactly one EventSource against /api/live on mount", () => {
    installFakeEventSource();
    mockAuthMe(() => new Response("{}", { status: 200 }));

    renderHook(() => useLiveSessions());

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.latest().url).toBe("/api/live");
  });

  it("starts disconnected, with no sessions, before anything arrives", () => {
    installFakeEventSource();
    mockAuthMe(() => new Response("{}", { status: 200 }));

    const { result } = renderHook(() => useLiveSessions());

    expect(result.current.connected).toBe(false);
    expect(result.current.sessions).toEqual([]);
  });

  it("parses a sessions event into state and marks the feed connected", async () => {
    installFakeEventSource();
    mockAuthMe(() => new Response("{}", { status: 200 }));

    const { result } = renderHook(() => useLiveSessions());
    dispatchSessions(FakeEventSource.latest(), [SESSION_A, SESSION_B]);

    await waitFor(() => expect(result.current.sessions).toEqual([SESSION_A, SESSION_B]));
    expect(result.current.connected).toBe(true);
  });

  // Trap: a fake that ignores the event name, or a hook that wires up
  // `source.onmessage`/`addEventListener("message", ...)` instead of
  // `addEventListener("sessions", ...)`, would make a version of this test
  // that only asserts "state didn't change yet" pass for the wrong reason —
  // React applies a state update dispatched from outside its own event
  // system asynchronously, so checking too soon after the bad event can
  // "pass" simply because the (incorrect) update hadn't landed yet, not
  // because it was actually ignored. That's exactly why this test doesn't
  // stop at the wrongly-named event: it dispatches a second, genuinely-named
  // "sessions" event afterward and waits for *that* data to land, then
  // asserts the wrongly-named event's payload (SESSION_A) never made it into
  // state at all — only SESSION_B, from the real event, did. A hook that
  // reacted to "message" would show both (SESSION_A still present from the
  // first dispatch) or would show only SESSION_A (if it used `onmessage`,
  // which never fires for a named "sessions" event at all) — either way this
  // fails to reach the asserted end state.
  it("ignores an event under a different name, even carrying otherwise-valid session data", async () => {
    installFakeEventSource();
    mockAuthMe(() => new Response("{}", { status: 200 }));

    const { result } = renderHook(() => useLiveSessions());
    const source = FakeEventSource.latest();

    source.dispatchEvent(new MessageEvent("message", { data: JSON.stringify([SESSION_A]) }));
    dispatchSessions(source, [SESSION_B]);

    await waitFor(() => expect(result.current.sessions).toEqual([SESSION_B]));
    expect(result.current.sessions).not.toContainEqual(SESSION_A);
  });

  it("closes the EventSource on unmount", () => {
    installFakeEventSource();
    mockAuthMe(() => new Response("{}", { status: 200 }));

    const { unmount } = renderHook(() => useLiveSessions());
    const source = FakeEventSource.latest();
    expect(source.close).not.toHaveBeenCalled();

    unmount();

    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("goes disconnected on an error event, without discarding the last-known sessions", async () => {
    installFakeEventSource();
    mockAuthMe(() => new Response("{}", { status: 200 }));

    const { result } = renderHook(() => useLiveSessions());
    const source = FakeEventSource.latest();
    dispatchSessions(source, [SESSION_A]);
    await waitFor(() => expect(result.current.connected).toBe(true));

    source.dispatchEvent(new Event("error"));

    await waitFor(() => expect(result.current.connected).toBe(false));
    // The frozen-list failure mode this task's brief warns about is
    // preventing `connected` from silently staying true — not clearing the
    // list, which the route layer (routes/live.tsx) is responsible for
    // presenting as stale. Both are asserted independently here.
    expect(result.current.sessions).toEqual([SESSION_A]);
  });

  it("reconnecting (a fresh open event) clears the disconnected state again", async () => {
    installFakeEventSource();
    mockAuthMe(() => new Response("{}", { status: 200 }));

    const { result } = renderHook(() => useLiveSessions());
    const source = FakeEventSource.latest();
    dispatchSessions(source, [SESSION_A]);
    await waitFor(() => expect(result.current.connected).toBe(true));

    source.dispatchEvent(new Event("error"));
    await waitFor(() => expect(result.current.connected).toBe(false));

    source.dispatchEvent(new Event("open"));
    await waitFor(() => expect(result.current.connected).toBe(true));
  });

  describe("on error, the /api/auth/me probe", () => {
    it("notifies the shared unauthorized listener when the probe itself returns 401", async () => {
      installFakeEventSource();
      const notifySpy = vi.spyOn(unauthorized, "notifyUnauthorized");
      mockAuthMe(() => new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }));

      renderHook(() => useLiveSessions());
      FakeEventSource.latest().dispatchEvent(new Event("error"));

      await waitFor(() => expect(notifySpy).toHaveBeenCalledTimes(1));
    });

    it("does not notify when the probe succeeds — a transient stream drop, not an expired session", async () => {
      installFakeEventSource();
      const notifySpy = vi.spyOn(unauthorized, "notifyUnauthorized");
      const fetchMock = mockAuthMe(
        () =>
          new Response(JSON.stringify({ userId: "u", userName: "admin", isAdmin: true }), {
            status: 200,
          }),
      );

      renderHook(() => useLiveSessions());
      FakeEventSource.latest().dispatchEvent(new Event("error"));

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      // Give the resolved probe's .then() a tick to run before asserting the negative.
      await Promise.resolve();
      await Promise.resolve();
      expect(notifySpy).not.toHaveBeenCalled();
    });

    it("does not notify when the probe request itself fails to reach the server", async () => {
      installFakeEventSource();
      const notifySpy = vi.spyOn(unauthorized, "notifyUnauthorized");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("Failed to fetch");
        }),
      );

      renderHook(() => useLiveSessions());
      FakeEventSource.latest().dispatchEvent(new Event("error"));

      // Nothing to waitFor on a promise that only ever rejects into a no-op;
      // give the microtask queue a few turns instead.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(notifySpy).not.toHaveBeenCalled();
    });

    it("fires a fresh probe on every error event, not just the first", async () => {
      installFakeEventSource();
      const fetchMock = mockAuthMe(() => new Response("{}", { status: 200 }));

      renderHook(() => useLiveSessions());
      const source = FakeEventSource.latest();

      source.dispatchEvent(new Event("error"));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      source.dispatchEvent(new Event("error"));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });
  });
});
