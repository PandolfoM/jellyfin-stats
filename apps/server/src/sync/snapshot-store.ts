import { EventEmitter } from "node:events";
import type { LiveSession, SessionSnapshot } from "@jfstats/shared";

export interface SnapshotStore {
  load(): Promise<SessionSnapshot>;
  save(snapshot: SessionSnapshot): Promise<void>;
  publish(sessions: LiveSession[]): Promise<void>;
  /**
   * The full LiveSession list from the most recent publish() — not the minimal
   * SessionSnapshot load() returns. Intended for a freshly-opened SSE stream, which
   * needs to render the current sessions immediately rather than wait for the next
   * poll's publish.
   */
  loadLive(): Promise<LiveSession[]>;
  /** Returns an unsubscribe function. Never throws. */
  subscribe(listener: (sessions: LiveSession[]) => void): () => void;
}

const LIVE_EVENT = "live";

/**
 * Held in memory. This was Redis-backed only because the poller and the HTTP
 * server were separate processes; in one process it is a plain object.
 *
 * Losing it on restart costs at most one poll interval of watch time: Postgres
 * remains the source of truth, and startup reconciliation repairs anything left
 * open. That was true of the Redis cache too — it carried a TTL and no
 * persistence guarantee.
 */
export function createSnapshotStore(): SnapshotStore {
  let snapshot: SessionSnapshot = {};
  let live: LiveSession[] = [];
  const emitter = new EventEmitter();
  // One listener per attached dashboard tab. The default cap of 10 would print
  // a spurious leak warning on the eleventh, and there is no leak here —
  // registerLiveRoute removes its listener on abort.
  emitter.setMaxListeners(0);

  return {
    async load() {
      return snapshot;
    },

    async save(next) {
      snapshot = next;
    },

    async publish(sessions) {
      // Cached before emitting: a subscriber attaching a moment later reads
      // this rather than waiting for the next poll.
      live = sessions;
      // EventEmitter rethrows a listener's error synchronously to the emitting
      // caller, which here is the poll loop — one broken dashboard tab would
      // fail the poll and stop capture for everyone. Each listener is isolated.
      for (const listener of emitter.listeners(LIVE_EVENT)) {
        try {
          (listener as (sessions: LiveSession[]) => void)(sessions);
        } catch {
          // A subscriber that throws is one misbehaving stream, not a reason to
          // drop the update for the others or to fail the poll.
        }
      }
    },

    async loadLive() {
      return live;
    },

    subscribe(listener) {
      emitter.on(LIVE_EVENT, listener);
      return () => {
        emitter.off(LIVE_EVENT, listener);
      };
    },
  };
}
