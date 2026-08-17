import type { LiveSession, SessionSnapshot } from "@jfstats/shared";
import { describe, expect, it } from "vitest";
import { diffSessions, snapshotKey } from "./diff.js";

const T0 = 1_700_000_000_000;
const OPTIONS = { now: T0 + 5_000, maxWatchDeltaMs: 7_500 };

function session(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    playSessionId: "ps-1",
    userId: "user-1",
    userName: "alice",
    itemId: "item-1",
    itemName: "The Movie",
    deviceId: "device-1",
    deviceName: "Living Room TV",
    client: "Jellyfin Web",
    playMethod: "DirectPlay",
    positionTicks: 10_000_000,
    runtimeTicks: 60_000_000_000,
    isPaused: false,
    remoteEndpoint: "10.0.0.5",
    ...overrides,
  };
}

function snapshotOf(
  live: LiveSession,
  overrides: { observedAt?: number; isPaused?: boolean; positionTicks?: number } = {},
): SessionSnapshot {
  const key = snapshotKey(live.playSessionId, live.itemId);
  return {
    [key]: {
      playSessionId: live.playSessionId,
      itemId: live.itemId,
      positionTicks: overrides.positionTicks ?? live.positionTicks,
      isPaused: overrides.isPaused ?? live.isPaused,
      observedAt: overrides.observedAt ?? T0,
    },
  };
}

describe("diffSessions", () => {
  it("emits started for a stream it has not seen before", () => {
    const live = session();
    const { events, snapshot } = diffSessions({}, [live], OPTIONS);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "started", key: snapshotKey("ps-1", "item-1") });
    expect(snapshot[snapshotKey("ps-1", "item-1")]?.observedAt).toBe(OPTIONS.now);
  });

  it("credits no watch time on the first observation", () => {
    const { events } = diffSessions({}, [session()], OPTIONS);
    const started = events[0];

    expect(started?.type).toBe("started");
    // A "started" event carries no watchedMs at all — there is no prior observation
    // to measure from, so there is nothing to credit.
    expect(started && "watchedMs" in started).toBe(false);
  });

  it("credits elapsed wall-clock time while playing", () => {
    const live = session();
    const { events } = diffSessions(snapshotOf(live), [live], OPTIONS);

    expect(events[0]).toMatchObject({ type: "progressed", watchedMs: 5_000 });
  });

  it("clamps the credit to maxWatchDeltaMs when the worker stalls", () => {
    const live = session();
    // Worker was asleep for an hour; only 7.5s may be credited.
    const { events } = diffSessions(snapshotOf(live), [live], {
      now: T0 + 3_600_000,
      maxWatchDeltaMs: 7_500,
    });

    expect(events[0]).toMatchObject({ type: "progressed", watchedMs: 7_500 });
  });

  it("credits zero when the clock jumps backwards", () => {
    const live = session();
    const { events } = diffSessions(snapshotOf(live), [live], {
      now: T0 - 60_000,
      maxWatchDeltaMs: 7_500,
    });

    expect(events[0]).toMatchObject({ type: "progressed", watchedMs: 0 });
  });

  it("credits nothing while a stream stays paused", () => {
    const live = session({ isPaused: true });
    const { events } = diffSessions(snapshotOf(live, { isPaused: true }), [live], OPTIONS);

    expect(events[0]).toMatchObject({ type: "progressed", watchedMs: 0 });
  });

  it("emits paused and credits the time played before the pause", () => {
    const previous = session();
    const live = session({ isPaused: true });
    const { events } = diffSessions(snapshotOf(previous, { isPaused: false }), [live], OPTIONS);

    expect(events[0]).toMatchObject({ type: "paused", watchedMs: 5_000 });
  });

  it("emits resumed with no watch time for the paused interval", () => {
    const live = session({ isPaused: false });
    const { events } = diffSessions(snapshotOf(live, { isPaused: true }), [live], OPTIONS);

    const resumed = events[0];
    expect(resumed?.type).toBe("resumed");
    expect(resumed && "watchedMs" in resumed).toBe(false);
  });

  it("credits wall-clock time even when the user seeks backwards", () => {
    const live = session({ positionTicks: 1_000_000 });
    const previous = snapshotOf(session(), { positionTicks: 500_000_000 });
    const { events } = diffSessions(previous, [live], OPTIONS);

    // Position went backwards; watch time is wall-clock so it is unaffected.
    expect(events[0]).toMatchObject({ type: "progressed", watchedMs: 5_000 });
  });

  it("emits ended for a stream that disappeared, crediting its final delta", () => {
    const previous = snapshotOf(session(), { isPaused: false });
    const { events, snapshot } = diffSessions(previous, [], OPTIONS);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "ended", watchedMs: 5_000 });
    expect(snapshot).toEqual({});
  });

  it("credits no final delta when the stream was paused when last seen", () => {
    const previous = snapshotOf(session(), { isPaused: true });
    const { events } = diffSessions(previous, [], OPTIONS);

    expect(events[0]).toMatchObject({ type: "ended", watchedMs: 0 });
  });

  it("treats an item change under one play session as end-then-start", () => {
    const previous = snapshotOf(session({ itemId: "episode-1" }));
    const live = session({ itemId: "episode-2" });
    const { events } = diffSessions(previous, [live], OPTIONS);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "ended", key: snapshotKey("ps-1", "episode-1") });
    expect(events[1]).toMatchObject({ type: "started", key: snapshotKey("ps-1", "episode-2") });
  });

  it("is idempotent when the identical payload is replayed at the same instant", () => {
    const live = session();
    const first = diffSessions({}, [live], OPTIONS);
    const second = diffSessions(first.snapshot, [live], OPTIONS);

    expect(second.events).toEqual([{ type: "progressed", key: snapshotKey("ps-1", "item-1"), positionTicks: live.positionTicks, watchedMs: 0, at: OPTIONS.now }]);
    expect(second.snapshot).toEqual(first.snapshot);
  });

  it("handles several concurrent streams independently", () => {
    const a = session({ playSessionId: "ps-a", itemId: "item-a" });
    const b = session({ playSessionId: "ps-b", itemId: "item-b" });
    const previous = { ...snapshotOf(a), ...snapshotOf(b) };

    const { events } = diffSessions(previous, [a], OPTIONS);

    expect(events).toHaveLength(2);
    expect(events.find((e) => e.key === snapshotKey("ps-a", "item-a"))?.type).toBe("progressed");
    expect(events.find((e) => e.key === snapshotKey("ps-b", "item-b"))?.type).toBe("ended");
  });

  it("ignores a session Jellyfin reports without a play session id", () => {
    const live = session({ playSessionId: "" });
    const { events, snapshot } = diffSessions({}, [live], OPTIONS);

    expect(events).toEqual([]);
    expect(snapshot).toEqual({});
  });
});
