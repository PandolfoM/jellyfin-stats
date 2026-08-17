import { describe, expect, it, vi } from "vitest";
import { reconcileOpenSessions, type ReconcileDeps } from "./reconcile.js";

const NOW = new Date("2026-08-16T20:00:00Z").getTime();

function deps(stale: Awaited<ReturnType<ReconcileDeps["findStaleOpenSessions"]>>): ReconcileDeps {
  return {
    db: {} as ReconcileDeps["db"],
    staleAfterMs: 10_000,
    completionThreshold: 0.9,
    now: () => NOW,
    findStaleOpenSessions: vi.fn(async () => stale),
    closeSession: vi.fn(async () => null),
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
  });

  it("credits no extra watch time when closing a stale session", async () => {
    const d = deps([
      { sessionId: "ps-1", itemId: "item-1", userId: "user-1", positionTicks: 42, lastSeenAt: new Date(NOW - 3_600_000) },
    ]);

    await reconcileOpenSessions(d);

    // An hour passed with the worker down; none of it was observed playback.
    expect(d.closeSession).toHaveBeenCalledWith(d.db, expect.objectContaining({ watchedMs: 0 }));
  });
});
