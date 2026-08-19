import { createDb, type Db } from "@jfstats/db";
import { createJellyfinClient, type JellyfinClient } from "@jfstats/jellyfin";
import type { AppEnv } from "@jfstats/shared";
import type pg from "pg";
import { createLogger, type Logger } from "./logger.js";
import { createSnapshotStore, type SnapshotStore } from "./sync/snapshot-store.js";

export interface AppContext {
  env: AppEnv;
  db: Db;
  pool: pg.Pool;
  jellyfin: JellyfinClient;
  snapshots: SnapshotStore;
  logger: Logger;
}

export function createContext(env: AppEnv): AppContext {
  const { db, pool } = createDb(env.DATABASE_URL);
  const logger = createLogger(env.LOG_LEVEL);

  return {
    env,
    db,
    pool,
    jellyfin: createJellyfinClient({ baseUrl: env.JELLYFIN_URL, apiKey: env.JELLYFIN_API_KEY }),
    snapshots: createSnapshotStore(),
    logger,
  };
}

export async function closeContext(context: AppContext): Promise<void> {
  await context.pool.end();
}
