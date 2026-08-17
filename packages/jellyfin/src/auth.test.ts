import { afterEach, describe, expect, it, vi } from "vitest";
import { createJellyfinClient } from "./client.js";
import { JellyfinAuthError } from "./auth.js";

const AUTH_OK = {
  AccessToken: "fabricated-access-token",
  User: {
    Id: "11111111111111111111111111111111",
    Name: "test-admin",
    Policy: { IsAdministrator: true },
  },
};

function clientWith(payload: unknown, status = 200) {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    new Response(status === 204 ? null : JSON.stringify(payload), {
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

describe("authenticateByName", () => {
  it("posts the credentials and maps the result", async () => {
    const { client, fetchMock } = clientWith(AUTH_OK);

    const result = await client.authenticateByName("test-admin", "secret");

    expect(result).toEqual({
      userId: "11111111111111111111111111111111",
      userName: "test-admin",
      isAdmin: true,
      accessToken: "fabricated-access-token",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/Users/AuthenticateByName");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("sends the client identification header Jellyfin requires", async () => {
    const { client, fetchMock } = clientWith(AUTH_OK);
    await client.authenticateByName("test-admin", "secret");

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const auth = (init as RequestInit).headers as Record<string, string>;
    // Jellyfin rejects AuthenticateByName without Client/Device/DeviceId/Version.
    expect(auth.Authorization).toMatch(/MediaBrowser Client=".+", Device=".+", DeviceId=".+", Version=".+"/);
  });

  it("never puts the password in the URL", async () => {
    const { client, fetchMock } = clientWith(AUTH_OK);
    await client.authenticateByName("test-admin", "hunter2");

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("hunter2");
  });

  it("reports a rejected password as invalid_credentials", async () => {
    const { client } = clientWith({}, 401);

    await expect(client.authenticateByName("test-admin", "wrong")).rejects.toMatchObject({
      kind: "invalid_credentials",
    });
  });

  it("reports an unreachable server as unreachable, not as a bad password", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createJellyfinClient({
      baseUrl: "http://jellyfin.test:8096",
      apiKey: "test-key",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.authenticateByName("test-admin", "secret")).rejects.toMatchObject({
      kind: "unreachable",
    });
  });

  it("treats a 500 from Jellyfin as unreachable rather than invalid credentials", async () => {
    const { client } = clientWith({}, 500);

    await expect(client.authenticateByName("test-admin", "secret")).rejects.toMatchObject({
      kind: "unreachable",
    });
  });

  it("maps a non-admin account without throwing", async () => {
    const { client } = clientWith({
      ...AUTH_OK,
      User: { ...AUTH_OK.User, Policy: { IsAdministrator: false } },
    });

    // The admin gate lives in the route, not the client — the client reports facts.
    expect((await client.authenticateByName("test-admin", "secret")).isAdmin).toBe(false);
  });

  it("treats a missing Policy as not-admin", async () => {
    const { client } = clientWith({ ...AUTH_OK, User: { Id: "u1", Name: "n" } });

    expect((await client.authenticateByName("n", "secret")).isAdmin).toBe(false);
  });

  it("is a JellyfinAuthError so callers can narrow on it", async () => {
    const { client } = clientWith({}, 401);

    await expect(client.authenticateByName("a", "b")).rejects.toBeInstanceOf(JellyfinAuthError);
  });
});

describe("revokeToken", () => {
  it("posts to the logout endpoint with the issued token", async () => {
    const { client, fetchMock } = clientWith(null, 204);

    await client.revokeToken("fabricated-access-token");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/Sessions/Logout");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toContain('Token="fabricated-access-token"');
  });

  it("does not throw when revocation fails", async () => {
    const { client } = clientWith({}, 500);

    // Revocation is best-effort cleanup; a failure must not break the user's login.
    await expect(client.revokeToken("fabricated-access-token")).resolves.toBeUndefined();
  });
});
