import { bumpRateLimit, insertSession, selectLiveSession } from "@jfstats/db";
import { stopTestDatabase, withTestDatabase } from "@jfstats/db/testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AppContext } from "./context.js";
import { handle, rollupWindow, runDueJobs, type SchedulerDeps } from "./scheduler.js";
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
    for (const at of ["2026-08-17T00:00:00Z", "2026-08-17T12:34:56.789Z", "2026-08-17T23:59:59.999Z"]) {
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
    await expect(
      handle({} as AppContext, "not-a-real-job" as JobName),
    ).rejects.toThrow(/Unhandled job name/);
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
