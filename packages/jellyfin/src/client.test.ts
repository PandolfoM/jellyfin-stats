import { afterEach, describe, expect, it, vi } from "vitest";
import sessionsFixture from "./fixtures/sessions.json";
import usersFixture from "./fixtures/users.json";
import librariesFixture from "./fixtures/libraries.json";
import itemsByLibraryFixture from "./fixtures/items-by-library.json";
import { createJellyfinClient } from "./client.js";

function clientWith(payload: unknown, status = 200) {
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );

  const client = createJellyfinClient({
    baseUrl: "http://jellyfin.test:8096",
    apiKey: "test-key",
    fetch: fetchMock as unknown as typeof fetch,
  });

  return { client, fetchMock };
}

/** Routes requests by substring match against the URL, for endpoints (like getItems)
 * that issue more than one request per call. */
function clientWithRoutes(routes: Array<[path: string, payload: unknown, status?: number]>) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const match = routes.find(([path]) => url.includes(path));
    if (!match) {
      throw new Error(`Unhandled request in test: ${url}`);
    }
    return new Response(JSON.stringify(match[1]), {
      status: match[2] ?? 200,
      headers: { "content-type": "application/json" },
    });
  });

  const client = createJellyfinClient({
    baseUrl: "http://jellyfin.test:8096",
    apiKey: "test-key",
    fetch: fetchMock as unknown as typeof fetch,
  });

  return { client, fetchMock };
}

afterEach(() => vi.restoreAllMocks());

describe("createJellyfinClient", () => {
  it("sends the api key as a header, never in the query string", async () => {
    const { client, fetchMock } = clientWith(sessionsFixture);
    await client.getSessions();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("test-key");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'MediaBrowser Token="test-key"',
    });
  });

  it("maps a playing session to the LiveSession shape", async () => {
    const { client } = clientWith(sessionsFixture);
    const sessions = await client.getSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      sessionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      userId: "11111111111111111111111111111111",
      userName: "test-user-one",
      itemId: "22222222222222222222222222222222",
      itemName: "Test Episode",
      deviceId: "cccccccccccccccccccccccccccccccc",
      deviceName: "Test Device",
      client: "Jellyfin Web",
      playMethod: "DirectPlay",
      positionTicks: 12_000_000_000,
      runtimeTicks: 24_000_000_000,
      isPaused: false,
      remoteEndpoint: "192.0.2.10",
    });
  });

  it("maps a session with no PlaySessionId key at all, keyed by its Id", async () => {
    // Shaped exactly like a real Jellyfin 10.11.11 /Sessions response: PlaySessionId
    // is not a key on the object at all (not null, not undefined — absent), because
    // that field does not exist on that server version's payload.
    const raw = JSON.parse(`[
      {
        "Id": "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0",
        "UserId": "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        "UserName": "real-server-user",
        "DeviceId": "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
        "DeviceName": "Real Server Device",
        "Client": "Jellyfin Web",
        "RemoteEndPoint": "192.0.2.20",
        "PlayState": { "PositionTicks": 3000000, "IsPaused": false, "PlayMethod": "DirectPlay" },
        "NowPlayingItem": {
          "Id": "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
          "Name": "Real Server Episode",
          "Type": "Episode",
          "SeriesId": "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
          "SeasonId": "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
          "RunTimeTicks": 12000000000
        }
      }
    ]`) as unknown[];
    expect(Object.prototype.hasOwnProperty.call(raw[0], "PlaySessionId")).toBe(false);

    const { client } = clientWith(raw);
    const sessions = await client.getSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0");
  });

  it("drops sessions with no now-playing item", async () => {
    const { client } = clientWith(sessionsFixture);
    const sessions = await client.getSessions();

    expect(sessions.map((s) => s.userName)).toEqual(["test-user-one"]);
  });

  it("defaults an unrecognised play method to DirectPlay", async () => {
    const payload = [
      {
        ...sessionsFixture[0],
        PlayState: { PositionTicks: 1, IsPaused: false, PlayMethod: "SomethingNew" },
      },
    ];
    const { client } = clientWith(payload);

    expect((await client.getSessions())[0]?.playMethod).toBe("DirectPlay");
  });

  it("maps users including their administrator flag", async () => {
    const { client } = clientWith(usersFixture);
    const users = await client.getUsers();

    expect(users).toEqual([
      { id: "11111111111111111111111111111111", name: "test-user-one", isAdmin: true },
      { id: "55555555555555555555555555555555", name: "test-user-two", isAdmin: false },
    ]);
  });

  it("throws a message naming the status and endpoint on a failed request", async () => {
    const { client } = clientWith({ error: "nope" }, 401);

    await expect(client.getSessions()).rejects.toThrow(/401.*\/Sessions/);
  });

  it("throws when the response shape is not what we expect", async () => {
    const { client } = clientWith({ unexpected: true });

    await expect(client.getSessions()).rejects.toThrow(/Unexpected Jellyfin response/);
  });

  it("tags each item with the library it was queried from, not its own ParentId", async () => {
    const { movies, shows } = librariesFixture;
    const { client } = clientWithRoutes([
      ["/Library/VirtualFolders", [movies, shows]],
      [`ParentId=${movies.ItemId}`, itemsByLibraryFixture.movies],
      [`ParentId=${shows.ItemId}`, itemsByLibraryFixture.shows],
    ]);

    const items = await client.getItems();

    expect(items).toHaveLength(2);

    const movieItem = items.find((item) => item.id === itemsByLibraryFixture.movies.Items[0]?.Id);
    const episodeItem = items.find((item) => item.id === itemsByLibraryFixture.shows.Items[0]?.Id);

    expect(movieItem?.libraryId).toBe(movies.ItemId);
    expect(episodeItem?.libraryId).toBe(shows.ItemId);

    // Each fixture item's own ParentId differs from the library it belongs to
    // (season id for the episode, collection folder id for the movie) — this proves
    // libraryId came from the query, not from item.ParentId.
    expect(movieItem?.libraryId).not.toBe(itemsByLibraryFixture.movies.Items[0]?.ParentId);
    expect(episodeItem?.libraryId).not.toBe(itemsByLibraryFixture.shows.Items[0]?.ParentId);
  });

  it("maps an episode's series name and Jellyfin's index numbers", async () => {
    // Jellyfin names these from the item's own point of view: IndexNumber is the
    // episode's position in its season, and ParentIndexNumber the season's position
    // in the series. Swapping the two is the obvious mistake, so both are asserted.
    const { movies, shows } = librariesFixture;
    const { client } = clientWithRoutes([
      ["/Library/VirtualFolders", [movies, shows]],
      [`ParentId=${movies.ItemId}`, itemsByLibraryFixture.movies],
      [`ParentId=${shows.ItemId}`, itemsByLibraryFixture.shows],
    ]);

    const items = await client.getItems();
    const movieItem = items.find((item) => item.type === "Movie");
    const episodeItem = items.find((item) => item.type === "Episode");

    expect(episodeItem).toMatchObject({
      seriesName: "Fixture Series",
      seasonNumber: 2,
      episodeNumber: 5,
    });

    // A movie carries none of these fields; they must arrive null, not undefined,
    // because upsertItems writes whatever it is handed straight into the columns.
    expect(movieItem?.seriesName).toBeNull();
    expect(movieItem?.seasonNumber).toBeNull();
    expect(movieItem?.episodeNumber).toBeNull();
  });
});

describe("getItem", () => {
  const ITEM_ID = "33333333333333333333333333333333";
  // The administrator in users.json — the user context the lookup should run as.
  const ADMIN_USER_ID = "11111111111111111111111111111111";
  const itemPayload = {
    Id: ITEM_ID,
    Name: "Test Movie",
    Type: "Movie",
    Overview: "A film about testing.",
    PremiereDate: "2019-05-17T00:00:00.0000000Z",
    ProductionYear: 2019,
    RunTimeTicks: 72_000_000_000,
    Genres: ["Drama", "Comedy"],
    OfficialRating: "PG-13",
    CommunityRating: 7.4,
    Studios: [{ Name: "Test Studios", Id: "s1" }],
    ImageTags: { Primary: "img-tag" },
  };

  function itemClient(payload: unknown = itemPayload, status = 200) {
    return clientWithRoutes([
      ["/Users", usersFixture],
      [`/Items/${ITEM_ID}`, payload, status],
    ]);
  }

  it("scopes the single-item lookup to an administrator's userId, since 10.11 rejects a bare API-key lookup with 400", async () => {
    const { client, fetchMock } = itemClient();

    await client.getItem(ITEM_ID);

    const itemCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/Items/"));
    expect(String(itemCall?.[0])).toBe(
      `http://jellyfin.test:8096/Items/${ITEM_ID}?userId=${ADMIN_USER_ID}`,
    );
  });

  it("looks the user context up once and reuses it across calls", async () => {
    const { client, fetchMock } = itemClient();

    await client.getItem(ITEM_ID);
    await client.getItem(ITEM_ID);

    const userCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/Users"));
    expect(userCalls).toHaveLength(1);
  });

  it("maps the metadata fields the detail page shows", async () => {
    const { client } = itemClient();

    const item = await client.getItem(ITEM_ID);

    expect(item).toEqual({
      id: ITEM_ID,
      name: "Test Movie",
      type: "Movie",
      seriesId: null,
      seriesName: null,
      seasonNumber: null,
      episodeNumber: null,
      overview: "A film about testing.",
      premiereDate: "2019-05-17",
      productionYear: 2019,
      runtimeTicks: 72_000_000_000,
      genres: ["Drama", "Comedy"],
      officialRating: "PG-13",
      communityRating: 7.4,
      studios: ["Test Studios"],
      imageTag: "img-tag",
    });
  });

  it("returns null fields and empty lists when Jellyfin omits optional metadata", async () => {
    const { client } = itemClient({ Id: ITEM_ID, Name: "Bare", Type: "Audio" });

    const item = await client.getItem(ITEM_ID);

    expect(item).toMatchObject({
      overview: null,
      premiereDate: null,
      productionYear: null,
      runtimeTicks: null,
      genres: [],
      officialRating: null,
      communityRating: null,
      studios: [],
      imageTag: null,
    });
  });

  it("returns null for a 404 rather than throwing, so a deleted item is not a server fault", async () => {
    const { client } = itemClient({ error: "not found" }, 404);

    await expect(client.getItem(ITEM_ID)).resolves.toBeNull();
  });

  it("still throws on other failures", async () => {
    const { client } = itemClient({ error: "boom" }, 500);

    await expect(client.getItem(ITEM_ID)).rejects.toThrow(/500/);
  });

  it("throws when Jellyfin has no users to scope the lookup to", async () => {
    const { client } = clientWithRoutes([
      ["/Users", []],
      [`/Items/${ITEM_ID}`, itemPayload],
    ]);

    await expect(client.getItem(ITEM_ID)).rejects.toThrow(/no users/i);
  });
});
