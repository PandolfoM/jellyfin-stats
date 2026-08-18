export type Schedule =
  | { type: "interval"; everyMs: number }
  | { type: "daily"; hour: number; minute: number };

export const JOB_NAMES = [
  "session-poll",
  "reference-sync",
  "item-sync",
  "rollup-recompute",
  "session-cleanup",
] as const;

export type JobName = (typeof JOB_NAMES)[number];

/**
 * The most recent moment at or before `now` when a daily schedule should have
 * fired, in LOCAL time.
 *
 * Local, not UTC, deliberately: this replaces BullMQ cron patterns that fired
 * at 03:00 in the process's own timezone, and the container sets TZ. Computing
 * the target with Date.UTC would move nightly maintenance to 23:00 for an
 * Eastern deployment — peak viewing rather than the quiet hours it was chosen
 * for. The Date constructor used here reads local fields.
 */
function mostRecentDailyTarget(now: number, hour: number, minute: number): number {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime();
  return today <= now ? today : today - 24 * 60 * 60 * 1000;
}

/**
 * Whether a job should run on this tick.
 *
 * A daily job compares its last run against the most recent target rather than
 * against a fixed "today", so a run missed while the process was down is picked
 * up on the next boot instead of being skipped — which is what BullMQ's
 * repeatable jobs did.
 */
export function isDue(schedule: Schedule, lastRunAt: number | null, now: number): boolean {
  if (lastRunAt === null) return true;

  if (schedule.type === "interval") {
    return now - lastRunAt >= schedule.everyMs;
  }

  return lastRunAt < mostRecentDailyTarget(now, schedule.hour, schedule.minute);
}
