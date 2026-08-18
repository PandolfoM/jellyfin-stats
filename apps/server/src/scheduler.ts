import {
  applyRollupDelta,
  archiveMissingItems,
  closeSession,
  deleteExpiredRateLimits,
  deleteExpiredSessions,
  openSession,
  readJobRuns,
  recomputeRollupRange,
  touchSession,
  upsertDevice,
  upsertItems,
  upsertLibraries,
  upsertUsers,
  writeJobRun,
} from "@jfstats/db";
import type { AppEnv } from "@jfstats/shared";
import type { AppContext } from "./context.js";
import type { Logger } from "./logger.js";
import { runSessionPoll } from "./sync/applier.js";
import { runReferenceSync } from "./sync/reference-sync.js";
import { isDue, JOB_NAMES, type JobName, type Schedule } from "./sync/schedule.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLUP_LOOKBACK_DAYS = 7;

// A rate-limit window is 15 minutes (see apps/server/src/api/app.ts). 24 hours
// is comfortably longer than any window in use, so this never touches a row
// an in-progress login attempt still cares about, while still reclaiming
// stale keys within a day of the client that created them going quiet.
const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

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

    case "session-cleanup": {
      const at = new Date(now());
      const removedSessions = await deleteExpiredSessions(context.db, at);
      const removedRateLimits = await deleteExpiredRateLimits(
        context.db,
        new Date(at.getTime() - RATE_LIMIT_RETENTION_MS),
      );
      context.logger.debug(
        { removedSessions, removedRateLimits },
        "swept expired sessions and rate limits",
      );
      return;
    }

    default: {
      // Exhaustiveness guard: if JobName ever gains a variant without a case here,
      // this assignment fails to compile. Without it, an unrecognized job name would
      // fall through, handle() would return undefined, and the scheduler would mark
      // the job's tick complete having done nothing — worse than a loud failure,
      // because it would never reach the catch branch that logs it.
      const _exhaustive: never = name;
      throw new Error(`Unhandled job name: ${String(_exhaustive)}`);
    }
  }
}

/**
 * The concrete `JobName -> Schedule` mapping used in production. Exported
 * (rather than kept private) so scheduler.test.ts can assert the mapping
 * directly — every job name present, the two interval jobs reading their
 * millisecond values from env, and the three daily jobs landing on their
 * intended, mutually distinct hour/minute. Without that test this mapping
 * was reachable only through the untested `startScheduler`, so a transposed
 * hour or minute (e.g. rollup-recompute accidentally sharing item-sync's
 * 3:00 slot) would compile and pass the full suite undetected.
 */
export function buildSchedules(env: AppEnv): Record<JobName, Schedule> {
  return {
    "session-poll": { type: "interval", everyMs: env.SESSION_POLL_INTERVAL_MS },
    "reference-sync": { type: "interval", everyMs: env.REFERENCE_SYNC_INTERVAL_MS },
    "item-sync": { type: "daily", hour: 3, minute: 0 },
    "rollup-recompute": { type: "daily", hour: 3, minute: 30 },
    "session-cleanup": { type: "daily", hour: 4, minute: 0 },
  };
}

export interface SchedulerDeps {
  schedules: Record<JobName, Schedule>;
  runJob: (name: JobName) => Promise<void>;
  writeRun: (name: JobName, at: Date) => Promise<void>;
  logger: Pick<Logger, "error">;
  /**
   * Jobs currently in flight, keyed by name, holding the promise that settles
   * when the job (and its follow-up bookkeeping) is done. Doubles as the
   * overlap guard (`has(name)`) and as what `stop()` awaits before returning.
   */
  inFlight: Map<JobName, Promise<void>>;
}

/**
 * One tick: for every job that is due and not already running, kick it off.
 * Deliberately does not await job completion — it only awaits the dispatch
 * decision for each job, so a slow job never delays the next tick's read of
 * `readJobRuns`. The in-flight guard is what keeps that same slow job from
 * being started a second time by that next tick.
 *
 * On success, records `now` as the job's last-run time. On failure, logs and
 * leaves the stored timestamp untouched — a transient failure is retried on
 * the very next tick rather than waiting out a full interval or, for a daily
 * job, until the following day.
 */
export async function runDueJobs(
  deps: SchedulerDeps,
  runs: Map<string, Date>,
  now: number,
): Promise<void> {
  for (const name of JOB_NAMES) {
    if (deps.inFlight.has(name)) continue;

    const lastRunAt = runs.get(name);
    const due = isDue(deps.schedules[name], lastRunAt ? lastRunAt.getTime() : null, now);
    if (!due) continue;

    const run = deps
      .runJob(name)
      .then(() => deps.writeRun(name, new Date(now)))
      .catch((error: unknown) => {
        deps.logger.error({ err: error, job: name }, "scheduled job failed");
      })
      .finally(() => {
        deps.inFlight.delete(name);
      });

    deps.inFlight.set(name, run);
  }
}

export interface StartSchedulerOptions {
  now?: () => number;
  runJob?: (name: JobName) => Promise<void>;
  tickMs?: number;
  /** Overrides the `job_runs` read. Exists so scheduler.test.ts can drive the
   * timer and `stop()` without a real database — production always uses the
   * default, which reads `context.db`. */
  readRuns?: () => Promise<Map<string, Date>>;
  /** Overrides the `job_runs` write, for the same reason as `readRuns`. */
  writeRun?: (name: JobName, at: Date) => Promise<void>;
}

/**
 * Replaces BullMQ entirely: a single `setInterval` that polls `job_runs` and
 * dispatches whatever is due through `handle`. `options` exists so tests can
 * drive `runDueJobs` directly instead of going through this timer, or drive
 * the timer itself with `readRuns`/`writeRun`/`runJob` swapped out — see
 * scheduler.test.ts.
 */
export function startScheduler(
  context: AppContext,
  options: StartSchedulerOptions = {},
): { stop(): Promise<void> } {
  const now = options.now ?? Date.now;
  const runJob = options.runJob ?? ((name: JobName) => handle(context, name, now));
  const tickMs = options.tickMs ?? context.env.SESSION_POLL_INTERVAL_MS;
  const readRuns = options.readRuns ?? (() => readJobRuns(context.db));
  const writeRun = options.writeRun ?? ((name: JobName, at: Date) => writeJobRun(context.db, name, at));

  const deps: SchedulerDeps = {
    schedules: buildSchedules(context.env),
    runJob,
    writeRun,
    logger: context.logger,
    inFlight: new Map(),
  };

  const tick = async (): Promise<void> => {
    try {
      const runs = await readRuns();
      await runDueJobs(deps, runs, now());
    } catch (error) {
      context.logger.error({ err: error }, "scheduler tick failed");
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, tickMs);

  return {
    async stop(): Promise<void> {
      clearInterval(timer);
      await Promise.allSettled([...deps.inFlight.values()]);
    },
  };
}
