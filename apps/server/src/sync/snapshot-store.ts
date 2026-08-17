import type { LiveSession, SessionSnapshot } from "@jfstats/shared";
import type Redis from "ioredis";

const SNAPSHOT_KEY = "jfstats:sessions:snapshot";
export const LIVE_CHANNEL = "jfstats:sessions:live";

export interface SnapshotStore {
  load(): Promise<SessionSnapshot>;
  save(snapshot: SessionSnapshot): Promise<void>;
  publish(sessions: LiveSession[]): Promise<void>;
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
      await redis.publish(LIVE_CHANNEL, JSON.stringify(sessions));
    },
  };
}
