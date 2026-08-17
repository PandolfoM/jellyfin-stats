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

type JobName = "session-poll" | "reference-sync" | "item-sync" | "rollup-recompute";

async function handle(context: AppContext, name: JobName): Promise<void> {
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
      // Trailing 7 days, per the spec's drift correction.
      const to = new Date();
      const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
      await recomputeRollupRange(context.db, from, to);
      return;
    }
  }
}

async function main(): Promise<void> {
  const context = createContext(loadEnv());
  const { logger, env } = context;

  logger.info({ pollIntervalMs: env.SESSION_POLL_INTERVAL_MS }, "worker starting");

  const repaired = await reconcileOpenSessions({
    db: context.db,
    staleAfterMs: env.staleSessionAfterMs,
    completionThreshold: env.COMPLETION_THRESHOLD,
    findStaleOpenSessions,
    closeSession,
  });
  logger.info({ repaired }, "startup reconciliation complete");

  const queue = new Queue(QUEUE_NAME, { connection: context.redis });

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

await main();
