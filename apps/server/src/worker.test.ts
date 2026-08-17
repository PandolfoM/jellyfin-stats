import { describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { handle, rollupWindow, type JobName } from "./worker.js";

const DAY_MS = 24 * 60 * 60 * 1000;

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
    // A job name with no case arm must reach the worker's "failed" handler. Returning
    // undefined would have BullMQ mark the job completed having done nothing at all.
    await expect(
      handle({} as AppContext, "not-a-real-job" as JobName),
    ).rejects.toThrow(/Unhandled job name/);
  });
});
