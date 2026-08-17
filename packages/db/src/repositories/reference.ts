import { inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { devices, items, jellyfinUsers, libraries } from "../schema.js";

export interface UserInput {
  id: string;
  name: string;
  isAdmin: boolean;
  lastSeenAt?: Date;
}

export interface LibraryInput {
  id: string;
  name: string;
  collectionType?: string | null;
  itemCount?: number;
}

export interface ItemInput {
  id: string;
  type: string;
  name: string;
  libraryId?: string | null;
  seriesId?: string | null;
  seasonId?: string | null;
  productionYear?: number | null;
  runtimeTicks?: number | null;
  imageTag?: string | null;
}

export interface DeviceInput {
  id: string;
  name: string;
  client?: string | null;
  lastSeenAt?: Date;
}

export async function upsertUsers(db: Db, rows: UserInput[]): Promise<void> {
  if (rows.length === 0) return;

  await db
    .insert(jellyfinUsers)
    .values(rows.map((row) => ({ ...row, archived: false })))
    .onConflictDoUpdate({
      target: jellyfinUsers.id,
      set: {
        name: sql`excluded.name`,
        isAdmin: sql`excluded.is_admin`,
        lastSeenAt: sql`excluded.last_seen_at`,
        // Reappearing in Jellyfin un-archives the row.
        archived: sql`false`,
      },
    });
}

export async function upsertLibraries(db: Db, rows: LibraryInput[]): Promise<void> {
  if (rows.length === 0) return;

  await db
    .insert(libraries)
    .values(rows.map((row) => ({ ...row, archived: false })))
    .onConflictDoUpdate({
      target: libraries.id,
      set: {
        name: sql`excluded.name`,
        collectionType: sql`excluded.collection_type`,
        itemCount: sql`excluded.item_count`,
        archived: sql`false`,
      },
    });
}

export async function upsertItems(db: Db, rows: ItemInput[]): Promise<void> {
  if (rows.length === 0) return;

  // Chunked because a full library sync can exceed Postgres' parameter limit.
  const CHUNK_SIZE = 500;

  for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + CHUNK_SIZE);

    await db
      .insert(items)
      .values(chunk.map((row) => ({ ...row, archived: false })))
      .onConflictDoUpdate({
        target: items.id,
        set: {
          libraryId: sql`excluded.library_id`,
          type: sql`excluded.type`,
          name: sql`excluded.name`,
          seriesId: sql`excluded.series_id`,
          seasonId: sql`excluded.season_id`,
          productionYear: sql`excluded.production_year`,
          runtimeTicks: sql`excluded.runtime_ticks`,
          imageTag: sql`excluded.image_tag`,
          archived: sql`false`,
        },
      });
  }
}

export async function upsertDevice(db: Db, row: DeviceInput): Promise<void> {
  await db
    .insert(devices)
    .values(row)
    .onConflictDoUpdate({
      target: devices.id,
      set: {
        name: sql`excluded.name`,
        client: sql`excluded.client`,
        lastSeenAt: sql`excluded.last_seen_at`,
      },
    });
}

/**
 * Marks items no longer present in Jellyfin as archived. Rows are never deleted, so
 * watch history for a removed file survives.
 *
 * An empty `presentIds` is treated as a failed sync rather than an emptied server —
 * archiving the entire catalogue because one API call returned nothing would be far
 * worse than skipping a cycle.
 */
export async function archiveMissingItems(db: Db, presentIds: string[]): Promise<number> {
  if (presentIds.length === 0) return 0;

  const archived = await db
    .update(items)
    .set({ archived: true })
    .where(notInArray(items.id, presentIds))
    .returning({ id: items.id });

  return archived.length;
}

export async function findItemsByIds(db: Db, ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(items).where(inArray(items.id, ids));
}
