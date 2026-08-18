const MS_PER_DAY = 86_400_000;

/** Inclusive `YYYY-MM-DD` UTC calendar days — the API's date contract for
 * `from`/`to` on every stats and history endpoint. */
export interface DateRange {
  from: string;
  to: string;
}

/**
 * Longest span any stats route will accept, inclusive of both endpoints.
 * Mirrors `MAX_RANGE_DAYS` in apps/server/src/api/routes/stats.ts — the API
 * answers `invalid_range` (400) past it. Duplicated here, not imported,
 * because this file has no dependency on the server; `range.test.ts` is what
 * keeps the two numbers honest if the server's cap ever moves.
 */
export const MAX_RANGE_DAYS = 1000;

const DEFAULT_RANGE_DAYS = 30;

function toUtcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Parses an inclusive `YYYY-MM-DD` day as a UTC midnight instant. Deliberately
 * not `new Date(day)` read back with local accessors — that shifts the day
 * west of Greenwich on any negative-UTC-offset machine (the same trap
 * `formatDay` in lib/format.ts was bitten by).
 */
function parseUtcDay(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * Trailing 30 inclusive days ending "today" in UTC. Takes an injected clock,
 * the same convention `parseRange`, `rollupWindow`, and `generateSeedData`
 * use on the server, so a test can pin a fixed instant instead of depending
 * on the real wall clock — and so this stays in lockstep with the server's
 * own `DEFAULT_RANGE_DAYS` default when no `from`/`to` is supplied.
 */
export function defaultRange(now: () => number = Date.now): DateRange {
  const to = toUtcDay(now());
  const from = toUtcDay(now() - (DEFAULT_RANGE_DAYS - 1) * MS_PER_DAY);
  return { from, to };
}

/**
 * Enforces the API's range contract client-side, so `DateRangePicker` can
 * never hand a route a range the API would reject with `invalid_range`.
 *
 * A reversed range (`from` after `to`) is swapped rather than rejected — the
 * picker always has two concrete dates to show, and refusing to render is a
 * worse outcome than silently choosing the sensible order. An over-long span
 * is clamped by pulling `from` forward to `MAX_RANGE_DAYS` before `to`,
 * keeping `to` fixed since it is usually "today" or a deliberately chosen
 * end date.
 */
export function clampRangeDays(range: DateRange): DateRange {
  let { from, to } = range;
  if (from > to) {
    [from, to] = [to, from];
  }

  const spanDays = (parseUtcDay(to) - parseUtcDay(from)) / MS_PER_DAY + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    from = toUtcDay(parseUtcDay(to) - (MAX_RANGE_DAYS - 1) * MS_PER_DAY);
  }

  return { from, to };
}
