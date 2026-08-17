import { describe, expect, it, vi } from "vitest";
import { reconcileOpenSessions, type ReconcileDeps } from "./reconcile.js";

const NOW = new Date("2026-08-16T20:00:00Z").getTime();

/**
 * The day the repaired stream *started*, deliberately a different UTC day from the
 * lastSeenAt values used below. Rollups are keyed on the start day, so a test whose
 * two dates fall on the same day could not tell the two apart.
 */
const STARTED_AT = new Date("2026-08-15T23:30:00Z");

type Stale = Awaited<ReturnType<ReconcileDeps["findStaleOpenSessions"]>>;

function deps(stale: Stale, overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    db: {} as ReconcileDeps["db"],
    staleAfterMs: 10_000,
    completionThreshold: 0.9,
    now: () => NOW,
    findStaleOpenSessions: vi.fn(async () => stale),
    // The default stands in for a row that really was open and really did close:
    // closeSession returns the row it updated. Tests that need the already-closed
    // case override this with a mock returning null.
    closeSession: vi.fn(async (_db, input) => ({
      userId: "user-1",
      itemId: input.itemId,
      startedAt: STARTED_AT,
    })),
    applyRollupDelta: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("reconcileOpenSessions", () => {
  it("closes a session left open by a crash, at the time it was last seen", async () => {
    const lastSeenAt = new Date(NOW - 60_000);
    const d = deps([
      { sessionId: "ps-1", itemId: "item-1", userId: "user-1", positionTicks: 42, lastSeenAt },
    ]);

    const closed = await reconcileOpenSessions(d);

    expect(closed).toBe(1);
    expect(d.closeSession).toHaveBeenCalledWith(d.db, expect.objectContaining({
      sessionId: "ps-1",
      itemId: "item-1",
      // Ending at lastSeenAt, not now, keeps the record honest — we have no evidence
      // playback continued past the last observation.
      at: lastSeenAt,
      watchedMs: 0,
      runtimeTicks: null,
    }));
  });

  it("queries using the stale cutoff derived from the poll interval", async () => {
    const d = deps([]);
    await reconcileOpenSessions(d);

    expect(d.findStaleOpenSessions).toHaveBeenCalledWith(d.db, new Date(NOW - 10_000));
  });

  it("does nothing when no sessions are stale", async () => {
    const d = deps([]);

    expect(await reconcileOpenSessions(d)).toBe(0);
    expect(d.closeSession).not.toHaveBeenCalled();
    expect(d.applyRollupDelta).not.toHaveBeenCalled();
  });

  it("credits no extra watch time when closing a stale session", async () => {
    const d = deps([
      { sessionId: "ps-1", itemId: "item-1", userId: "user-1", positionTicks: 42, lastSeenAt: new Date(NOW - 3_600_000) },
    ]);

    await reconcileOpenSessions(d);

    // An hour passed with the worker down; none of it was observed playback.
    expect(d.closeSession).toHaveBeenCalledWith(d.db, expect.objectContaining({ watchedMs: 0 }));
  });

  it("writes the play to the rollup, keyed on the session's start day", async () => {
    const d = deps([
      {
        sessionId: "ps-1",
        itemId: "item-1",
        userId: "user-1",
        positionTicks: 42,
        // Last seen on the 16th, but the stream started late on the 15th.
        lastSeenAt: new Date("2026-08-16T00:30:00Z"),
      },
    ]);

    await reconcileOpenSessions(d);

    // Without this, a session repaired at startup is closed in playback_sessions but
    // its play never reaches playback_rollup_daily — permanently, once the start day
    // falls outside the nightly recompute's trailing window.
    expect(d.applyRollupDelta).toHaveBeenCalledWith(d.db, {
      day: "2026-08-15",
      userId: "user-1",
      itemId: "item-1",
      playCount: 1,
      // Reconciliation observed no playback, so it adds no watch time — only the play
      // that closeSession just recorded.
      watchMs: 0,
    });
  });

  it("writes one rollup delta per repaired session", async () => {
    const lastSeenAt = new Date(NOW - 60_000);
    const d = deps([
      { sessionId: "ps-1", itemId: "item-1", userId: "user-1", positionTicks: 1, lastSeenAt },
      { sessionId: "ps-2", itemId: "item-2", userId: "user-1", positionTicks: 2, lastSeenAt },
    ]);

    expect(await reconcileOpenSessions(d)).toBe(2);
    expect(d.applyRollupDelta).toHaveBeenCalledTimes(2);
  });

  it("writes no rollup and counts nothing when the row was already closed", async () => {
    const d = deps(
      [
        {
          sessionId: "ps-1",
          itemId: "item-1",
          userId: "user-1",
          positionTicks: 42,
          lastSeenAt: new Date(NOW - 60_000),
        },
      ],
      // closeSession returns null when the row is no longer open — another process
      // closed it between the query and the update. Counting it, or writing a rollup
      // for it, would invent a play that never happened.
      { closeSession: vi.fn(async () => null) },
    );

    expect(await reconcileOpenSessions(d)).toBe(0);
    expect(d.applyRollupDelta).not.toHaveBeenCalled();
  });
});
