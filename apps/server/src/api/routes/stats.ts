import type { DateRange, LibraryStat, OverviewStats, SeriesPoint, TopItem, UserDetail, UserStat } from "@jfstats/db";
import type { Context, Env, Hono } from "hono";

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
export const MAX_TOP_ITEMS = 100;

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

  return { from, to };
}

export function registerStatsRoutes<E extends Env>(app: Hono<E>, deps: StatsDeps): void {
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

  app.get("/api/stats/overview", withRange((range) => deps.getOverview(range)));
  app.get("/api/stats/series", withRange((range) => deps.getWatchTimeSeries(range)));
  app.get("/api/stats/users", withRange((range) => deps.getUserStats(range)));
  app.get("/api/stats/libraries", withRange((range) => deps.getLibraryStats(range)));

  app.get(
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
  );

  app.get("/api/stats/users/:userId", async (c) => {
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
