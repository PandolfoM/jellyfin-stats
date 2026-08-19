import { randomBytes } from "node:crypto";
import { deleteSession, insertSession, selectLiveSession, type Db } from "@jfstats/db";

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

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createSessionStore(db: Db, ttlSeconds = DEFAULT_TTL_SECONDS): SessionStore {
  const ttlMs = ttlSeconds * 1000;

  return {
    async create(record) {
      // Random, not derived from the user — a guessable id would be a login bypass.
      const id = randomBytes(32).toString("base64url");
      const now = new Date();
      await insertSession(db, {
        id,
        userId: record.userId,
        userName: record.userName,
        isAdmin: record.isAdmin,
        createdAt: new Date(record.createdAt),
        expiresAt: new Date(now.getTime() + ttlMs),
      });
      return id;
    },

    async get(id) {
      const now = new Date();
      // Sliding expiry: an admin using the dashboard is not logged out mid-session.
      const row = await selectLiveSession(db, id, now, new Date(now.getTime() + ttlMs));
      if (row === null) return null;

      return {
        userId: row.userId,
        userName: row.userName,
        isAdmin: row.isAdmin,
        createdAt: row.createdAt.getTime(),
      };
    },

    async destroy(id) {
      await deleteSession(db, id);
    },
  };
}
