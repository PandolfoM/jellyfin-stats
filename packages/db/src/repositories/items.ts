import { sql } from "drizzle-orm";
import type { Db } from "../client.js";
import type { DateRange } from "./stats.js";

/**
 * One reference item plus its play totals for a range — the database half of
 * the item detail page. Descriptive metadata (synopsis, premiere date, genres,
 * ratings) is not synced and comes from Jellyfin at request time instead; see
 * apps/server/src/api/routes/items.ts for how the two are merged.
 */
export interface ItemDetail {
  itemId: string;
  name: string;
  type: string;
  libraryId: string | null;
  libraryName: string | null;
  seriesId: string | null;
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  productionYear: number | null;
  runtimeTicks: number | null;
  imageTag: string | null;
  plays: number;
  watchMs: number;
  /** Distinct users with at least one play of this item in the range. */
  uniqueUsers: number;
}

export async function getItemDetail(
  db: Db,
  itemId: string,
  range: DateRange,
): Promise<ItemDetail | null> {
  const result = await db.execute<{
    item_id: string;
    name: string;
    type: string;
    library_id: string | null;
    library_name: string | null;
    series_id: string | null;
    series_name: string | null;
    season_number: number | null;
    episode_number: number | null;
    production_year: number | null;
    // bigint columns arrive as strings from node-postgres on the raw execute()
    // path; cast explicitly below, the same way the aggregates are.
    runtime_ticks: string | null;
    image_tag: string | null;
    plays: string;
    watch_ms: string;
    unique_users: string;
  }>(sql`
    SELECT
      i.id AS item_id, i.name, i.type, i.library_id, l.name AS library_name,
      i.series_id, i.series_name, i.season_number, i.episode_number,
      i.production_year, i.runtime_ticks::text AS runtime_ticks, i.image_tag,
      coalesce(sum(r.play_count), 0)::text AS plays,
      coalesce(sum(r.watch_ms), 0)::text   AS watch_ms,
      count(DISTINCT r.user_id)::text      AS unique_users
    FROM items i
    LEFT JOIN libraries l ON l.id = i.library_id
    LEFT JOIN playback_rollup_daily r
      ON r.item_id = i.id AND r.day >= ${range.from} AND r.day <= ${range.to}
    WHERE i.id = ${itemId}
    GROUP BY i.id, i.name, i.type, i.library_id, l.name,
      i.series_id, i.series_name, i.season_number, i.episode_number,
      i.production_year, i.runtime_ticks, i.image_tag
  `);

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    itemId: row.item_id,
    name: row.name,
    type: row.type,
    libraryId: row.library_id,
    libraryName: row.library_name,
    seriesId: row.series_id,
    seriesName: row.series_name,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    productionYear: row.production_year,
    runtimeTicks: row.runtime_ticks === null ? null : Number(row.runtime_ticks),
    imageTag: row.image_tag,
    plays: Number(row.plays),
    watchMs: Number(row.watch_ms),
    uniqueUsers: Number(row.unique_users),
  };
}
