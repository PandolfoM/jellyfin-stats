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

// How long to wait before retrying a job that just failed, measured from the start of
// the failed attempt. Applies to every job except the ones in FAST_RETRY_JOBS.
//
// Without this, a failing job retries on literally the next tick forever: writeRun is
// skipped on failure so lastRunAt never advances, and isDue keeps comparing `now`
// against that same stale timestamp, so once a job becomes due it stays "due" on every
// tick until it finally succeeds. For reference-sync (a 15-minute interval) that turns
// a sustained Jellyfin outage into a retry every scheduler tick (5s by default) instead
// of every 15 minutes — 180x the intended rate. For item-sync (once a day, a full
// library enumeration) it is worse: back-to-back retries as fast as each one completes.
// BullMQ never had this problem because a failed repeatable job simply waited for its
// next scheduled occurrence; this restores that property without reintroducing a queue.
//
// Five minutes is a fixed, deliberately simple floor rather than a per-job value tied to
// each job's own interval: reusing reference-sync's 15-minute interval as its own
// backoff would match BullMQ exactly, but applying that same idea to the daily jobs
// would mean waiting a full day to retry a failure discovered at, say, 3:05am — far
// too slow to recover same-day once Jellyfin comes back. One floor shared by every
// non-fast-retry job is simple to reason about and bounds retries to a sane rate
// (12/hour, worst case) regardless of the job's normal cadence.
export const FAILURE_BACKOFF_MS = 5 * 60 * 1000;

// session-poll is deliberately excluded from FAILURE_BACKOFF_MS: it is cheap (one
// Jellyfin request), already the fastest-scheduled job, and its own README-documented
// operator story ("job_runs.last_run_at should move forward every SESSION_POLL_INTERVAL_MS")
// depends on it retrying on the very next tick during a brief outage rather than going
// quiet for five minutes. The other four jobs are not on that same fast, cheap footing.
const FAST_RETRY_JOBS: ReadonlySet<JobName> = new Set(["session-poll"]);

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
   * when the job (and its follow-up bookkeeping) is done. `stop()` awaits
   * every entry before returning. Also the concurrency guard: `runDueJobs`
   * treats *any* non-empty `inFlight` as "something is already running" and
   * will not start a second job alongside it — see the comment at that check.
   */
  inFlight: Map<JobName, Promise<void>>;
  /**
   * When each job's most recent *attempt* (successful or not) started, keyed by
   * name. Distinct from `runs`/`job_runs`, which only ever records a
   * *successful* completion: this is what lets a failed job be recognized as
   * "recently tried" even though it never got to write one. Consulted only for
   * jobs outside FAST_RETRY_JOBS, to enforce FAILURE_BACKOFF_MS.
   */
  lastAttemptAt: Map<JobName, number>;
  /**
   * Rotating offset into JOB_NAMES, advanced by one (mod JOB_NAMES.length) at the
   * start of every `runDueJobs` call regardless of what ran. This is what stops a
   * continuously-failing, fast-retry job from starving every other job of even
   * being due-checked: `session-poll` is first in JOB_NAMES, is exempt from
   * FAILURE_BACKOFF_MS, and never advances `lastRunAt` while it keeps failing, so
   * a fixed iteration order would win the single global concurrency slot on
   * literally every tick, forever, during a sustained Jellyfin outage — the other
   * four jobs would never be reached, since the loop breaks the instant something
   * is in flight. Rotating which job is checked first guarantees every job leads
   * the check at least once every JOB_NAMES.length ticks, so a due job is
   * dispatched within that many ticks regardless of which other job is failing.
   */
  startIndex: number;
}

/**
 * `JOB_NAMES` rotated to start at `startIndex`, wrapping around. `((n % len) +
 * len) % len` rather than a bare `%` guards against a negative `startIndex`,
 * which never occurs on the increment-by-one path below but would otherwise be
 * a silent footgun for a caller constructing one directly (as tests do).
 */
export function rotatedJobNames(startIndex: number): readonly JobName[] {
  const offset = ((startIndex % JOB_NAMES.length) + JOB_NAMES.length) % JOB_NAMES.length;
  return [...JOB_NAMES.slice(offset), ...JOB_NAMES.slice(0, offset)];
}

/**
 * One tick: if nothing is currently running, start the first due, not-recently-
 * attempted job in this tick's *rotated* job order, then stop — see the
 * concurrency comment below for why this is "the first job", not "every due
 * job", and the `startIndex` doc comment on `SchedulerDeps` for why the order
 * rotates instead of always starting at `JOB_NAMES[0]`.
 *
 * Deliberately does not await job completion — it only awaits the dispatch
 * decision, so a slow job never delays the next tick's read of
 * `readJobRuns`. `inFlight` is what keeps that same slow job (or any other)
 * from being started a second time by a later tick while it is still running.
 *
 * On success, records `now` as the job's last-run time and clears its backoff
 * bookkeeping. On failure, logs and leaves `job_runs` untouched — an unfilled
 * `lastRunAt` is what makes the job "due" again, so failure is retried rather
 * than waiting out a full interval or, for a daily job, until the following
 * day. `lastAttemptAt`, updated on every attempt regardless of outcome, is
 * what throttles *how soon* — see FAILURE_BACKOFF_MS.
 */
export async function runDueJobs(
  deps: SchedulerDeps,
  runs: Map<string, Date>,
  now: number,
): Promise<void> {
  // Advance the rotation once per call, unconditionally — even a tick that
  // dispatches nothing (or errors) still moves on, so a stuck rotation can
  // never re-favor the same job indefinitely.
  const order = rotatedJobNames(deps.startIndex);
  deps.startIndex = (deps.startIndex + 1) % JOB_NAMES.length;

  for (const name of order) {
    // Global concurrency of 1, matching BullMQ's `concurrency: 1` (the setting this
    // scheduler replaced) rather than one slot per job name. Two concrete reasons this
    // is not merely conservative: reference-sync (15 min) and item-sync (daily) both
    // call runReferenceSync and co-fire on the same tick roughly once a day, running
    // two concurrent upsert batches against the same rows; and rollup-recompute
    // (DELETE-then-INSERT over the trailing week, in one transaction) can interleave
    // with a concurrent session-poll's applyRollupDelta UPSERT into that same window —
    // verified against recomputeRollupRange's plain INSERT (no ON CONFLICT) in
    // packages/db/src/repositories/playback.ts: a concurrent upsert landing between the
    // DELETE and the INSERT collides on the same (day, user, item) key and aborts the
    // whole recompute transaction on a duplicate-key error, which then retries every
    // FAILURE_BACKOFF_MS (or every tick, pre-backoff) instead of once a night. A long
    // job (item-sync's full library enumeration) delaying session-poll behind it is the
    // accepted cost of restoring this — BullMQ's single worker had the exact same
    // property, so it is not a regression. A single global slot combined with a fixed
    // iteration order would, however, be a regression on its own: session-poll is
    // exempt from FAILURE_BACKOFF_MS and re-qualifies as due on literally every tick
    // while it keeps failing, so a fixed order would let it win this slot forever
    // during a sustained Jellyfin outage, starving the other four jobs of ever being
    // checked at all rather than merely delaying them. `order` (rotated per call, see
    // `startIndex` on SchedulerDeps) is what keeps that bounded instead of unbounded.
    if (deps.inFlight.size > 0) break;

    const lastRunAt = runs.get(name);
    const due = isDue(deps.schedules[name], lastRunAt ? lastRunAt.getTime() : null, now);
    if (!due) continue;

    if (!FAST_RETRY_JOBS.has(name)) {
      const lastAttemptAt = deps.lastAttemptAt.get(name);
      if (lastAttemptAt !== undefined && now - lastAttemptAt < FAILURE_BACKOFF_MS) continue;
    }

    deps.lastAttemptAt.set(name, now);

    const run = deps
      .runJob(name)
      .then(() => {
        deps.lastAttemptAt.delete(name);
        return deps.writeRun(name, new Date(now));
      })
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
  // Ticks at most every 1s, faster than the shortest schedule it dispatches
  // (SESSION_POLL_INTERVAL_MS, 5000ms by default). Ticking at exactly the
  // interval it is checking — the previous default — is what let read latency
  // cause a false negative: `now()` is sampled *after* readRuns() resolves (see
  // `tick` below), so the gap between two recorded run times is
  // `tickMs + (thisReadLatency - previousReadLatency)`, not exactly `tickMs`. With
  // tickMs === everyMs, a read that is even a couple of milliseconds faster than
  // the one before it makes that gap dip below everyMs and the tick is skipped —
  // a full interval's worth of delay (10s instead of 5s for session-poll). Ticking
  // five times as often bounds the same jitter to, at worst, one fast tick's delay
  // (~1s) instead of a whole missed interval, at the cost of up to 5x more
  // `readJobRuns` calls when SESSION_POLL_INTERVAL_MS is at its default. See
  // scheduler.test.ts's "tick timing" tests, which reproduce the skip directly.
  const tickMs = options.tickMs ?? Math.min(1000, context.env.SESSION_POLL_INTERVAL_MS);
  const readRuns = options.readRuns ?? (() => readJobRuns(context.db));
  const writeRun = options.writeRun ?? ((name: JobName, at: Date) => writeJobRun(context.db, name, at));

  const deps: SchedulerDeps = {
    schedules: buildSchedules(context.env),
    runJob,
    writeRun,
    logger: context.logger,
    inFlight: new Map(),
    lastAttemptAt: new Map(),
    startIndex: 0,
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
