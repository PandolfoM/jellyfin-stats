import type { ItemDetail } from "@jfstats/db";
import type { JellyfinItemDetail } from "@jfstats/jellyfin";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerItemRoutes, type ItemDeps } from "./items.js";

const ITEM_ID = "a1b2c3d4e5f67890a1b2c3d4e5f67890";
const RANGE = "from=2026-08-01&to=2026-08-31";

const LOCAL: ItemDetail = {
  itemId: ITEM_ID,
  name: "Fishes",
  type: "Episode",
  libraryId: "lib-shows",
  libraryName: "Shows",
  seriesId: "series-1",
  seriesName: "The Bear",
  seasonNumber: 2,
  episodeNumber: 6,
  productionYear: 2023,
  runtimeTicks: 39_000_000_000,
  imageTag: "tag-ep",
  plays: 4,
  watchMs: 110_000,
  uniqueUsers: 2,
};

const REMOTE: JellyfinItemDetail = {
  id: ITEM_ID,
  name: "Fishes",
  type: "Episode",
  seriesId: "series-1",
  seriesName: "The Bear",
  seasonNumber: 2,
  episodeNumber: 6,
  overview: "Christmas dinner.",
  premiereDate: "2023-06-22",
  productionYear: 2023,
  runtimeTicks: 39_000_000_000,
  genres: ["Drama"],
  officialRating: "TV-MA",
  communityRating: 9.6,
  studios: ["FX"],
  imageTag: "tag-ep",
};

function build(overrides: Partial<ItemDeps> = {}) {
  const deps: ItemDeps = {
    getItemDetail: vi.fn(async () => LOCAL),
    fetchItemMetadata: vi.fn(async () => REMOTE),
    ...overrides,
  };
  const app = new Hono();
  registerItemRoutes(app, deps);
  return { app, deps };
}

describe("GET /api/items/:itemId", () => {
  it("merges the local row and stats with Jellyfin's descriptive metadata", async () => {
    const { app } = build();

    const response = await app.request(`/api/items/${ITEM_ID}?${RANGE}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...LOCAL,
      metadata: {
        overview: "Christmas dinner.",
        premiereDate: "2023-06-22",
        genres: ["Drama"],
        officialRating: "TV-MA",
        communityRating: 9.6,
        studios: ["FX"],
      },
    });
  });

  it("passes the parsed range to the stats lookup", async () => {
    const { app, deps } = build();

    await app.request(`/api/items/${ITEM_ID}?${RANGE}`);

    expect(deps.getItemDetail).toHaveBeenCalledWith(ITEM_ID, {
      from: "2026-08-01",
      to: "2026-08-31",
    });
  });

  it("still answers with the local row when Jellyfin is unreachable", async () => {
    const { app } = build({
      fetchItemMetadata: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    });

    const response = await app.request(`/api/items/${ITEM_ID}?${RANGE}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...LOCAL, metadata: null });
  });

  it("falls back to Jellyfin's fields with zeroed stats when the item was never synced", async () => {
    const { app } = build({ getItemDetail: vi.fn(async () => null) });

    const response = await app.request(`/api/items/${ITEM_ID}?${RANGE}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      itemId: ITEM_ID,
      name: "Fishes",
      type: "Episode",
      seriesName: "The Bear",
      libraryId: null,
      libraryName: null,
      plays: 0,
      watchMs: 0,
      uniqueUsers: 0,
      metadata: { overview: "Christmas dinner." },
    });
  });

  it("answers 404 when neither the database nor Jellyfin knows the item", async () => {
    const { app } = build({
      getItemDetail: vi.fn(async () => null),
      fetchItemMetadata: vi.fn(async () => null),
    });

    const response = await app.request(`/api/items/${ITEM_ID}?${RANGE}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("answers 404 when the database has nothing and Jellyfin is unreachable", async () => {
    const { app } = build({
      getItemDetail: vi.fn(async () => null),
      fetchItemMetadata: vi.fn(async () => {
        throw new Error("timeout");
      }),
    });

    expect((await app.request(`/api/items/${ITEM_ID}?${RANGE}`)).status).toBe(404);
  });

  it("rejects an id that is not a 32-hex GUID before touching any dependency", async () => {
    const { app, deps } = build();

    const response = await app.request("/api/items/..%2F..%2FUsers");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_item_id" });
    expect(deps.fetchItemMetadata).not.toHaveBeenCalled();
    expect(deps.getItemDetail).not.toHaveBeenCalled();
  });

  it("rejects a malformed range", async () => {
    const { app } = build();

    const response = await app.request(`/api/items/${ITEM_ID}?from=yesterday&to=2026-08-31`);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_range" });
  });
});
