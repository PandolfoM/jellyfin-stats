import type { LiveSession, SessionSnapshot } from "@jfstats/shared";
import type Redis from "ioredis";

const SNAPSHOT_KEY = "jfstats:sessions:snapshot";
// Separate from SNAPSHOT_KEY: that key holds the reducer's minimal diff cache
// (SessionSnapshotEntry), which deliberately drops fields like userName and
// itemName. This key holds the full LiveSession list from the most recent
// publish(), so a client that just connected can be shown something real
// instead of a partial shape with the display fields missing.
const LIVE_CACHE_KEY = "jfstats:sessions:live:cache";
export const LIVE_CHANNEL = "jfstats:sessions:live";

export interface SnapshotStore {
  load(): Promise<SessionSnapshot>;
  save(snapshot: SessionSnapshot): Promise<void>;
  publish(sessions: LiveSession[]): Promise<void>;
  /**
   * The full LiveSession list from the most recent publish() — not the minimal
   * SessionSnapshot load() returns. Intended for a freshly-opened SSE stream, which
   * needs to render the current sessions immediately rather than wait for the next
   * poll's channel message.
   */
  loadLive(): Promise<LiveSession[]>;
}

/**
 * Redis holds the between-poll snapshot purely as a cache. Losing it costs at most
 * one poll interval of watch time, because Postgres remains the source of truth and
 * startup reconciliation repairs anything left open.
 */
export function createSnapshotStore(redis: Redis, ttlSeconds = 3600): SnapshotStore {
  return {
    async load() {
      const raw = await redis.get(SNAPSHOT_KEY);
      if (raw === null) return {};

      try {
        return JSON.parse(raw) as SessionSnapshot;
      } catch {
        // A corrupt cache must not stop playback capture.
        return {};
      }
    },

    async save(snapshot) {
      await redis.set(SNAPSHOT_KEY, JSON.stringify(snapshot), "EX", ttlSeconds);
    },

    async publish(sessions) {
      const payload = JSON.stringify(sessions);
      // The channel message reaches only clients already subscribed at publish time;
      // the cache is what lets a client that connects a moment later still see it.
      await Promise.all([
        redis.publish(LIVE_CHANNEL, payload),
        redis.set(LIVE_CACHE_KEY, payload, "EX", ttlSeconds),
      ]);
    },

    async loadLive() {
      const raw = await redis.get(LIVE_CACHE_KEY);
      if (raw === null) return [];

      try {
        return JSON.parse(raw) as LiveSession[];
      } catch {
        // A corrupt cache must not stop the stream from opening.
        return [];
      }
    },
  };
}
