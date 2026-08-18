import { MAX_TOP_ITEMS as DB_MAX_TOP_ITEMS } from "@jfstats/db";
import type { DateRange, LibraryStat, OverviewStats, SeriesPoint, TopItem, UserDetail, UserStat } from "@jfstats/db";
import type { Context, Env, Hono, Schema } from "hono";

export interface StatsDeps {
  getOverview(range: DateRange): Promise<OverviewStats>;
  getWatchTimeSeries(range: DateRange): Promise<SeriesPoint[]>;
  getTopItems(range: DateRange, options: { limit: number; libraryId?: string; userId?: string }): Promise<TopItem[]>;
  getUserStats(range: DateRange): Promise<UserStat[]>;
  getUserDetail(userId: string, range: DateRange): Promise<UserDetail | null>;
  getLibraryStats(range: DateRange): Promise<LibraryStat[]>;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 30;
const MS_PER_DAY = 86_400_000;

/**
 * Longest span any stats route will accept, inclusive of both endpoints.
 *
 * Not arbitrary caution: getWatchTimeSeries builds its day spine with
 * generate_series, so `from=0001-01-01&to=9999-12-31` asks Postgres to
 * materialise ~3.65 million rows for one request. Everything here sits behind
 * the admin gate, so this is not a public denial of service — but it is
 * foundation code that Plan 3's date picker feeds directly, and ~2.7 years is
 * already far past what a daily-rollup dashboard plots.
 */
export const MAX_RANGE_DAYS = 1000;

/** Re-exported from the repository, which is where the clamp is enforced. */
export const MAX_TOP_ITEMS = DB_MAX_TOP_ITEMS;

export class InvalidRangeError extends Error {}

function toUtcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function assertRealDate(value: string): void {
  if (!DAY_PATTERN.test(value)) {
    throw new InvalidRangeError(`Expected YYYY-MM-DD, received ${value}`);
  }
  // Date.parse rolls 2026-02-30 forward to March 2 rather than rejecting it, so
  // round-trip the parse to catch a day that does not exist.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new InvalidRangeError(`Not a real date: ${value}`);
  }
}

export function parseRange(
  query: { from?: string; to?: string },
  now: () => number = Date.now,
): DateRange {
  const today = toUtcDay(now());
  const from = query.from ?? toUtcDay(now() - (DEFAULT_RANGE_DAYS - 1) * 86_400_000);
  const to = query.to ?? today;

  assertRealDate(from);
  assertRealDate(to);

  if (from > to) {
    throw new InvalidRangeError("from must not be after to");
  }

  // Both endpoints already round-tripped through Date above, so this arithmetic
  // is on real UTC midnights; +1 makes the span inclusive of both days.
  const spanDays =
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / MS_PER_DAY + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new InvalidRangeError(`Range spans ${spanDays} days; the maximum is ${MAX_RANGE_DAYS}`);
  }

  return { from, to };
}

/**
 * Returns the app with these routes chained onto it (rather than `void`), the
 * same reason registerAuthRoutes does — see that file for why. The incoming
 * `S` is generic (not defaulted to Hono's blank schema) so that a caller
 * threading in an already-chained app — auth's routes, here — keeps those
 * routes in the returned type instead of them being erased at this call.
 */
export function registerStatsRoutes<E extends Env, S extends Schema>(app: Hono<E, S>, deps: StatsDeps) {
  const withRange = <T>(handler: (range: DateRange, c: Context<E>) => Promise<T>) =>
    async (c: Context<E>) => {
      let range: DateRange;
      try {
        range = parseRange(c.req.query());
      } catch (error) {
        if (error instanceof InvalidRangeError) return c.json({ error: "invalid_range" }, 400);
        throw error;
      }
      return c.json(await handler(range, c));
    };

  return app
    .get("/api/stats/overview", withRange((range) => deps.getOverview(range)))
    .get("/api/stats/series", withRange((range) => deps.getWatchTimeSeries(range)))
    .get("/api/stats/users", withRange((range) => deps.getUserStats(range)))
    .get("/api/stats/libraries", withRange((range) => deps.getLibraryStats(range)))
    .get(
      "/api/stats/top-items",
      withRange((range, c) => {
        const requested = Number(c.req.query("limit") ?? 10);
        const limit = Number.isFinite(requested)
          ? Math.min(Math.max(1, Math.trunc(requested)), MAX_TOP_ITEMS)
          : 10;

        return deps.getTopItems(range, {
          limit,
          libraryId: c.req.query("libraryId"),
          userId: c.req.query("userId"),
        });
      }),
    )
    .get("/api/stats/users/:userId", async (c) => {
      let range: DateRange;
      try {
        range = parseRange(c.req.query());
      } catch (error) {
        if (error instanceof InvalidRangeError) return c.json({ error: "invalid_range" }, 400);
        throw error;
      }

      const detail = await deps.getUserDetail(c.req.param("userId"), range);
      if (detail === null) return c.json({ error: "not_found" }, 404);

      return c.json(detail);
    });
}
