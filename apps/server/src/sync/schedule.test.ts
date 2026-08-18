import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isDue, type Schedule } from "./schedule.js";

// Pinned, and pinned to a NEGATIVE-offset zone specifically. With TZ unset this
// file passes on a UTC runner even if `daily` were implemented with Date.UTC,
// because local and UTC would agree — the bug this pins only appears off UTC.
beforeAll(() => vi.stubEnv("TZ", "America/New_York"));
afterAll(() => vi.unstubAllEnvs());

const daily3am: Schedule = { type: "daily", hour: 3, minute: 0 };

describe("isDue — interval", () => {
  const every5s: Schedule = { type: "interval", everyMs: 5000 };

  it("is due when it has never run", () => {
    expect(isDue(every5s, null, Date.now())).toBe(true);
  });

  it("is not due before the interval has elapsed", () => {
    const now = Date.now();
    expect(isDue(every5s, now - 4999, now)).toBe(false);
  });

  it("is due once the interval has elapsed exactly", () => {
    const now = Date.now();
    expect(isDue(every5s, now - 5000, now)).toBe(true);
  });
});

describe("isDue — daily, in local time", () => {
  it("is due when it has never run", () => {
    expect(isDue(daily3am, null, new Date("2026-08-18T12:00:00-04:00").getTime())).toBe(true);
  });

  it("is not due just before the local target time", () => {
    const now = new Date("2026-08-18T02:59:00-04:00").getTime();
    const yesterdayRun = new Date("2026-08-17T03:00:00-04:00").getTime();
    expect(isDue(daily3am, yesterdayRun, now)).toBe(false);
  });

  it("is due just after the local target time", () => {
    const now = new Date("2026-08-18T03:01:00-04:00").getTime();
    const yesterdayRun = new Date("2026-08-17T03:00:00-04:00").getTime();
    expect(isDue(daily3am, yesterdayRun, now)).toBe(true);
  });

  it("is not due again later the same day once it has run", () => {
    const now = new Date("2026-08-18T20:00:00-04:00").getTime();
    const ranToday = new Date("2026-08-18T03:00:30-04:00").getTime();
    expect(isDue(daily3am, ranToday, now)).toBe(false);
  });

  // The improvement over BullMQ's repeatable jobs, which simply skip a missed
  // occurrence. The container was down at 03:00 and boots at 09:00 — the job
  // should run now rather than wait until tomorrow.
  it("catches up a run missed while the process was down", () => {
    const now = new Date("2026-08-18T09:00:00-04:00").getTime();
    const ranTwoDaysAgo = new Date("2026-08-16T03:00:00-04:00").getTime();
    expect(isDue(daily3am, ranTwoDaysAgo, now)).toBe(true);
  });

  // The load-bearing timezone case. 2026-08-18T05:00Z is 01:00 EDT — BEFORE the
  // local 03:00 target, so it is NOT due. An implementation using Date.UTC
  // would compute a UTC target of 03:00Z, see 05:00Z as past it, and answer
  // true. Under TZ=America/New_York this test distinguishes them.
  it("uses local time, not UTC, to decide the day boundary", () => {
    const now = new Date("2026-08-18T05:00:00Z").getTime();
    const ranYesterdayLocal = new Date("2026-08-17T03:00:00-04:00").getTime();
    expect(isDue(daily3am, ranYesterdayLocal, now)).toBe(false);
  });

  // DST boundary test: spring-forward. 2026-03-08 at 02:00 EST, clocks spring
  // forward to 03:00 EDT. The catch-up branch must compute "yesterday's 3am"
  // using calendar arithmetic (new Date(y, m, d-1, h, min)), not fixed-millisecond
  // subtraction. With fixed-24h, the target lands at UTC 07:00 on Mar 7
  // (≈ 02:00 EST), but it should be UTC 08:00 (≈ 03:00 EST).
  it("catches up correctly when spanning a spring-forward DST transition", () => {
    // now = Mar 8 01:30 EST, before spring-forward, before 3 AM target.
    const now = new Date("2026-03-08T01:30:00-05:00").getTime();
    // lastRunAt = Mar 7 02:30 EST: between buggy target (02:00) and correct (03:00).
    // With calendar arithmetic this is before the target, so isDue = true.
    // With fixed-24h subtraction this is after the target, so isDue = false.
    const lastRunAt = new Date("2026-03-07T02:30:00-05:00").getTime();
    expect(isDue(daily3am, lastRunAt, now)).toBe(true);
  });
});
