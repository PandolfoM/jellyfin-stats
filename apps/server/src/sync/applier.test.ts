import type { LiveSession } from "@jfstats/shared";
import { describe, expect, it, vi } from "vitest";
import { applyEvents, type ApplierDeps } from "./applier.js";
import { snapshotKey } from "./diff.js";

const AT = new Date("2026-08-16T20:00:00Z");

function live(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    sessionId: "ps-1",
    userId: "user-1",
    userName: "alice",
    itemId: "item-1",
    itemName: "The Movie",
    deviceId: "device-1",
    deviceName: "Living Room TV",
    client: "Jellyfin Web",
    playMethod: "DirectPlay",
    positionTicks: 90,
    runtimeTicks: 100,
    isPaused: false,
    remoteEndpoint: "192.0.2.10",
    ...overrides,
  };
}

/** The row the database would return for the session under test. */
const ROW = { userId: "user-1", itemId: "item-1", startedAt: AT };

function deps(row: typeof ROW | null = ROW): ApplierDeps {
  return {
    db: {} as ApplierDeps["db"],
    completionThreshold: 0.9,
    openSession: vi.fn(async () => {}),
    touchSession: vi.fn(async () => row),
    closeSession: vi.fn(async () => row),
    applyRollupDelta: vi.fn(async () => {}),
    upsertDevice: vi.fn(async () => {}),
  };
}

describe("applyEvents", () => {
  it("opens a session and registers its device on started", async () => {
    const d = deps();
    const session = live();
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(d, [{ type: "started", key, session, at: AT.getTime() }], new Map([[key, session]]));

    expect(d.openSession).toHaveBeenCalledWith(d.db, expect.objectContaining({
      sessionId: "ps-1",
      itemId: "item-1",
      userId: "user-1",
      playMethod: "DirectPlay",
    }));
    expect(d.upsertDevice).toHaveBeenCalledWith(d.db, expect.objectContaining({ id: "device-1" }));
  });

  it("passes the session's true isPaused state through on started", async () => {
    // A stream can already be paused the very first time the pipeline observes it
    // (worker restart, or a pause within the first poll interval). openSession must
    // get the real value from the LiveSession, not silently default to false.
    const d = deps();
    const session = live({ isPaused: true });
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(d, [{ type: "started", key, session, at: AT.getTime() }], new Map([[key, session]]));

    expect(d.openSession).toHaveBeenCalledWith(d.db, expect.objectContaining({ isPaused: true }));
  });

  it("writes no rollup on started, because nothing has been watched yet", async () => {
    const d = deps();
    const session = live();
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(d, [{ type: "started", key, session, at: AT.getTime() }], new Map([[key, session]]));

    expect(d.applyRollupDelta).not.toHaveBeenCalled();
  });

  it("accumulates watch time and rolls it up on progressed", async () => {
    const d = deps();
    const session = live();
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(
      d,
      [{ type: "progressed", key, positionTicks: 50, watchedMs: 5_000, isPaused: false, at: AT.getTime() }],
      new Map([[key, session]]),
    );

    expect(d.touchSession).toHaveBeenCalledWith(d.db, expect.objectContaining({ watchedMs: 5_000, isPaused: false }));
    expect(d.applyRollupDelta).toHaveBeenCalledWith(d.db, expect.objectContaining({
      day: "2026-08-16",
      userId: "user-1",
      itemId: "item-1",
      playCount: 0,
      watchMs: 5_000,
    }));
  });

  it("skips the rollup write when no time was credited", async () => {
    const d = deps();
    const session = live();
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(
      d,
      [{ type: "progressed", key, positionTicks: 50, watchedMs: 0, isPaused: false, at: AT.getTime() }],
      new Map([[key, session]]),
    );

    // A paused stream polled every 5 seconds must not generate a write per poll.
    expect(d.applyRollupDelta).not.toHaveBeenCalled();
  });

  it("counts the play exactly once, on ended", async () => {
    const d = deps();
    const session = live();
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(
      d,
      [{ type: "ended", key, positionTicks: 95, watchedMs: 2_000, at: AT.getTime() }],
      new Map([[key, session]]),
    );

    expect(d.closeSession).toHaveBeenCalledWith(d.db, expect.objectContaining({
      runtimeTicks: 100,
      completionThreshold: 0.9,
    }));
    expect(d.applyRollupDelta).toHaveBeenCalledWith(d.db, expect.objectContaining({ playCount: 1, watchMs: 2_000 }));
  });

  it("counts the play even though the stream is already gone from the payload", async () => {
    const d = deps();
    const key = snapshotKey("ps-1", "item-1");

    // The stream vanished, so it is absent from the incoming payload — the common case,
    // and the reason the rollup must be driven by the returned row rather than the payload.
    await applyEvents(d, [{ type: "ended", key, positionTicks: 95, watchedMs: 2_000, at: AT.getTime() }], new Map());

    expect(d.closeSession).toHaveBeenCalledWith(d.db, expect.objectContaining({
      sessionId: "ps-1",
      itemId: "item-1",
      runtimeTicks: null,
    }));
    expect(d.applyRollupDelta).toHaveBeenCalledWith(d.db, expect.objectContaining({
      userId: "user-1",
      playCount: 1,
      watchMs: 2_000,
    }));
  });

  it("does not count the play again when the close finds no open row", async () => {
    const d = deps(null);
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(d, [{ type: "ended", key, positionTicks: 95, watchedMs: 2_000, at: AT.getTime() }], new Map());

    expect(d.applyRollupDelta).not.toHaveBeenCalled();
  });

  it("marks the session paused without crediting time", async () => {
    const d = deps();
    const session = live({ isPaused: true });
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(
      d,
      [{ type: "paused", key, positionTicks: 60, watchedMs: 5_000, isPaused: true, at: AT.getTime() }],
      new Map([[key, session]]),
    );

    expect(d.touchSession).toHaveBeenCalledWith(d.db, expect.objectContaining({ isPaused: true, watchedMs: 5_000 }));
  });

  it("writes isPaused: true for a progressed event on a stream still paused from a prior poll", async () => {
    // Before the fix, the applier inferred isPaused from the event *type* alone
    // (`event.type === "paused"`), so a "progressed" event — which is what a still-paused
    // stream produces on the second and later polls — was always written as isPaused:
    // false, even though the event itself now carries the real state.
    const d = deps();
    const session = live({ isPaused: true });
    const key = snapshotKey("ps-1", "item-1");

    await applyEvents(
      d,
      [{ type: "progressed", key, positionTicks: 60, watchedMs: 0, isPaused: true, at: AT.getTime() }],
      new Map([[key, session]]),
    );

    expect(d.touchSession).toHaveBeenCalledWith(d.db, expect.objectContaining({ isPaused: true }));
  });

  it("attributes watch time to the session's start day, not the poll day", async () => {
    // Session started at 23:55 on the 16th; this poll lands at 00:05 on the 17th.
    const startedAt = new Date("2026-08-16T23:55:00Z");
    const d = deps({ userId: "user-1", itemId: "item-1", startedAt });
    const session = live();
    const key = snapshotKey("ps-1", "item-1");
    const afterMidnight = new Date("2026-08-17T00:05:00Z").getTime();

    await applyEvents(
      d,
      [{ type: "progressed", key, positionTicks: 50, watchedMs: 5_000, isPaused: false, at: afterMidnight }],
      new Map([[key, session]]),
    );

    // recomputeRollupRange groups by started_at::date, so the incremental path must
    // agree or the nightly job would silently move this stream to a different day.
    expect(d.applyRollupDelta).toHaveBeenCalledWith(d.db, expect.objectContaining({ day: "2026-08-16" }));
  });
});
