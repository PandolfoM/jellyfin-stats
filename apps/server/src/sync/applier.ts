import type {
  applyRollupDelta as ApplyRollupDelta,
  closeSession as CloseSession,
  Db,
  openSession as OpenSession,
  touchSession as TouchSession,
  upsertDevice as UpsertDevice,
} from "@jfstats/db";
import type { JellyfinClient } from "@jfstats/jellyfin";
import type { LiveSession, SessionEvent } from "@jfstats/shared";
import { diffSessions, snapshotKey } from "./diff.js";
import type { SnapshotStore } from "./snapshot-store.js";

export interface ApplierDeps {
  db: Db;
  completionThreshold: number;
  openSession: typeof OpenSession;
  touchSession: typeof TouchSession;
  closeSession: typeof CloseSession;
  applyRollupDelta: typeof ApplyRollupDelta;
  upsertDevice: typeof UpsertDevice;
}

/**
 * Splits `${sessionId}:${itemId}` back into its parts. Splitting on the *last*
 * colon only inverts `snapshotKey` correctly because Jellyfin item ids never contain
 * a colon; a sessionId containing one is still handled correctly this way.
 */
function parseKey(key: string): { sessionId: string; itemId: string } {
  const separator = key.lastIndexOf(":");
  return { sessionId: key.slice(0, separator), itemId: key.slice(separator + 1) };
}

function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export async function applyEvents(
  deps: ApplierDeps,
  events: SessionEvent[],
  liveByKey: Map<string, LiveSession>,
): Promise<void> {
  for (const event of events) {
    const { sessionId, itemId } = parseKey(event.key);
    const live = liveByKey.get(event.key);
    const at = new Date(event.at);

    switch (event.type) {
      case "started": {
        await deps.upsertDevice(deps.db, {
          id: event.session.deviceId,
          name: event.session.deviceName,
          client: event.session.client,
          lastSeenAt: at,
        });
        await deps.openSession(deps.db, {
          sessionId,
          itemId,
          userId: event.session.userId,
          deviceId: event.session.deviceId,
          client: event.session.client,
          playMethod: event.session.playMethod,
          positionTicks: event.session.positionTicks,
          isPaused: event.session.isPaused,
          remoteEndpoint: event.session.remoteEndpoint,
          at,
        });
        // No rollup here: the play is counted once, when the session ends.
        break;
      }

      case "resumed": {
        await deps.touchSession(deps.db, {
          sessionId,
          itemId,
          positionTicks: event.positionTicks,
          watchedMs: 0,
          isPaused: false,
          at,
        });
        break;
      }

      case "progressed":
      case "paused": {
        const touched = await deps.touchSession(deps.db, {
          sessionId,
          itemId,
          positionTicks: event.positionTicks,
          watchedMs: event.watchedMs,
          isPaused: event.isPaused,
          at,
        });

        if (event.watchedMs > 0 && touched) {
          await deps.applyRollupDelta(deps.db, {
            // Keyed on the session's start day, matching how recomputeRollupRange
            // groups. Using the poll day instead would split a stream that crosses
            // midnight and put the two paths permanently out of agreement.
            day: utcDay(touched.startedAt.getTime()),
            userId: touched.userId,
            itemId,
            // libraryId omitted: applyRollupDelta resolves it from the items table.
            playCount: 0,
            watchMs: event.watchedMs,
          });
        }
        break;
      }

      case "ended": {
        const closed = await deps.closeSession(deps.db, {
          sessionId,
          itemId,
          positionTicks: event.positionTicks,
          // The stream is usually already absent from the payload by the time it ends,
          // so runtime is unknown and the session is simply not marked complete.
          runtimeTicks: live?.runtimeTicks ?? null,
          watchedMs: event.watchedMs,
          completionThreshold: deps.completionThreshold,
          at,
        });

        // closeSession returns null if the row was already closed, which is what keeps
        // a replayed end from counting the play twice.
        //
        // The play is credited on the row's *total* watch time, not this event's
        // delta: a session that flapped out of /Sessions and back closes with zero
        // watch time and is churn, not a viewing — getHistory already omits it, and
        // counting it here is what made the dashboards' play counts read higher
        // than history. When there is neither a play nor time to add, no delta is
        // written at all, so no all-zero rollup row appears to mark the user active.
        if (closed) {
          const playCount = closed.watchMs > 0 ? 1 : 0;
          if (playCount > 0 || event.watchedMs > 0) {
            await deps.applyRollupDelta(deps.db, {
              day: utcDay(closed.startedAt.getTime()),
              userId: closed.userId,
              itemId,
              // libraryId omitted: applyRollupDelta resolves it from the items table.
              playCount,
              watchMs: event.watchedMs,
            });
          }
        }
        break;
      }

      default: {
        // Exhaustiveness guard: if a new SessionEvent variant is ever added without a
        // case here, this assignment fails to compile instead of the event silently
        // falling through with no database write.
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }
}

export interface PollDeps extends ApplierDeps {
  jellyfin: JellyfinClient;
  snapshots: SnapshotStore;
  maxWatchDeltaMs: number;
  now?: () => number;
}

export async function runSessionPoll(deps: PollDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const incoming = await deps.jellyfin.getSessions();
  const previous = await deps.snapshots.load();

  const { events, snapshot } = diffSessions(previous, incoming, {
    now,
    maxWatchDeltaMs: deps.maxWatchDeltaMs,
  });

  const liveByKey = new Map(
    incoming.map((session) => [snapshotKey(session.sessionId, session.itemId), session]),
  );

  await applyEvents(deps, events, liveByKey);

  // Snapshot is saved only after the writes land, so a crash mid-apply replays the
  // same interval rather than skipping it.
  await deps.snapshots.save(snapshot);
  await deps.snapshots.publish(incoming);
}
