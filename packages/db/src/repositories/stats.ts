import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { items, playbackRollupDaily } from "../schema.js";

/** Inclusive `YYYY-MM-DD` UTC days. */
export interface DateRange {
  from: string;
  to: string;
}

export interface OverviewStats {
  plays: number;
  watchMs: number;
  activeUsers: number;
  activeItems: number;
}

export interface SeriesPoint {
  day: string;
  plays: number;
  watchMs: number;
}

export interface TopItem {
  itemId: string;
  name: string;
  type: string;
  libraryId: string | null;
  seriesId: string | null;
  imageTag: string | null;
  plays: number;
  watchMs: number;
}

export async function getOverview(db: Db, range: DateRange): Promise<OverviewStats> {
  const result = await db.execute<{
    plays: string;
    watch_ms: string;
    active_users: string;
    active_items: string;
  }>(sql`
    SELECT
      coalesce(sum(play_count), 0)::text          AS plays,
      coalesce(sum(watch_ms), 0)::text            AS watch_ms,
      count(DISTINCT user_id)::text               AS active_users,
      count(DISTINCT item_id)::text               AS active_items
    FROM ${playbackRollupDaily}
    WHERE day >= ${range.from} AND day <= ${range.to}
  `);

  const row = result.rows[0];

  return {
    plays: Number(row?.plays ?? 0),
    watchMs: Number(row?.watch_ms ?? 0),
    activeUsers: Number(row?.active_users ?? 0),
    activeItems: Number(row?.active_items ?? 0),
  };
}

export async function getWatchTimeSeries(db: Db, range: DateRange): Promise<SeriesPoint[]> {
  // generate_series supplies the day spine so quiet days appear as explicit zeros.
  // Without it a chart connects across gaps and a week with no viewing looks busy.
  const result = await db.execute<{ day: string; plays: string; watch_ms: string }>(sql`
    SELECT
      to_char(spine.day, 'YYYY-MM-DD')                 AS day,
      coalesce(sum(r.play_count), 0)::text             AS plays,
      coalesce(sum(r.watch_ms), 0)::text               AS watch_ms
    FROM generate_series(${range.from}::date, ${range.to}::date, interval '1 day') AS spine(day)
    LEFT JOIN ${playbackRollupDaily} r ON r.day = spine.day
    GROUP BY spine.day
    ORDER BY spine.day
  `);

  return result.rows.map((row) => ({
    day: row.day,
    plays: Number(row.plays),
    watchMs: Number(row.watch_ms),
  }));
}

export async function getTopItems(
  db: Db,
  range: DateRange,
  options: { limit: number; libraryId?: string; userId?: string },
): Promise<TopItem[]> {
  const filters = [
    sql`${playbackRollupDaily.day} >= ${range.from}`,
    sql`${playbackRollupDaily.day} <= ${range.to}`,
  ];

  if (options.libraryId !== undefined) {
    filters.push(sql`${playbackRollupDaily.libraryId} = ${options.libraryId}`);
  }

  if (options.userId !== undefined) {
    filters.push(sql`${playbackRollupDaily.userId} = ${options.userId}`);
  }

  const rows = await db
    .select({
      itemId: playbackRollupDaily.itemId,
      name: items.name,
      type: items.type,
      libraryId: items.libraryId,
      seriesId: items.seriesId,
      imageTag: items.imageTag,
      plays: sql<string>`sum(${playbackRollupDaily.playCount})::text`,
      watchMs: sql<string>`sum(${playbackRollupDaily.watchMs})::text`,
    })
    .from(playbackRollupDaily)
    .innerJoin(items, eq(items.id, playbackRollupDaily.itemId))
    .where(and(...filters))
    .groupBy(
      playbackRollupDaily.itemId,
      items.name,
      items.type,
      items.libraryId,
      items.seriesId,
      items.imageTag,
    )
    .orderBy(desc(sql`sum(${playbackRollupDaily.watchMs})`))
    .limit(options.limit);

  return rows.map((row) => ({ ...row, plays: Number(row.plays), watchMs: Number(row.watchMs) }));
}
