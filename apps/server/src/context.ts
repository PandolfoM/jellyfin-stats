import { createDb, type Db } from "@jfstats/db";
import { createJellyfinClient, type JellyfinClient } from "@jfstats/jellyfin";
import type { AppEnv } from "@jfstats/shared";
import Redis from "ioredis";
import type pg from "pg";
import { createLogger, type Logger } from "./logger.js";
import { createSnapshotStore, type SnapshotStore } from "./sync/snapshot-store.js";

export interface AppContext {
  env: AppEnv;
  db: Db;
  pool: pg.Pool;
  redis: Redis;
  jellyfin: JellyfinClient;
  snapshots: SnapshotStore;
  logger: Logger;
}

export function createContext(env: AppEnv): AppContext {
  const { db, pool } = createDb(env.DATABASE_URL);
  // BullMQ requires this setting on its connections.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  return {
    env,
    db,
    pool,
    redis,
    jellyfin: createJellyfinClient({ baseUrl: env.JELLYFIN_URL, apiKey: env.JELLYFIN_API_KEY }),
    snapshots: createSnapshotStore(redis),
    logger: createLogger(env.LOG_LEVEL),
  };
}

export async function closeContext(context: AppContext): Promise<void> {
  await context.redis.quit();
  await context.pool.end();
}
