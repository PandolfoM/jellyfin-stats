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

/**
 * Routes an ioredis client's `error` events into the app logger.
 *
 * Not optional housekeeping: with no `error` listener at all, ioredis's
 * `silentEmit` falls back to `console.error("[ioredis] Unhandled error event:",
 * ...)`. That bypasses `LOG_LEVEL` *and* the redaction paths configured in
 * logger.ts, and `REDIS_URL` can carry a password. Exported so every client this
 * app opens — the shared one below, and each per-SSE `duplicate()` — goes through
 * the same wiring rather than each remembering to hand-roll it.
 */
export interface RedisErrorSource {
  on(event: "error", listener: (error: Error) => void): unknown;
}

export function attachRedisErrorLogger(
  redis: RedisErrorSource,
  logger: Pick<Logger, "error">,
  message = "redis connection error",
): void {
  redis.on("error", (error: Error) => {
    logger.error({ err: error }, message);
  });
}

export function createContext(env: AppEnv): AppContext {
  const { db, pool } = createDb(env.DATABASE_URL);
  // BullMQ requires this setting on its connections.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const logger = createLogger(env.LOG_LEVEL);

  // Attached here rather than in each entrypoint: the API and the worker share
  // this factory, and only one of them used to remember to do it.
  attachRedisErrorLogger(redis, logger);

  return {
    env,
    db,
    pool,
    redis,
    jellyfin: createJellyfinClient({ baseUrl: env.JELLYFIN_URL, apiKey: env.JELLYFIN_API_KEY }),
    snapshots: createSnapshotStore(),
    logger,
  };
}

export async function closeContext(context: AppContext): Promise<void> {
  await context.redis.quit();
  await context.pool.end();
}
