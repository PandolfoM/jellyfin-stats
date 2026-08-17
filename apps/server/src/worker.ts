import {
  applyRollupDelta,
  archiveMissingItems,
  closeSession,
  findStaleOpenSessions,
  openSession,
  recomputeRollupRange,
  touchSession,
  upsertDevice,
  upsertItems,
  upsertLibraries,
  upsertUsers,
} from "@jfstats/db";
import { loadEnv } from "@jfstats/shared";
import { Queue, Worker } from "bullmq";
import { closeContext, createContext, type AppContext } from "./context.js";
import { runSessionPoll } from "./sync/applier.js";
import { reconcileOpenSessions } from "./sync/reconcile.js";
import { runReferenceSync } from "./sync/reference-sync.js";

const QUEUE_NAME = "jfstats-sync";

const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLUP_LOOKBACK_DAYS = 7;

export type JobName = "session-poll" | "reference-sync" | "item-sync" | "rollup-recompute";

/**
 * The range the nightly recompute rebuilds: the trailing 7 *whole* UTC days, ending at
 * (and excluding) the current UTC day. The day in progress is deliberately left out —
 * it is still being written incrementally, and rebuilding it from a partial set of
 * sessions would fight the applier rather than correct it.
 *
 * recomputeRollupRange floors `from` down and ceils `to` up to UTC day boundaries, so
 * both bounds must already sit on a day boundary here — otherwise floor+ceil silently
 * add an extra day to the window regardless of what time the cron fires.
 *
 * Takes `now` rather than reading the clock itself, matching every other
 * time-dependent function on this path (diffSessions, runSessionPoll,
 * reconcileOpenSessions, generateSeedData) and making the boundary behavior testable.
 */
export function rollupWindow(now: number): { from: Date; to: Date } {
  const to = new Date(new Date(now).toISOString().slice(0, 10));
  const from = new Date(to.getTime() - ROLLUP_LOOKBACK_DAYS * DAY_MS);
  return { from, to };
}

export async function handle(context: AppContext, name: JobName, now = Date.now): Promise<void> {
  switch (name) {
    case "session-poll":
      await runSessionPoll({
        db: context.db,
        jellyfin: context.jellyfin,
        snapshots: context.snapshots,
        completionThreshold: context.env.COMPLETION_THRESHOLD,
        maxWatchDeltaMs: context.env.maxWatchDeltaMs,
        openSession,
        touchSession,
        closeSession,
        applyRollupDelta,
        upsertDevice,
      });
      return;

    case "reference-sync":
    case "item-sync":
      await runReferenceSync({
        db: context.db,
        jellyfin: context.jellyfin,
        upsertUsers,
        upsertLibraries,
        upsertItems,
        archiveMissingItems,
        includeItems: name === "item-sync",
      });
      return;

    case "rollup-recompute": {
      const { from, to } = rollupWindow(now());
      await recomputeRollupRange(context.db, from, to);
      return;
    }

    default: {
      // Exhaustiveness guard: if JobName ever gains a variant without a case here,
      // this assignment fails to compile. Without it, an unrecognized job name would
      // fall through, handle() would return undefined, and BullMQ would mark the job
      // completed successfully having done nothing — worse than a loud failure,
      // because it never reaches the worker's "failed" handler.
      const _exhaustive: never = name;
      throw new Error(`Unhandled job name: ${String(_exhaustive)}`);
    }
  }
}

async function main(): Promise<void> {
  const context = createContext(loadEnv());
  const { logger, env } = context;

  // Registered before anything touches Redis. Without an `error` listener ioredis and
  // BullMQ fall back to console.error, which bypasses the configured level and — the
  // reason this matters — the redaction paths configured in logger.ts.
  context.redis.on("error", (error) => {
    logger.error({ err: error }, "redis connection error");
  });

  logger.info({ pollIntervalMs: env.SESSION_POLL_INTERVAL_MS }, "worker starting");

  const repaired = await reconcileOpenSessions({
    db: context.db,
    staleAfterMs: env.staleSessionAfterMs,
    completionThreshold: env.COMPLETION_THRESHOLD,
    findStaleOpenSessions,
    closeSession,
    applyRollupDelta,
  });
  logger.info({ repaired }, "startup reconciliation complete");

  const queue = new Queue(QUEUE_NAME, {
    connection: context.redis,
    // Without this, bullmq's getKeepJobs resolves both-undefined to { count: -1 } —
    // keep every finished job forever. At a 5s poll that is ~17,280 completed job
    // hashes a day accumulating in Redis, which runs with appendonly on a named volume
    // and so survives restarts: an out-of-memory event in months, after which the
    // pipeline stops with no obvious cause. Failures are kept far longer than
    // successes because they are the ones worth reading after the fact.
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 1000 },
  });

  queue.on("error", (error) => {
    logger.error({ err: error }, "queue error");
  });

  // Repeatable jobs are keyed by name, so re-registering on every boot replaces the
  // schedule rather than stacking duplicates.
  await queue.upsertJobScheduler("session-poll", { every: env.SESSION_POLL_INTERVAL_MS });
  await queue.upsertJobScheduler("reference-sync", { every: env.REFERENCE_SYNC_INTERVAL_MS });
  await queue.upsertJobScheduler("item-sync", { pattern: "0 3 * * *" });
  await queue.upsertJobScheduler("rollup-recompute", { pattern: "30 3 * * *" });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => handle(context, job.name as JobName),
    {
      connection: context.redis,
      // One poll at a time. Concurrent polls would diff against the same snapshot
      // and double-count the interval.
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error({ job: job?.name, err: error }, "sync job failed");
  });

  // "failed" covers a job that threw. "error" covers everything else BullMQ hits —
  // a lost connection, a Lua script failure — which would otherwise go to console.error.
  worker.on("error", (error) => {
    logger.error({ err: error }, "worker error");
  });

  const shutdown = async (): Promise<void> => {
    logger.info("worker shutting down");
    await worker.close();
    await queue.close();
    await closeContext(context);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

// Only run when invoked directly, so importing this module in tests is side-effect
// free — the same guard the seed script uses.
if (process.argv[1]?.endsWith("worker.ts")) {
  await main();
}
