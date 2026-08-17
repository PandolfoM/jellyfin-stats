import { sql } from "drizzle-orm";
import type { Db } from "../client.js";

export const MAX_HISTORY_LIMIT = 200;

export interface HistoryOptions {
  limit: number;
  offset: number;
  userId?: string;
  libraryId?: string;
  /** Inclusive `YYYY-MM-DD` UTC day, matched against the session's start day. */
  from?: string;
  to?: string;
}

export interface HistoryRow {
  id: string;
  userId: string;
  userName: string;
  itemId: string;
  itemName: string;
  itemType: string;
  seriesId: string | null;
  libraryId: string | null;
  deviceName: string | null;
  client: string | null;
  playMethod: string | null;
  startedAt: Date;
  endedAt: Date | null;
  watchMs: number;
  completed: boolean;
}

export async function getHistory(
  db: Db,
  options: HistoryOptions,
): Promise<{ rows: HistoryRow[]; total: number }> {
  // Clamped here rather than trusted from the caller: an unbounded limit from a
  // query string is a trivial denial of service.
  const limit = Math.min(Math.max(1, options.limit), MAX_HISTORY_LIMIT);
  const offset = Math.max(0, options.offset);

  const filters = [sql`true`];

  if (options.userId !== undefined) filters.push(sql`s.user_id = ${options.userId}`);
  if (options.libraryId !== undefined) filters.push(sql`i.library_id = ${options.libraryId}`);
  if (options.from !== undefined) {
    filters.push(sql`(s.started_at AT TIME ZONE 'UTC')::date >= ${options.from}::date`);
  }
  if (options.to !== undefined) {
    filters.push(sql`(s.started_at AT TIME ZONE 'UTC')::date <= ${options.to}::date`);
  }

  const where = sql.join(filters, sql` AND `);

  const rows = await db.execute<{
    id: string;
    user_id: string;
    user_name: string | null;
    item_id: string;
    item_name: string | null;
    item_type: string | null;
    series_id: string | null;
    library_id: string | null;
    device_name: string | null;
    client: string | null;
    play_method: string | null;
    // Drizzle's node-postgres execute() path forces the TIMESTAMPTZ/TIMESTAMP type
    // parsers to identity for raw sql`` queries (unlike the query builder, which maps
    // through its schema-aware decoders), so these arrive as ISO strings, not Date —
    // converted explicitly below, the same way watch_ms is.
    started_at: string;
    ended_at: string | null;
    watch_ms: string;
    completed: boolean;
  }>(sql`
    SELECT
      s.id::text AS id, s.user_id, u.name AS user_name,
      s.item_id, i.name AS item_name, i.type AS item_type, i.series_id, i.library_id,
      d.name AS device_name, s.client, s.play_method,
      s.started_at, s.ended_at, s.watch_ms::text AS watch_ms, s.completed
    FROM playback_sessions s
    LEFT JOIN jellyfin_users u ON u.id = s.user_id
    LEFT JOIN items i         ON i.id = s.item_id
    LEFT JOIN devices d       ON d.id = s.device_id
    WHERE ${where}
    ORDER BY s.started_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const totals = await db.execute<{ total: string }>(sql`
    SELECT count(*)::text AS total
    FROM playback_sessions s
    LEFT JOIN items i ON i.id = s.item_id
    WHERE ${where}
  `);

  return {
    rows: rows.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      userName: row.user_name ?? "Unknown user",
      itemId: row.item_id,
      itemName: row.item_name ?? "Unknown item",
      itemType: row.item_type ?? "Unknown",
      seriesId: row.series_id,
      libraryId: row.library_id,
      deviceName: row.device_name,
      client: row.client,
      playMethod: row.play_method,
      startedAt: new Date(row.started_at),
      endedAt: row.ended_at === null ? null : new Date(row.ended_at),
      watchMs: Number(row.watch_ms),
      completed: row.completed,
    })),
    total: Number(totals.rows[0]?.total ?? 0),
  };
}
