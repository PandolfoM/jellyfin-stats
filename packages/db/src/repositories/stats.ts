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

export interface UserStat {
  userId: string;
  name: string;
  isAdmin: boolean;
  plays: number;
  watchMs: number;
}

export interface LibraryStat {
  libraryId: string;
  name: string;
  collectionType: string | null;
  plays: number;
  watchMs: number;
}

export interface UserDetail extends UserStat {
  devices: { deviceId: string; name: string; plays: number }[];
}

export async function getUserStats(db: Db, range: DateRange): Promise<UserStat[]> {
  // LEFT JOIN from users, not from the rollup: a user who took a week off must
  // still appear, with zeros, rather than vanishing from the list.
  const result = await db.execute<{
    user_id: string;
    name: string;
    is_admin: boolean;
    plays: string;
    watch_ms: string;
  }>(sql`
    SELECT
      u.id                                    AS user_id,
      u.name                                  AS name,
      u.is_admin                              AS is_admin,
      coalesce(sum(r.play_count), 0)::text    AS plays,
      coalesce(sum(r.watch_ms), 0)::text      AS watch_ms
    FROM jellyfin_users u
    LEFT JOIN playback_rollup_daily r
      ON r.user_id = u.id AND r.day >= ${range.from} AND r.day <= ${range.to}
    WHERE u.archived = false
    GROUP BY u.id, u.name, u.is_admin
    ORDER BY coalesce(sum(r.watch_ms), 0) DESC, u.name ASC
  `);

  return result.rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    isAdmin: row.is_admin,
    plays: Number(row.plays),
    watchMs: Number(row.watch_ms),
  }));
}

export async function getLibraryStats(db: Db, range: DateRange): Promise<LibraryStat[]> {
  const result = await db.execute<{
    library_id: string;
    name: string;
    collection_type: string | null;
    plays: string;
    watch_ms: string;
  }>(sql`
    SELECT
      l.id                                    AS library_id,
      l.name                                  AS name,
      l.collection_type                       AS collection_type,
      coalesce(sum(r.play_count), 0)::text    AS plays,
      coalesce(sum(r.watch_ms), 0)::text      AS watch_ms
    FROM libraries l
    LEFT JOIN playback_rollup_daily r
      ON r.library_id = l.id AND r.day >= ${range.from} AND r.day <= ${range.to}
    WHERE l.archived = false
    GROUP BY l.id, l.name, l.collection_type
    ORDER BY coalesce(sum(r.watch_ms), 0) DESC, l.name ASC
  `);

  return result.rows.map((row) => ({
    libraryId: row.library_id,
    name: row.name,
    collectionType: row.collection_type,
    plays: Number(row.plays),
    watchMs: Number(row.watch_ms),
  }));
}

export async function getUserDetail(
  db: Db,
  userId: string,
  range: DateRange,
): Promise<UserDetail | null> {
  const totals = await db.execute<{
    user_id: string;
    name: string;
    is_admin: boolean;
    plays: string;
    watch_ms: string;
  }>(sql`
    SELECT
      u.id AS user_id, u.name AS name, u.is_admin AS is_admin,
      coalesce(sum(r.play_count), 0)::text AS plays,
      coalesce(sum(r.watch_ms), 0)::text   AS watch_ms
    FROM jellyfin_users u
    LEFT JOIN playback_rollup_daily r
      ON r.user_id = u.id AND r.day >= ${range.from} AND r.day <= ${range.to}
    WHERE u.id = ${userId}
    GROUP BY u.id, u.name, u.is_admin
  `);

  const row = totals.rows[0];
  if (row === undefined) return null;

  // Device breakdown comes from the session table — it is per-user and small,
  // and the rollup deliberately does not carry device identity.
  const devices = await db.execute<{ device_id: string; name: string; plays: string }>(sql`
    SELECT
      s.device_id                        AS device_id,
      coalesce(d.name, 'Unknown device') AS name,
      count(*)::text                     AS plays
    FROM playback_sessions s
    LEFT JOIN devices d ON d.id = s.device_id
    WHERE s.user_id = ${userId}
      AND s.ended_at IS NOT NULL
      AND (s.started_at AT TIME ZONE 'UTC')::date >= ${range.from}::date
      AND (s.started_at AT TIME ZONE 'UTC')::date <= ${range.to}::date
      AND s.device_id IS NOT NULL
    GROUP BY s.device_id, d.name
    ORDER BY count(*) DESC
  `);

  return {
    userId: row.user_id,
    name: row.name,
    isAdmin: row.is_admin,
    plays: Number(row.plays),
    watchMs: Number(row.watch_ms),
    devices: devices.rows.map((device) => ({
      deviceId: device.device_id,
      name: device.name,
      plays: Number(device.plays),
    })),
  };
}
