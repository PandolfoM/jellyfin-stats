import { randomBytes } from "node:crypto";
import type Redis from "ioredis";

export interface SessionRecord {
  userId: string;
  userName: string;
  isAdmin: boolean;
  createdAt: number;
}

export interface SessionStore {
  create(record: SessionRecord): Promise<string>;
  get(id: string): Promise<SessionRecord | null>;
  destroy(id: string): Promise<void>;
}

const PREFIX = "jfstats:session:";
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createSessionStore(redis: Redis, ttlSeconds = DEFAULT_TTL_SECONDS): SessionStore {
  return {
    async create(record) {
      // Random, not derived from the user — a guessable id would be a login bypass.
      const id = randomBytes(32).toString("base64url");
      await redis.set(`${PREFIX}${id}`, JSON.stringify(record), "EX", ttlSeconds);
      return id;
    },

    async get(id) {
      const raw = await redis.get(`${PREFIX}${id}`);
      if (raw === null) return null;

      try {
        const record = JSON.parse(raw) as SessionRecord;
        // Sliding expiry: an admin using the dashboard is not logged out mid-session.
        await redis.expire(`${PREFIX}${id}`, ttlSeconds);
        return record;
      } catch {
        return null;
      }
    },

    async destroy(id) {
      await redis.del(`${PREFIX}${id}`);
    },
  };
}
