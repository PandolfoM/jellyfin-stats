import { applyRollupDelta, closeSession, findStaleOpenSessions } from "@jfstats/db";
import { loadEnv } from "@jfstats/shared";
import { Queue, Worker } from "bullmq";
import { closeContext, createContext } from "./context.js";
import { handle } from "./scheduler.js";
import { createShutdownHandler } from "./shutdown.js";
import { reconcileOpenSessions } from "./sync/reconcile.js";
import type { JobName } from "./sync/schedule.js";

const QUEUE_NAME = "jfstats-sync";

async function main(): Promise<void> {
  const context = createContext(loadEnv());
  const { logger, env } = context;

  // The Redis `error` listener that used to be registered here now lives in
  // createContext (see attachRedisErrorLogger), so the API entrypoint — which
  // shares that factory but never had one — inherits it too. Registering a
  // second identical listener here would only log every error twice.

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

  const shutdown = createShutdownHandler({
    logger,
    exit: process.exit,
    startMessage: "worker shutting down",
    failureMessage: "worker shutdown failed",
    onShutdown: async () => {
      await worker.close();
      await queue.close();
      await closeContext(context);
    },
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Only run when invoked directly, so importing this module in tests is side-effect
// free — the same guard the seed script uses.
if (process.argv[1]?.endsWith("worker.ts")) {
  await main();
}
