import type { DateRange, ItemDetail } from "@jfstats/db";
import type { JellyfinItemDetail } from "@jfstats/jellyfin";
import type { Env, Hono, Schema } from "hono";
import { InvalidRangeError, parseRange } from "./stats.js";

export interface ItemDeps {
  /** Null when the item is not in the synced reference table. */
  getItemDetail(itemId: string, range: DateRange): Promise<ItemDetail | null>;
  /**
   * Live lookup against Jellyfin. Null when Jellyfin answers 404; rejects
   * when Jellyfin cannot be reached at all. Both are tolerated here — the
   * page degrades to whatever the database has rather than failing.
   */
  fetchItemMetadata(itemId: string): Promise<JellyfinItemDetail | null>;
}

/** The subset of Jellyfin's item that the database does not hold. */
export interface ItemMetadata {
  overview: string | null;
  premiereDate: string | null;
  genres: string[];
  officialRating: string | null;
  communityRating: number | null;
  studios: string[];
}

export type ItemDetailResponse = ItemDetail & { metadata: ItemMetadata | null };

// Same rule as the image proxy (images.ts): the id is validated before it can
// reach any outbound request, so a traversal payload never rides to Jellyfin
// alongside the admin API key.
const ITEM_ID_PATTERN = /^[0-9a-f]{32}$/i;

function toMetadata(remote: JellyfinItemDetail): ItemMetadata {
  return {
    overview: remote.overview,
    premiereDate: remote.premiereDate,
    genres: remote.genres,
    officialRating: remote.officialRating,
    communityRating: remote.communityRating,
    studios: remote.studios,
  };
}

/** Header fields for an item Jellyfin knows but the reference sync has not caught up to. */
function fromRemoteOnly(remote: JellyfinItemDetail): ItemDetail {
  return {
    itemId: remote.id,
    name: remote.name,
    type: remote.type,
    libraryId: null,
    libraryName: null,
    seriesId: remote.seriesId,
    seriesName: remote.seriesName,
    seasonNumber: remote.seasonNumber,
    episodeNumber: remote.episodeNumber,
    productionYear: remote.productionYear,
    runtimeTicks: remote.runtimeTicks,
    imageTag: remote.imageTag,
    plays: 0,
    watchMs: 0,
    uniqueUsers: 0,
  };
}

/**
 * Returns the app with this route chained onto it (rather than `void`), the
 * same reason registerAuthRoutes does — see that file for why.
 */
export function registerItemRoutes<E extends Env, S extends Schema>(
  app: Hono<E, S>,
  deps: ItemDeps,
) {
  return app.get("/api/items/:itemId", async (c) => {
    const itemId = c.req.param("itemId");
    if (!ITEM_ID_PATTERN.test(itemId)) {
      return c.json({ error: "invalid_item_id" }, 400);
    }

    let range: DateRange;
    try {
      range = parseRange(c.req.query());
    } catch (error) {
      if (error instanceof InvalidRangeError) return c.json({ error: "invalid_range" }, 400);
      throw error;
    }

    const [local, remote] = await Promise.all([
      deps.getItemDetail(itemId, range),
      // An unreachable Jellyfin is not this page's failure: the database
      // half still renders, with the descriptive block marked unavailable.
      deps.fetchItemMetadata(itemId).catch(() => null),
    ]);

    if (local === null) {
      if (remote === null) return c.json({ error: "not_found" }, 404);
      const body: ItemDetailResponse = { ...fromRemoteOnly(remote), metadata: toMetadata(remote) };
      return c.json(body);
    }

    const body: ItemDetailResponse = {
      ...local,
      metadata: remote === null ? null : toMetadata(remote),
    };
    return c.json(body);
  });
}
