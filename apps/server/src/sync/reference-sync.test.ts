import { describe, expect, it, vi } from "vitest";
import type { JellyfinLibrary, JellyfinUser, JellyfinItem } from "@jfstats/jellyfin";
import { runReferenceSync, type ReferenceSyncDeps } from "./reference-sync.js";

function deps(
  users: JellyfinUser[],
  libraries: JellyfinLibrary[],
  items: JellyfinItem[],
  includeItems: boolean,
): ReferenceSyncDeps {
  return {
    db: {} as ReferenceSyncDeps["db"],
    jellyfin: {
      getUsers: vi.fn(async () => users),
      getLibraries: vi.fn(async () => libraries),
      getItems: vi.fn(async () => items),
    } as unknown as ReferenceSyncDeps["jellyfin"],
    upsertUsers: vi.fn(async () => {}),
    upsertLibraries: vi.fn(async () => {}),
    upsertItems: vi.fn(async () => {}),
    archiveMissingItems: vi.fn(async () => 0),
    includeItems,
  };
}

describe("runReferenceSync", () => {
  it("syncs users and libraries when includeItems is false", async () => {
    const users: JellyfinUser[] = [{ id: "user-1", name: "Alice", isAdmin: true }];
    const libraries: JellyfinLibrary[] = [{ id: "lib-1", name: "Films", collectionType: "movies" }];
    const items: JellyfinItem[] = [
      {
        id: "item-1",
        name: "Test Movie",
        type: "Movie",
        libraryId: "lib-1",
        seriesId: null,
        seasonId: null,
        productionYear: null,
        runtimeTicks: null,
        imageTag: null,
      },
    ];

    const d = deps(users, libraries, items, false);
    await runReferenceSync(d);

    expect(d.upsertUsers).toHaveBeenCalledWith(d.db, users);
    expect(d.upsertLibraries).toHaveBeenCalledWith(d.db, [
      { id: "lib-1", name: "Films", collectionType: "movies" },
    ]);
  });

  it("skips items entirely when includeItems is false", async () => {
    const users: JellyfinUser[] = [{ id: "user-1", name: "Bob", isAdmin: false }];
    const libraries: JellyfinLibrary[] = [
      { id: "lib-2", name: "Shows", collectionType: "tvshows" },
    ];
    const items: JellyfinItem[] = [
      {
        id: "item-2",
        name: "Test Show",
        type: "Series",
        libraryId: "lib-2",
        seriesId: null,
        seasonId: null,
        productionYear: null,
        runtimeTicks: null,
        imageTag: null,
      },
    ];

    const d = deps(users, libraries, items, false);
    await runReferenceSync(d);

    expect(d.jellyfin.getItems as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(d.upsertItems).not.toHaveBeenCalled();
    expect(d.archiveMissingItems).not.toHaveBeenCalled();
  });

  it("syncs items and archives when includeItems is true", async () => {
    const users: JellyfinUser[] = [{ id: "user-3", name: "Charlie", isAdmin: false }];
    const libraries: JellyfinLibrary[] = [{ id: "lib-3", name: "Music", collectionType: "music" }];
    const items: JellyfinItem[] = [
      {
        id: "item-3",
        name: "Song One",
        type: "Audio",
        libraryId: "lib-3",
        seriesId: null,
        seasonId: null,
        productionYear: null,
        runtimeTicks: null,
        imageTag: null,
      },
      {
        id: "item-4",
        name: "Song Two",
        type: "Audio",
        libraryId: "lib-3",
        seriesId: null,
        seasonId: null,
        productionYear: null,
        runtimeTicks: null,
        imageTag: null,
      },
    ];

    const d = deps(users, libraries, items, true);
    await runReferenceSync(d);

    expect(d.upsertItems).toHaveBeenCalledWith(d.db, items);
    expect(d.archiveMissingItems).toHaveBeenCalledWith(d.db, ["item-3", "item-4"]);
  });

  it("preserves distinct field values when mapping libraries", async () => {
    const users: JellyfinUser[] = [];
    const libraries: JellyfinLibrary[] = [
      { id: "lib-distinct-1", name: "FilmsLibrary", collectionType: "movies" },
      { id: "lib-distinct-2", name: "ShowsLibrary", collectionType: "tvshows" },
    ];
    const items: JellyfinItem[] = [];

    const d = deps(users, libraries, items, false);
    await runReferenceSync(d);

    expect(d.upsertLibraries).toHaveBeenCalledWith(d.db, [
      { id: "lib-distinct-1", name: "FilmsLibrary", collectionType: "movies" },
      { id: "lib-distinct-2", name: "ShowsLibrary", collectionType: "tvshows" },
    ]);
  });
});
