import type {
  archiveMissingItems as ArchiveMissingItems,
  Db,
  upsertItems as UpsertItems,
  upsertLibraries as UpsertLibraries,
  upsertUsers as UpsertUsers,
} from "@jfstats/db";
import type { JellyfinClient } from "@jfstats/jellyfin";

export interface ReferenceSyncDeps {
  db: Db;
  jellyfin: JellyfinClient;
  upsertUsers: typeof UpsertUsers;
  upsertLibraries: typeof UpsertLibraries;
  upsertItems: typeof UpsertItems;
  archiveMissingItems: typeof ArchiveMissingItems;
  /** Item sync is expensive; the 15-minute cycle skips it. */
  includeItems: boolean;
}

export async function runReferenceSync(deps: ReferenceSyncDeps): Promise<void> {
  const [users, libraries] = await Promise.all([
    deps.jellyfin.getUsers(),
    deps.jellyfin.getLibraries(),
  ]);

  await deps.upsertUsers(deps.db, users);
  await deps.upsertLibraries(
    deps.db,
    libraries.map((library) => ({
      id: library.id,
      name: library.name,
      collectionType: library.collectionType,
    })),
  );

  if (!deps.includeItems) return;

  const items = await deps.jellyfin.getItems();
  await deps.upsertItems(deps.db, items);
  await deps.archiveMissingItems(
    deps.db,
    items.map((item) => item.id),
  );
}
