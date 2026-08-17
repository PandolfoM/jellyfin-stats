import { afterEach, describe, expect, it, vi } from "vitest";
import sessionsFixture from "./fixtures/sessions.json";
import usersFixture from "./fixtures/users.json";
import { createJellyfinClient } from "./client.js";

function clientWith(payload: unknown, status = 200) {
  const fetchMock = vi.fn<typeof fetch>(async () =>
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
      playSessionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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
});
