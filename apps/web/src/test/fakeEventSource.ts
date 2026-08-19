import type { LiveSession } from "@jfstats/shared";
import { vi } from "vitest";

/**
 * A minimal, controllable stand-in for the browser's `EventSource` — jsdom
 * implements no such global, so `useLiveSessions` (api/useLiveSessions.ts)
 * and anything that renders it (routes/live.test.tsx) need something to
 * install in its place.
 *
 * Deliberately does **not** dispatch anything on construction or on its own
 * timer. Every event a test wants the hook to observe must be dispatched
 * explicitly via `instance.dispatchEvent(new MessageEvent(...))` — exactly
 * like a real `EventSource`, which only ever fires in reaction to something
 * the network actually delivered. A fake that auto-fired a `sessions` event
 * synchronously on construction would let a hook that never wired up its own
 * `addEventListener("sessions", ...)` pass anyway (e.g. one that just reads
 * `event.data` from whatever fires first) — see useLiveSessions.test.ts's
 * "ignores an event under a different name" test, which only means anything
 * because this fake stays silent until told to speak.
 *
 * `close` is a `vi.fn()`, not a plain no-op, so tests can assert it was
 * actually called — the operational requirement this task's brief calls out
 * as mattering most: an `EventSource` left open past unmount leaks a
 * server-side live-event listener, one per abandoned tab.
 */
export class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly close = vi.fn();

  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }

  /** The most recently constructed instance — the one a hook under test just opened. */
  static latest(): FakeEventSource {
    const instance = FakeEventSource.instances.at(-1);
    if (instance === undefined) {
      throw new Error("No FakeEventSource has been constructed yet");
    }
    return instance;
  }
}

/**
 * Installs `FakeEventSource` as `globalThis.EventSource` and resets its
 * instance registry. Call once per test (or in `beforeEach`); the global
 * afterEach(() => vi.restoreAllMocks()) convention this repo already uses in
 * every test file undoes `vi.stubGlobal` too, so nothing here needs its own
 * teardown.
 */
export function installFakeEventSource(): typeof FakeEventSource {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  return FakeEventSource;
}

/**
 * Dispatches a `sessions` event carrying `sessions` as its JSON payload —
 * the one shape `GET /api/live` ever sends (apps/server/src/api/routes/live.ts).
 * Shared by useLiveSessions.test.ts and routes/live.test.tsx so the "how do I
 * simulate the server pushing a snapshot" shape lives in one place, next to
 * the fake it's built for.
 */
export function dispatchSessions(source: FakeEventSource, sessions: LiveSession[]): void {
  source.dispatchEvent(new MessageEvent("sessions", { data: JSON.stringify(sessions) }));
}
