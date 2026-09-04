// @vitest-environment jsdom
//
// /items/$itemId is a container route: it reads the item id from the real
// router param and fires itemDetailQuery, historyQuery (filtered to that
// item) and settingsQuery (for the "Open in Jellyfin" link). Every case
// navigates through `renderApp` with a real path, so the router's own
// `$itemId` parsing is what gets exercised — never a hand-picked id passed
// straight to a component.
//
// The two states that must render *differently*: a 404 from the API (the
// not-found screen) versus an item the database knows but Jellyfin cannot
// describe right now (`metadata: null`) — the latter still renders the page,
// with the descriptive block marked unavailable, because the play stats and
// history are real regardless of whether Jellyfin is reachable.
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ItemDetailResponse } from "../api/queries";
import { renderApp } from "../test/renderApp";

afterEach(() => vi.restoreAllMocks());

const ITEM_ID = "a1b2c3d4e5f67890a1b2c3d4e5f67890";

const AUTHENTICATED_BODY = { userId: "session-user", userName: "admin", isAdmin: true };

const SETTINGS_BODY = {
  sessionPollIntervalMs: 5_000,
  referenceSyncIntervalMs: 900_000,
  completionThreshold: 0.9,
  jellyfinUrl: "http://jellyfin.example.invalid",
  customCss: "",
  sync: { available: true, running: false, lastRunAt: null },
};

const EPISODE: ItemDetailResponse = {
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
  runtimeTicks: 39 * 60 * 1000 * 10_000,
  imageTag: "tag-ep",
  plays: 4,
  watchMs: 110_000,
  uniqueUsers: 2,
  metadata: {
    overview: "Christmas dinner goes badly.",
    premiereDate: "2023-06-22",
    genres: ["Drama", "Comedy"],
    officialRating: "TV-MA",
    communityRating: 9.6,
    studios: ["FX"],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchOverrides {
  item?: (itemId: string) => Response;
  history?: (params: URLSearchParams) => Response;
}

function mockFetch(overrides: FetchOverrides = {}): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);

      if (url.includes("/api/auth/me")) return jsonResponse(AUTHENTICATED_BODY);
      if (url.includes("/api/settings")) return jsonResponse(SETTINGS_BODY);
      if (url.includes("/api/items/")) {
        const itemId = (url.split("?")[0] ?? url).split("/api/items/")[1] ?? "";
        return overrides.item?.(itemId) ?? jsonResponse({ error: "not_found" }, 404);
      }
      if (url.includes("/api/history")) {
        const params = new URL(url, "http://localhost").searchParams;
        return overrides.history?.(params) ?? jsonResponse({ rows: [], total: 0 });
      }

      throw new Error(`items.$itemId.test.tsx did not expect a fetch to ${url}`);
    }),
  );
  return calls;
}

function paramsFor(calls: string[], pathIncludes: string): URLSearchParams | undefined {
  const match = calls.filter((url) => url.includes(pathIncludes)).at(-1);
  return match !== undefined ? new URL(match, "http://localhost").searchParams : undefined;
}

describe("Item detail route", () => {
  it("reads the itemId from the real router param and fetches that item", async () => {
    const calls = mockFetch({
      item: (itemId) => jsonResponse({ ...EPISODE, itemId, name: `Item ${itemId.slice(0, 4)}` }),
    });

    renderApp(`/items/${ITEM_ID}`);

    await screen.findByTestId("item-detail-route");
    expect(await screen.findByRole("heading", { level: 1, name: "Item a1b2" })).toBeInTheDocument();
    expect(calls.some((url) => url.includes(`/api/items/${ITEM_ID}`))).toBe(true);
  });

  it("renders the descriptive details Jellyfin supplied", async () => {
    mockFetch({ item: () => jsonResponse(EPISODE) });

    renderApp(`/items/${ITEM_ID}`);

    await screen.findByTestId("item-detail-route");
    expect(await screen.findByText("22 Jun 2023")).toBeInTheDocument();
    expect(screen.getByText("39m")).toBeInTheDocument();
    expect(screen.getByText("Drama, Comedy")).toBeInTheDocument();
    expect(screen.getByText("TV-MA")).toBeInTheDocument();
    expect(screen.getByText("9.6 / 10")).toBeInTheDocument();
    expect(screen.getByText("FX")).toBeInTheDocument();
    expect(screen.getByText("Christmas dinner goes badly.")).toBeInTheDocument();
    expect(screen.getByText("Shows")).toBeInTheDocument();
  });

  it("shows the series and S/E numbering for an episode", async () => {
    mockFetch({ item: () => jsonResponse(EPISODE) });

    renderApp(`/items/${ITEM_ID}`);

    expect(await screen.findByText("The Bear · S2E6")).toBeInTheDocument();
  });

  it("shows the play stats for the range", async () => {
    mockFetch({ item: () => jsonResponse(EPISODE) });

    renderApp(`/items/${ITEM_ID}`);

    await screen.findByTestId("item-detail-route");
    expect(await screen.findByText("Plays")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Watch time")).toBeInTheDocument();
    expect(screen.getByText("Unique viewers")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("still renders the page, with the details marked unavailable, when metadata is null", async () => {
    mockFetch({ item: () => jsonResponse({ ...EPISODE, metadata: null }) });

    renderApp(`/items/${ITEM_ID}`);

    expect(await screen.findByTestId("item-detail-route")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "Fishes" })).toBeInTheDocument();
    expect(screen.getByTestId("item-metadata-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("item-detail-not-found")).not.toBeInTheDocument();
  });

  it("renders the not-found state for an id the API answers 404 for", async () => {
    mockFetch({ item: () => jsonResponse({ error: "not_found" }, 404) });

    renderApp(`/items/${ITEM_ID}`);

    expect(await screen.findByTestId("item-detail-not-found")).toBeInTheDocument();
    expect(screen.getByText("Item not found")).toBeInTheDocument();
    expect(screen.queryByTestId("item-detail-route")).not.toBeInTheDocument();
  });

  it("filters playback history to this item", async () => {
    const calls = mockFetch({ item: () => jsonResponse(EPISODE) });

    renderApp(`/items/${ITEM_ID}`);

    await waitFor(() => expect(paramsFor(calls, "/api/history")).toBeDefined());
    expect(paramsFor(calls, "/api/history")?.get("itemId")).toBe(ITEM_ID);
  });

  it("links to the item in Jellyfin using the configured server URL", async () => {
    mockFetch({ item: () => jsonResponse(EPISODE) });

    renderApp(`/items/${ITEM_ID}`);

    const link = await screen.findByRole("link", { name: "Open in Jellyfin" });
    expect(link).toHaveAttribute(
      "href",
      `http://jellyfin.example.invalid/web/#/details?id=${ITEM_ID}`,
    );
  });
});
