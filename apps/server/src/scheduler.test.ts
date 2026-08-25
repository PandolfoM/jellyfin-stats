import { bumpRateLimit, insertSession, selectLiveSession } from "@jfstats/db";
import { stopTestDatabase, withTestDatabase } from "@jfstats/db/testing";
import type { AppEnv } from "@jfstats/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "./context.js";
import {
  buildSchedules,
  FAILURE_BACKOFF_MS,
  handle,
  rollupWindow,
  runDueJobs,
  startScheduler,
  type SchedulerDeps,
} from "./scheduler.js";
import { JOB_NAMES, type JobName, type Schedule } from "./sync/schedule.js";

afterAll(stopTestDatabase);

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function iso(at: Date): string {
  return at.toISOString();
}

describe("rollupWindow", () => {
  it("covers the trailing 7 whole UTC days and excludes the day in progress", () => {
    const { from, to } = rollupWindow(new Date("2026-08-17T03:30:00Z").getTime());

    // The job fires at 03:30 on the 17th; the 17th is still being written
    // incrementally and is deliberately left out. `to` is exclusive.
    expect(iso(to)).toBe("2026-08-17T00:00:00.000Z");
    expect(iso(from)).toBe("2026-08-10T00:00:00.000Z");
    expect(to.getTime() - from.getTime()).toBe(7 * DAY_MS);
  });

  it("puts both bounds exactly on UTC midnight whatever time it is called", () => {
    for (const at of [
      "2026-08-17T00:00:00Z",
      "2026-08-17T12:34:56.789Z",
      "2026-08-17T23:59:59.999Z",
    ]) {
      const { from, to } = rollupWindow(new Date(at).getTime());

      // recomputeRollupRange floors `from` and ceils `to` to day boundaries. A `to`
      // even a millisecond past midnight would be ceiled up to the *next* day, pulling
      // the in-progress day into the rebuild.
      expect(to.getTime() % DAY_MS).toBe(0);
      expect(from.getTime() % DAY_MS).toBe(0);
    }
  });

  it("returns the same window for every instant within one UTC day", () => {
    const early = rollupWindow(new Date("2026-08-17T00:00:00.000Z").getTime());
    const late = rollupWindow(new Date("2026-08-17T23:59:59.999Z").getTime());

    expect(iso(early.from)).toBe(iso(late.from));
    expect(iso(early.to)).toBe(iso(late.to));
  });

  it("rolls to the next window the instant UTC midnight passes", () => {
    // One millisecond before midnight and one millisecond after must not produce the
    // same window — the boundary is where an off-by-one silently drops or repeats a day.
    const before = rollupWindow(new Date("2026-08-17T23:59:59.999Z").getTime());
    const after = rollupWindow(new Date("2026-08-18T00:00:00.000Z").getTime());

    expect(iso(before.to)).toBe("2026-08-17T00:00:00.000Z");
    expect(iso(after.to)).toBe("2026-08-18T00:00:00.000Z");
    expect(iso(before.from)).toBe("2026-08-10T00:00:00.000Z");
    expect(iso(after.from)).toBe("2026-08-11T00:00:00.000Z");
  });

  it("crosses a month boundary without arithmetic drift", () => {
    // 2026-09-01 minus 7 days lands in August, and August has 31 days — the case a
    // naive setUTCDate(getUTCDate() - 7) or a month-aware calculation gets wrong.
    const { from, to } = rollupWindow(new Date("2026-09-01T03:30:00Z").getTime());

    expect(iso(to)).toBe("2026-09-01T00:00:00.000Z");
    expect(iso(from)).toBe("2026-08-25T00:00:00.000Z");
  });

  it("crosses a year boundary without arithmetic drift", () => {
    const { from, to } = rollupWindow(new Date("2027-01-03T03:30:00Z").getTime());

    expect(iso(to)).toBe("2027-01-03T00:00:00.000Z");
    expect(iso(from)).toBe("2026-12-27T00:00:00.000Z");
  });

  it("crosses a leap day without arithmetic drift", () => {
    const { from, to } = rollupWindow(new Date("2028-03-02T03:30:00Z").getTime());

    expect(iso(to)).toBe("2028-03-02T00:00:00.000Z");
    // 2028 is a leap year, so the window reaches back through 29 February.
    expect(iso(from)).toBe("2028-02-24T00:00:00.000Z");
  });
});

describe("handle", () => {
  it("throws on a job name it does not recognize instead of silently succeeding", async () => {
    // A job name with no case arm must be surfaced as a rejection. Returning
    // undefined would have the scheduler record it as a successful run having
    // done nothing at all.
    await expect(handle({} as AppContext, "not-a-real-job" as JobName)).rejects.toThrow(
      /Unhandled job name/,
    );
  });

  it("sweeps expired sessions and stale rate-limit rows on session-cleanup", async () => {
    await withTestDatabase(async (db) => {
      const now = new Date("2026-08-18T04:00:00Z");

      await insertSession(db, {
        id: "expired",
        userId: "u",
        userName: "n",
        isAdmin: false,
        createdAt: now,
        expiresAt: new Date(now.getTime() - 1000),
      });
      await insertSession(db, {
        id: "live",
        userId: "u",
        userName: "n",
        isAdmin: false,
        createdAt: now,
        expiresAt: new Date(now.getTime() + HOUR),
      });

      // 25 hours old: outside the job's retention window and must be swept.
      await bumpRateLimit(db, "ip-stale", new Date(now.getTime() - 25 * HOUR), HOUR);
      // Bumped "now": inside the retention window and must survive.
      await bumpRateLimit(db, "ip-fresh", now, HOUR);

      const context = {
        db,
        logger: { debug: () => {} },
      } as unknown as AppContext;

      await handle(context, "session-cleanup", () => now.getTime());

      expect(
        await selectLiveSession(db, "expired", now, new Date(now.getTime() + HOUR)),
      ).toBeNull();
      expect(
        await selectLiveSession(db, "live", now, new Date(now.getTime() + HOUR)),
      ).not.toBeNull();

      // The stale key's row is gone, so a fresh bump restarts its count at 1
      // rather than continuing the swept row.
      expect(await bumpRateLimit(db, "ip-stale", now, HOUR)).toBe(1);
      // The fresh key's row was left alone, so its count keeps accumulating.
      expect(await bumpRateLimit(db, "ip-fresh", now, HOUR)).toBe(2);
    });
  });
});

// --- runDueJobs ------------------------------------------------------------
//
// All five jobs are given a huge interval so none of them are "due" purely by
// elapsed time; only a job whose `runs` entry is *absent* (never run) is due.
// That lets each test drive exactly one job without reasoning about the daily
// schedules' local-time targets, which isDue.test.ts already covers.

const FIXED_NOW = new Date("2026-08-18T12:00:00Z").getTime();
const HUGE_INTERVAL_MS = 999_999_999_999;

const NEVER_DUE_SCHEDULES: Record<JobName, Schedule> = {
  "session-poll": { type: "interval", everyMs: HUGE_INTERVAL_MS },
  "reference-sync": { type: "interval", everyMs: HUGE_INTERVAL_MS },
  "item-sync": { type: "interval", everyMs: HUGE_INTERVAL_MS },
  "rollup-recompute": { type: "interval", everyMs: HUGE_INTERVAL_MS },
  "session-cleanup": { type: "interval", everyMs: HUGE_INTERVAL_MS },
};

const TARGET: JobName = "session-poll";

/** Every job except `due` has already run "now" under a huge interval — not due. */
function runsWithOnlyDue(due: JobName): Map<string, Date> {
  const runs = new Map<string, Date>();
  for (const name of JOB_NAMES) {
    if (name !== due) runs.set(name, new Date(FIXED_NOW));
  }
  return runs;
}

function fakeLogger(): { error: ReturnType<typeof vi.fn> } {
  return { error: vi.fn() };
}

async function waitUntilIdle(inFlight: Map<JobName, Promise<void>>, name: JobName): Promise<void> {
  await vi.waitFor(() => {
    if (inFlight.has(name)) throw new Error(`${name} still in flight`);
  });
}

describe("runDueJobs", () => {
  it("skips a job that is already running rather than starting it twice", async () => {
    let resolveJob: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });

    const runJob = vi.fn((name: JobName) => (name === TARGET ? pending : Promise.resolve()));
    const writeRun = vi.fn().mockResolvedValue(undefined);
    const inFlight = new Map<JobName, Promise<void>>();
    const deps: SchedulerDeps = {
      schedules: NEVER_DUE_SCHEDULES,
      runJob,
      writeRun,
      logger: fakeLogger(),
      inFlight,
      lastAttemptAt: new Map(),
      startIndex: 0,
    };
    const runs = runsWithOnlyDue(TARGET);

    // Two ticks while the job is still pending. Without the in-flight guard,
    // both would dispatch it.
    await runDueJobs(deps, runs, FIXED_NOW);
    await runDueJobs(deps, runs, FIXED_NOW);

    const callsWhilePending = runJob.mock.calls.filter(([name]) => name === TARGET).length;
    expect(callsWhilePending).toBe(1);

    resolveJob?.();
    await waitUntilIdle(inFlight, TARGET);

    // Now that it has settled, a third tick may start it again.
    await runDueJobs(deps, runs, FIXED_NOW);
    const callsAfterSettling = runJob.mock.calls.filter(([name]) => name === TARGET).length;
    expect(callsAfterSettling).toBe(2);
  });

  it("keeps ticking after a job throws", async () => {
    const runJob = vi
      .fn<(name: JobName) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const writeRun = vi.fn().mockResolvedValue(undefined);
    const inFlight = new Map<JobName, Promise<void>>();
    const deps: SchedulerDeps = {
      schedules: NEVER_DUE_SCHEDULES,
      runJob,
      writeRun,
      logger: fakeLogger(),
      inFlight,
      lastAttemptAt: new Map(),
      startIndex: 0,
    };
    // writeRun is never called on failure, so this same "never ran" runs map
    // is still accurate on the second tick — the job is still due.
    const runs = runsWithOnlyDue(TARGET);

    await runDueJobs(deps, runs, FIXED_NOW);
    await waitUntilIdle(inFlight, TARGET);

    await runDueJobs(deps, runs, FIXED_NOW);
    await waitUntilIdle(inFlight, TARGET);

    expect(runJob).toHaveBeenCalledTimes(2);
  });

  it("does not record a last-run time for a job that failed", async () => {
    const runJob = vi.fn().mockRejectedValue(new Error("boom"));
    const writeRun = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const inFlight = new Map<JobName, Promise<void>>();
    const deps: SchedulerDeps = {
      schedules: NEVER_DUE_SCHEDULES,
      runJob,
      writeRun,
      logger,
      inFlight,
      lastAttemptAt: new Map(),
      startIndex: 0,
    };
    const runs = runsWithOnlyDue(TARGET);

    await runDueJobs(deps, runs, FIXED_NOW);
    await waitUntilIdle(inFlight, TARGET);

    expect(writeRun).not.toHaveBeenCalled();
    // The failure must still surface somewhere, or a silent catch could pass
    // this same assertion for the wrong reason.
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("records a last-run time for a job that succeeded", async () => {
    const runJob = vi.fn().mockResolvedValue(undefined);
    const writeRun = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const inFlight = new Map<JobName, Promise<void>>();
    const deps: SchedulerDeps = {
      schedules: NEVER_DUE_SCHEDULES,
      runJob,
      writeRun,
      logger,
      inFlight,
      lastAttemptAt: new Map(),
      startIndex: 0,
    };
    const runs = runsWithOnlyDue(TARGET);

    await runDueJobs(deps, runs, FIXED_NOW);
    await waitUntilIdle(inFlight, TARGET);

    // Only the one due job ran, and it was recorded with exactly this tick's
    // timestamp — not merely "some" timestamp.
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(writeRun).toHaveBeenCalledTimes(1);
    expect(writeRun).toHaveBeenCalledWith(TARGET, new Date(FIXED_NOW));
    expect(logger.error).not.toHaveBeenCalled();
  });
});

// --- buildSchedules ---------------------------------------------------------
//
// This mapping was previously reachable only through the untested
// startScheduler, so a transposed hour/minute between two daily jobs would
// have compiled and passed the full suite silently.

describe("buildSchedules", () => {
  const env = {
    SESSION_POLL_INTERVAL_MS: 5000,
    REFERENCE_SYNC_INTERVAL_MS: 900_000,
  } as unknown as AppEnv;

  it("covers every job name exactly once", () => {
    const schedules = buildSchedules(env);
    expect(Object.keys(schedules).sort()).toEqual([...JOB_NAMES].sort());
  });

  it("wires the two interval jobs to their env-configured millisecond values", () => {
    const schedules = buildSchedules(env);
    expect(schedules["session-poll"]).toEqual({ type: "interval", everyMs: 5000 });
    expect(schedules["reference-sync"]).toEqual({ type: "interval", everyMs: 900_000 });
  });

  it("wires the three daily jobs to their intended, mutually distinct times", () => {
    const schedules = buildSchedules(env);
    expect(schedules["item-sync"]).toEqual({ type: "daily", hour: 3, minute: 0 });
    expect(schedules["rollup-recompute"]).toEqual({ type: "daily", hour: 3, minute: 30 });
    expect(schedules["session-cleanup"]).toEqual({ type: "daily", hour: 4, minute: 0 });

    // Distinct, not merely individually correct: two daily jobs silently
    // sharing a slot is a bug isDue's own tests cannot see, because they
    // never look at this JobName -> Schedule mapping at all.
    const dailyNames = ["item-sync", "rollup-recompute", "session-cleanup"] as const;
    const dailyTimes = dailyNames.map((name) => {
      const schedule = schedules[name];
      if (schedule.type !== "daily") throw new Error(`expected ${name} to be a daily schedule`);
      return `${schedule.hour}:${schedule.minute}`;
    });
    expect(new Set(dailyTimes).size).toBe(dailyTimes.length);
  });
});

// --- startScheduler ----------------------------------------------------------
//
// readRuns/writeRun/runJob are all injected, so this drives the real timer
// and stop() with fake timers and no database at all.

describe("startScheduler", () => {
  const FAKE_ENV = {
    SESSION_POLL_INTERVAL_MS: 5000,
    REFERENCE_SYNC_INTERVAL_MS: 900_000,
  } as unknown as AppEnv;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Every job but the target gets a last-run timestamp 100 years in the
  // future, which is "not due" for a daily job regardless of the host
  // process's local timezone (unlike a lastRunAt near "now", whose due-ness
  // for a daily schedule depends on local wall-clock fields) and for an
  // interval job regardless of its configured interval.
  function onlyDueUnderRealSchedules(due: JobName, now: number): Map<string, Date> {
    const farFuture = new Date(now + 100 * 365 * DAY_MS);
    const runs = new Map<string, Date>();
    for (const name of JOB_NAMES) {
      if (name !== due) runs.set(name, farFuture);
    }
    return runs;
  }

  it("stops dispatching once stop() is called, and stop() waits for in-flight work before resolving", async () => {
    let resolveJob: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });
    // Only the target job ever blocks; every other job resolves immediately
    // so it never occupies the in-flight guard across ticks.
    const runJob = vi.fn((name: JobName) => (name === TARGET ? pending : Promise.resolve()));
    const writeRun = vi.fn().mockResolvedValue(undefined);
    const readRuns = vi.fn().mockResolvedValue(onlyDueUnderRealSchedules(TARGET, Date.now()));

    const context = {
      env: FAKE_ENV,
      logger: { error: vi.fn() },
    } as unknown as AppContext;

    const scheduler = startScheduler(context, { runJob, readRuns, writeRun, tickMs: 1000 });

    // First tick fires and dispatches the target job, which then blocks.
    await vi.advanceTimersByTimeAsync(1000);
    const readRunsCallsBeforeStop = readRuns.mock.calls.length;
    expect(readRunsCallsBeforeStop).toBe(1);
    expect(runJob.mock.calls.filter(([name]) => name === TARGET).length).toBe(1);

    let stopped = false;
    const stopPromise = scheduler.stop().then(() => {
      stopped = true;
    });

    // Five more tick intervals pass. readRuns is called unconditionally at
    // the top of every tick, before the in-flight guard is even consulted —
    // so, unlike a runJob call count, it still increases here if the timer
    // were merely left running while the (still in-flight, still guarded)
    // target job blocks stop() from resolving. Only clearInterval actually
    // stops it from ticking.
    await vi.advanceTimersByTimeAsync(5000);
    expect(readRuns.mock.calls.length).toBe(readRunsCallsBeforeStop);
    // stop() must not resolve while the job it dispatched is still pending —
    // draining in-flight work before returning is the whole point of stop()
    // awaiting `inFlight`, not merely clearing the interval.
    expect(stopped).toBe(false);

    resolveJob?.();
    await stopPromise;
    expect(stopped).toBe(true);
    // And no tick sneaked in during the drain either.
    expect(readRuns.mock.calls.length).toBe(readRunsCallsBeforeStop);
  });

  it("defaults to ticking at most every 1s, faster than the shortest interval it schedules (finding 3)", async () => {
    const readRuns = vi.fn().mockResolvedValue(new Map<string, Date>());
    const writeRun = vi.fn().mockResolvedValue(undefined);
    const runJob = vi.fn().mockResolvedValue(undefined);
    const context = { env: FAKE_ENV, logger: { error: vi.fn() } } as unknown as AppContext;

    // tickMs deliberately not passed, to exercise the real default.
    const scheduler = startScheduler(context, { runJob, readRuns, writeRun });
    await vi.advanceTimersByTimeAsync(3000);
    await scheduler.stop();

    // SESSION_POLL_INTERVAL_MS is 5000 here; ticking at that cadence (the old
    // default, which is what let read-latency jitter skip a whole interval —
    // see the "tick timing" tests below) would call readRuns zero times in 3s,
    // since the first fire wouldn't land until the 5s mark. Ticking at the 1s
    // floor calls it three times.
    expect(readRuns.mock.calls.length).toBe(3);
  });
});

// --- runDueJobs: failure backoff (finding 4) --------------------------------
//
// Before this fix, a failing job retried on literally every tick forever:
// writeRun is skipped on failure, so lastRunAt in job_runs never advances, and
// isDue keeps comparing against that same stale timestamp -- once a job
// becomes due it stays "due" on every subsequent tick until it finally
// succeeds. These tests fail under that old behavior (no lastAttemptAt
// tracked, no backoff check) because callsWithinFloor would be 3, not 1.

describe("runDueJobs backoff on repeated failure", () => {
  const BACKOFF_TARGET: JobName = "reference-sync";

  it("does not retry a failing non-session-poll job again until the backoff floor elapses", async () => {
    const runJob = vi.fn().mockRejectedValue(new Error("boom"));
    const writeRun = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const inFlight = new Map<JobName, Promise<void>>();
    const lastAttemptAt = new Map<JobName, number>();
    const deps: SchedulerDeps = {
      schedules: NEVER_DUE_SCHEDULES,
      runJob,
      writeRun,
      logger,
      inFlight,
      lastAttemptAt,
      startIndex: 0,
    };
    const runs = runsWithOnlyDue(BACKOFF_TARGET);

    await runDueJobs(deps, runs, FIXED_NOW);
    await waitUntilIdle(inFlight, BACKOFF_TARGET);

    // Two more ticks, seconds apart -- like the real scheduler's cadence --
    // while still well inside FAILURE_BACKOFF_MS.
    await runDueJobs(deps, runs, FIXED_NOW + 5_000);
    await waitUntilIdle(inFlight, BACKOFF_TARGET);
    await runDueJobs(deps, runs, FIXED_NOW + 10_000);
    await waitUntilIdle(inFlight, BACKOFF_TARGET);

    const callsWithinFloor = runJob.mock.calls.filter(([name]) => name === BACKOFF_TARGET).length;
    expect(callsWithinFloor).toBe(1);

    // Once the floor elapses, the job is attempted again.
    await runDueJobs(deps, runs, FIXED_NOW + FAILURE_BACKOFF_MS + 1);
    await waitUntilIdle(inFlight, BACKOFF_TARGET);

    const callsAfterFloor = runJob.mock.calls.filter(([name]) => name === BACKOFF_TARGET).length;
    expect(callsAfterFloor).toBe(2);
  });

  it("keeps retrying a failing session-poll on every tick (fast retry preserved)", async () => {
    const runJob = vi.fn().mockRejectedValue(new Error("boom"));
    const writeRun = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const inFlight = new Map<JobName, Promise<void>>();
    const lastAttemptAt = new Map<JobName, number>();
    const deps: SchedulerDeps = {
      schedules: NEVER_DUE_SCHEDULES,
      runJob,
      writeRun,
      logger,
      inFlight,
      lastAttemptAt,
      startIndex: 0,
    };
    const runs = runsWithOnlyDue(TARGET); // TARGET === "session-poll"

    await runDueJobs(deps, runs, FIXED_NOW);
    await waitUntilIdle(inFlight, TARGET);
    await runDueJobs(deps, runs, FIXED_NOW + 5_000);
    await waitUntilIdle(inFlight, TARGET);
    await runDueJobs(deps, runs, FIXED_NOW + 10_000);
    await waitUntilIdle(inFlight, TARGET);

    // session-poll is deliberately exempt from FAILURE_BACKOFF_MS -- all
    // three ticks, well within the floor, still attempted it.
    expect(runJob.mock.calls.filter(([name]) => name === TARGET).length).toBe(3);
  });
});

// --- runDueJobs: global concurrency (finding 5) -----------------------------
//
// Restores BullMQ's `concurrency: 1`: at most one job runs at a time across
// the whole scheduler, not one slot per job name. Without this, two jobs due
// on the same tick would both dispatch.

describe("runDueJobs global concurrency", () => {
  it("dispatches at most one job per tick even when several are due at once", async () => {
    const started: JobName[] = [];
    let resolveFirst: (() => void) | undefined;
    const runJob = vi.fn((name: JobName) => {
      started.push(name);
      return new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    });
    const writeRun = vi.fn().mockResolvedValue(undefined);
    const inFlight = new Map<JobName, Promise<void>>();
    const lastAttemptAt = new Map<JobName, number>();
    const deps: SchedulerDeps = {
      schedules: NEVER_DUE_SCHEDULES,
      runJob,
      writeRun,
      logger: fakeLogger(),
      inFlight,
      lastAttemptAt,
      startIndex: 0,
    };
    // Every job is due: none has ever run.
    const runs = new Map<string, Date>();

    await runDueJobs(deps, runs, FIXED_NOW);

    // Only the first job in JOB_NAMES order was started; the rest are left
    // for later ticks once the slot frees up.
    expect(started).toEqual([JOB_NAMES[0]]);
    expect(inFlight.size).toBe(1);

    resolveFirst?.();
    await waitUntilIdle(inFlight, started[0] as JobName);
  });
});

// --- runDueJobs: fairness under a continuously-failing fast-retry job -------
//
// A combination finding: none of findings 3-5 causes this alone, but together
// they do. session-poll is first in JOB_NAMES, is exempt from
// FAILURE_BACKOFF_MS (finding 4's fix), and -- while it keeps failing --
// never advances lastRunAt, so isDue returns true for it on literally every
// tick. With a fixed iteration order and the single global concurrency slot
// (finding 5's fix), that lets session-poll win the slot every single tick,
// forever, during a sustained Jellyfin outage: the loop hits
// `if (inFlight.size > 0) break` right after dispatching it, so
// reference-sync/item-sync/rollup-recompute/session-cleanup are never even
// due-checked. rotatedJobNames is what bounds that to JOB_NAMES.length ticks
// instead of indefinitely.

function runsWithDue(due: readonly JobName[]): Map<string, Date> {
  const runs = new Map<string, Date>();
  for (const name of JOB_NAMES) {
    if (!due.includes(name)) runs.set(name, new Date(FIXED_NOW));
  }
  return runs;
}

describe("runDueJobs fairness under a continuously-failing fast-retry job", () => {
  it("still starts another due job within JOB_NAMES.length ticks while session-poll fails on every attempt", async () => {
    const runJob = vi.fn((name: JobName) =>
      name === "session-poll"
        ? Promise.reject(new Error("jellyfin unreachable"))
        : Promise.resolve(undefined),
    );
    const writeRun = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const inFlight = new Map<JobName, Promise<void>>();
    const lastAttemptAt = new Map<JobName, number>();
    const deps: SchedulerDeps = {
      schedules: NEVER_DUE_SCHEDULES,
      runJob,
      writeRun,
      logger,
      inFlight,
      lastAttemptAt,
      startIndex: 0,
    };
    // session-poll and rollup-recompute have never run (both due); the other
    // three already ran "now" under a huge interval, so they're not due --
    // isolating the assertion to whether rollup-recompute specifically gets a
    // turn, rather than merely "something other than session-poll ran".
    const runs = runsWithDue(["session-poll", "rollup-recompute"]);

    let rollupStarted = false;
    for (let tick = 0; tick < JOB_NAMES.length; tick += 1) {
      await runDueJobs(deps, runs, FIXED_NOW + tick * 5_000);
      await vi.waitFor(() => {
        if (inFlight.size > 0) throw new Error("still in flight");
      });
      if (runJob.mock.calls.some(([name]) => name === "rollup-recompute")) {
        rollupStarted = true;
        break;
      }
    }

    expect(rollupStarted).toBe(true);
    // session-poll did fail repeatedly along the way -- confirms the scenario
    // actually exercised the starvation condition rather than rollup-recompute
    // simply winning by luck on tick 1.
    expect(runJob.mock.calls.filter(([name]) => name === "session-poll").length).toBeGreaterThan(0);
  });
});

// --- startScheduler: tick timing (finding 3) --------------------------------
//
// Reproduces, without depending on real elapsed wall-clock time, the timing
// model of the real tick() loop: the interval timer fires on a fixed
// cadence independent of how long the previous tick's async work took (it is
// fire-and-forget, `void tick()`), but `now()` is sampled only *after*
// readRuns() resolves. So the gap between two recorded run times is
// `tickIntervalMs + thisReadLatency`, measured from the fixed firing
// schedule -- not simply `tickIntervalMs` apart. `buildTimingHarness` bakes
// exactly that model into a controllable `now` and a `readRuns` whose
// latency varies per call, with no real timers or delays involved.

describe("startScheduler tick timing (finding 3)", () => {
  const FAKE_ENV = {
    SESSION_POLL_INTERVAL_MS: 5000,
    REFERENCE_SYNC_INTERVAL_MS: 900_000,
  } as unknown as AppEnv;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildTimingHarness(tickIntervalMs: number, readLatenciesMs: readonly number[]) {
    let simulatedNow = 0;
    let callIndex = 0;
    const runsStore = new Map<string, Date>();
    const readRuns = vi.fn(async () => {
      callIndex += 1;
      // The timer's Nth fire happens at a fixed point (N * tickIntervalMs)
      // regardless of prior tick durations; this read's own latency is what
      // delays *this* call's resolution past that point.
      simulatedNow = callIndex * tickIntervalMs + (readLatenciesMs[callIndex - 1] ?? 0);
      return new Map(runsStore);
    });
    const writeRun = vi.fn(async (name: JobName, at: Date) => {
      runsStore.set(name, at);
    });
    return { readRuns, writeRun, now: () => simulatedNow };
  }

  it("skips session-poll for a whole extra interval when tickMs equals the interval (old default) and read latency shrinks between ticks", async () => {
    const runJob = vi.fn().mockResolvedValue(undefined);
    // First read is slow (50ms), second is instant -- read latency shrinking
    // between ticks is exactly what makes the recorded gap dip below everyMs.
    const { readRuns, writeRun, now } = buildTimingHarness(5000, [50, 0]);
    const context = { env: FAKE_ENV, logger: { error: vi.fn() } } as unknown as AppContext;

    // tickMs: 5000 reproduces the pre-fix default (tickMs === SESSION_POLL_INTERVAL_MS).
    const scheduler = startScheduler(context, { runJob, readRuns, writeRun, now, tickMs: 5000 });

    await vi.advanceTimersByTimeAsync(5000); // tick 1: never run before -> due
    await vi.advanceTimersByTimeAsync(5000); // tick 2: recorded gap is 4950ms < 5000ms -> skipped
    await scheduler.stop();

    const pollCalls = runJob.mock.calls.filter(([name]) => name === "session-poll").length;
    // Two nominal 5s periods have elapsed; a correctly-ticking scheduler runs
    // session-poll twice. tickMs === everyMs runs it only once.
    expect(pollCalls).toBe(1);
  });

  it("bounds the same jitter to about one fast tick's delay when ticking faster than the interval (the fix)", async () => {
    const runJob = vi.fn().mockResolvedValue(undefined);
    // Same 50ms-then-0ms jitter pattern, now against a 1s tick instead of 5s.
    const { readRuns, writeRun, now } = buildTimingHarness(1000, [50]);
    const context = { env: FAKE_ENV, logger: { error: vi.fn() } } as unknown as AppContext;

    const scheduler = startScheduler(context, { runJob, readRuns, writeRun, now, tickMs: 1000 });

    for (let tick = 0; tick < 6; tick += 1) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    const pollCallsAtSixTicks = runJob.mock.calls.filter(
      ([name]) => name === "session-poll",
    ).length;
    // The 50ms offset baked into the first recorded run (at simulatedNow=1050)
    // pushes the nominal due point (1050 + 5000 = 6050) just past the 6th
    // tick's 6000ms mark -- still not due yet, one tick short.
    expect(pollCallsAtSixTicks).toBe(1);

    await vi.advanceTimersByTimeAsync(1000); // 7th tick: 7000ms >= 6050ms -> due
    await scheduler.stop();

    const pollCallsAtSevenTicks = runJob.mock.calls.filter(
      ([name]) => name === "session-poll",
    ).length;
    // Caught on the very next fast tick -- a ~1s delay past the nominal mark,
    // not the ~5s (a whole extra interval) the old tickMs === everyMs config
    // produced in the test above.
    expect(pollCallsAtSevenTicks).toBe(2);
  });
});
