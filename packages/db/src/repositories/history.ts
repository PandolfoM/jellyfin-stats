import { sql } from "drizzle-orm";
import type { Db } from "../client.js";

export const MAX_HISTORY_LIMIT = 200;
// Used when `limit`/`offset` arrive non-finite (e.g. NaN from a non-numeric query
// string param) — a bounded, reasonable page rather than a value that flows straight
// into `LIMIT`/`OFFSET` and fails at the driver.
const DEFAULT_HISTORY_LIMIT = 50;

export interface HistoryOptions {
  limit: number;
  offset: number;
  userId?: string;
  libraryId?: string;
  itemId?: string;
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
  /**
   * Episode context, null for anything that is not an episode (and for episodes
   * synced before these columns existed, until the next full item sync). The UI
   * renders whichever parts are present rather than assuming all three arrive
   * together — a special can carry a series name and no numbering.
   */
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  libraryId: string | null;
  deviceName: string | null;
  client: string | null;
  playMethod: string | null;
  startedAt: Date;
  endedAt: Date | null;
  watchMs: number;
  completed: boolean;
}

// Clamped here rather than trusted from the caller: an unbounded limit from a query
// string is a trivial denial of service. `Number.isFinite` is checked explicitly
// because `Math.max`/`Math.min` propagate NaN rather than clamping it — a NaN limit
// (e.g. from a non-numeric query string) would otherwise flow straight into
// `LIMIT ${limit}` and fail at the driver instead of being bounded. `Math.trunc`
// avoids relying on Postgres's implicit coercion for a fractional value.
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_HISTORY_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_HISTORY_LIMIT);
}

function clampOffset(offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.trunc(offset));
}

export async function getHistory(
  db: Db,
  options: HistoryOptions,
): Promise<{ rows: HistoryRow[]; total: number }> {
  const limit = clampLimit(options.limit);
  const offset = clampOffset(options.offset);

  const filters = [sql`true`];

  // A session that flaps out of Jellyfin's /Sessions payload and back closes its row
  // and opens a fresh one, because the identity index is partial (open rows only) —
  // see openSession in playback.ts. Each cycle leaves a row credited no watch time,
  // which is churn rather than a viewing, so history omits them.
  //
  // The bound is `> 0`, not some "too short to count" threshold: formatDuration
  // renders anything under a minute as seconds ("45s") and only ever returns "0m"
  // for <= 0, so this is exactly the set of rows that look empty in the UI.
  //
  // Pushed into `filters` rather than onto the row query alone, so the count(*)
  // below excludes them too — otherwise `total` would promise pages that are not
  // there. Note this does not unwind playback_rollup_daily, which still counts
  // these as plays; History will read lower than the dashboards' play counts until
  // the flapping itself is fixed.
  filters.push(sql`s.watch_ms > 0`);

  if (options.userId !== undefined) filters.push(sql`s.user_id = ${options.userId}`);
  if (options.libraryId !== undefined) filters.push(sql`i.library_id = ${options.libraryId}`);
  if (options.itemId !== undefined) filters.push(sql`s.item_id = ${options.itemId}`);
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
    series_name: string | null;
    season_number: number | null;
    episode_number: number | null;
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
      s.item_id, i.name AS item_name, i.type AS item_type,
      i.series_id, i.series_name, i.season_number, i.episode_number, i.library_id,
      d.name AS device_name, s.client, s.play_method,
      s.started_at, s.ended_at, s.watch_ms::text AS watch_ms, s.completed
    FROM playback_sessions s
    LEFT JOIN jellyfin_users u ON u.id = s.user_id
    LEFT JOIN items i         ON i.id = s.item_id
    LEFT JOIN devices d       ON d.id = s.device_id
    WHERE ${where}
    ORDER BY s.started_at DESC, s.id DESC
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
      seriesName: row.series_name,
      // Postgres INT arrives as a JS number through node-postgres, but a null column
      // must stay null rather than becoming 0 — season 0 is a real value (specials).
      seasonNumber: row.season_number === null ? null : Number(row.season_number),
      episodeNumber: row.episode_number === null ? null : Number(row.episode_number),
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
