import type {
  applyRollupDelta as ApplyRollupDelta,
  closeSession as CloseSession,
  Db,
  findStaleOpenSessions as FindStaleOpenSessions,
} from "@jfstats/db";

export interface ReconcileDeps {
  db: Db;
  staleAfterMs: number;
  completionThreshold: number;
  now?: () => number;
  findStaleOpenSessions: typeof FindStaleOpenSessions;
  closeSession: typeof CloseSession;
  applyRollupDelta: typeof ApplyRollupDelta;
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Closes sessions left open by a crash or restart. Postgres is the source of truth,
 * so this runs at boot before any polling and repairs whatever the previous process
 * left behind.
 *
 * Returns the number of sessions that actually closed, which is not always the number
 * found stale: closeSession returns null when the row is no longer open.
 */
export async function reconcileOpenSessions(deps: ReconcileDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const cutoff = new Date(now - deps.staleAfterMs);
  const stale = await deps.findStaleOpenSessions(deps.db, cutoff);

  let repaired = 0;

  for (const session of stale) {
    const closed = await deps.closeSession(deps.db, {
      sessionId: session.sessionId,
      itemId: session.itemId,
      positionTicks: session.positionTicks,
      // Runtime is unknown here, so the session is never marked complete by
      // reconciliation — we are repairing a record, not inferring a viewing.
      runtimeTicks: null,
      watchedMs: 0,
      completionThreshold: deps.completionThreshold,
      at: session.lastSeenAt,
    });

    // Null means the row was already closed by someone else; counting it or writing a
    // rollup for it would invent a play. Only a close this call actually performed
    // gets a play written.
    if (closed === null) continue;

    repaired += 1;

    // Same rule as the applier's `ended` branch: a play only if the row accumulated
    // watch time before the crash. A stale row with none was churn — closed for
    // hygiene, but not a viewing, so nothing reaches the rollup.
    if (closed.watchMs <= 0) continue;

    // Closing the session in playback_sessions is only half the repair. Without this
    // the play never reaches playback_rollup_daily, and once the start day falls
    // outside the nightly recompute's trailing window — a worker down for over a week —
    // it never can. Keyed on the start day and carrying no watch time, exactly as the
    // applier's `ended` branch does, so the two paths stay in agreement.
    await deps.applyRollupDelta(deps.db, {
      day: utcDay(closed.startedAt),
      userId: closed.userId,
      itemId: closed.itemId,
      // libraryId omitted: applyRollupDelta resolves it from the items table.
      playCount: 1,
      // Reconciliation observed no playback — the watch time already on the row was
      // credited by earlier polls.
      watchMs: 0,
    });
  }

  return repaired;
}
