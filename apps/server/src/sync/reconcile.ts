import type {
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
}

/**
 * Closes sessions left open by a crash or restart. Postgres is the source of truth,
 * so this runs at boot before any polling and repairs whatever the previous process
 * left behind.
 */
export async function reconcileOpenSessions(deps: ReconcileDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const cutoff = new Date(now - deps.staleAfterMs);
  const stale = await deps.findStaleOpenSessions(deps.db, cutoff);

  for (const session of stale) {
    await deps.closeSession(deps.db, {
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
  }

  return stale.length;
}
