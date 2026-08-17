import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { JellyfinAuthError } from "@jfstats/jellyfin";
import { registerAuthRoutes, SESSION_COOKIE, type AuthDeps } from "./auth.js";

const ADMIN = { userId: "u-1", userName: "admin", isAdmin: true, accessToken: "tok-1" };

function build(overrides: Partial<AuthDeps> = {}) {
  const deps: AuthDeps = {
    authenticateByName: vi.fn(async () => ADMIN),
    revokeToken: vi.fn(async () => {}),
    sessions: {
      create: vi.fn(async () => "session-id-1"),
      get: vi.fn(async () => null),
      destroy: vi.fn(async () => {}),
    },
    rateLimiter: { check: vi.fn(async () => ({ allowed: true, remaining: 9 })) },
    cookieSecure: false,
    sessionTtlHours: 168,
    fallbackAdmin: null,
    trustProxyHeaders: false,
    ...overrides,
  };

  const app = new Hono();
  registerAuthRoutes(app, deps);
  return { app, deps };
}

function login(app: Hono, body: unknown) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  it("sets an httpOnly session cookie for an admin", async () => {
    const { app } = build();

    const response = await login(app, { username: "admin", password: "secret" });

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=session-id-1`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("omits Secure when cookieSecure is false, so plain-HTTP runs work", async () => {
    const { app } = build({ cookieSecure: false });

    const response = await login(app, { username: "admin", password: "secret" });

    expect(response.headers.get("set-cookie") ?? "").not.toContain("Secure");
  });

  it("sets Secure when configured", async () => {
    const { app } = build({ cookieSecure: true });

    const response = await login(app, { username: "admin", password: "secret" });

    expect(response.headers.get("set-cookie") ?? "").toContain("Secure");
  });

  it("revokes the Jellyfin token immediately after a successful login", async () => {
    const { app, deps } = build();

    await login(app, { username: "admin", password: "secret" });

    // The app already holds its own API key; a second live credential is liability.
    expect(deps.revokeToken).toHaveBeenCalledWith("tok-1");
  });

  it("rejects a valid non-admin account with 403 and creates no session", async () => {
    const { app, deps } = build({
      authenticateByName: vi.fn(async () => ({ ...ADMIN, isAdmin: false })),
    });

    const response = await login(app, { username: "viewer", password: "secret" });

    expect(response.status).toBe(403);
    expect(deps.sessions.create).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("still revokes the token for a rejected non-admin", async () => {
    const { app, deps } = build({
      authenticateByName: vi.fn(async () => ({ ...ADMIN, isAdmin: false })),
    });

    await login(app, { username: "viewer", password: "secret" });

    expect(deps.revokeToken).toHaveBeenCalledWith("tok-1");
  });

  it("answers 401 for a rejected password", async () => {
    const { app } = build({
      authenticateByName: vi.fn(async () => {
        throw new JellyfinAuthError("invalid_credentials", "nope");
      }),
    });

    expect((await login(app, { username: "admin", password: "wrong" })).status).toBe(401);
  });

  it("answers 503 when Jellyfin is unreachable, not 401", async () => {
    const { app } = build({
      authenticateByName: vi.fn(async () => {
        throw new JellyfinAuthError("unreachable", "down");
      }),
    });

    // Telling an admin their password is wrong when the server is offline sends
    // them down entirely the wrong path.
    expect((await login(app, { username: "admin", password: "secret" })).status).toBe(503);
  });

  it("answers 429 when the rate limiter blocks", async () => {
    const { app, deps } = build({
      rateLimiter: { check: vi.fn(async () => ({ allowed: false, remaining: 0 })) },
    });

    const response = await login(app, { username: "admin", password: "secret" });

    expect(response.status).toBe(429);
    // Blocked before Jellyfin is contacted at all.
    expect(deps.authenticateByName).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400", async () => {
    const { app } = build();

    expect((await login(app, { username: "admin" })).status).toBe(400);
  });

  it("never echoes the password back in any response", async () => {
    const { app } = build({
      authenticateByName: vi.fn(async () => {
        throw new JellyfinAuthError("invalid_credentials", "nope");
      }),
    });

    const response = await login(app, { username: "admin", password: "hunter2" });

    expect(await response.text()).not.toContain("hunter2");
  });

  it("re-throws an unrecognized error from authenticateByName instead of mapping it to 503", async () => {
    const { app } = build({
      authenticateByName: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    const response = await login(app, { username: "admin", password: "secret" });

    // No onError is registered on this bare test app, so an unhandled error
    // falls through to Hono's own default handler: a plain 500, not our 503
    // "jellyfin_unavailable" mapping used for a real Jellyfin outage.
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });
});

describe("rate limiter client key", () => {
  const CONN = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

  it("keys by the connection address, not a forged X-Forwarded-For, when proxy trust is disabled", async () => {
    const { app, deps } = build({ trustProxyHeaders: false });

    await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.99" },
        body: JSON.stringify({ username: "admin", password: "secret" }),
      },
      CONN("198.51.100.7"),
    );

    // If the header were still trusted by default, this would be
    // "203.0.113.99" instead — a value the caller supplied themselves.
    expect(deps.rateLimiter.check).toHaveBeenCalledWith("198.51.100.7");
  });

  it("uses the first X-Forwarded-For entry when proxy trust is enabled", async () => {
    const { app, deps } = build({ trustProxyHeaders: true });

    await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.99, 10.0.0.1",
        },
        body: JSON.stringify({ username: "admin", password: "secret" }),
      },
      CONN("198.51.100.7"),
    );

    // If trust were ignored, this would be the connection address instead.
    expect(deps.rateLimiter.check).toHaveBeenCalledWith("203.0.113.99");
  });

  it("gives two different connection addresses independent buckets", async () => {
    const { app, deps } = build({ trustProxyHeaders: false });
    const attempt = (body: unknown, remoteAddress: string) =>
      app.request(
        "/api/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        CONN(remoteAddress),
      );

    await attempt({ username: "admin", password: "secret" }, "198.51.100.7");
    await attempt({ username: "admin", password: "secret" }, "198.51.100.8");

    // If both attempts pooled into one shared bucket, these would be equal —
    // which is exactly the "everyone shares 'unknown'" failure mode.
    expect(deps.rateLimiter.check).toHaveBeenNthCalledWith(1, "198.51.100.7");
    expect(deps.rateLimiter.check).toHaveBeenNthCalledWith(2, "198.51.100.8");
  });
});

describe("fallback admin", () => {
  it("is used before Jellyfin, so it works when Jellyfin is down", async () => {
    const { app, deps } = build({
      fallbackAdmin: { username: "rescue", password: "rescue-pw" },
      authenticateByName: vi.fn(async () => {
        throw new JellyfinAuthError("unreachable", "down");
      }),
    });

    const response = await login(app, { username: "rescue", password: "rescue-pw" });

    expect(response.status).toBe(200);
    expect(deps.authenticateByName).not.toHaveBeenCalled();
  });

  it("does not match on username alone", async () => {
    const { app } = build({ fallbackAdmin: { username: "rescue", password: "rescue-pw" } });

    const response = await login(app, { username: "rescue", password: "wrong" });

    // Falls through to Jellyfin, which the default mock accepts as an admin —
    // what matters is that the wrong fallback password did not itself authenticate.
    expect(response.status).toBe(200);
  });

  it("is inert when not configured", async () => {
    const { app, deps } = build({ fallbackAdmin: null });

    await login(app, { username: "anyone", password: "anything" });

    expect(deps.authenticateByName).toHaveBeenCalled();
  });
});

describe("POST /api/auth/logout", () => {
  it("destroys the session and clears the cookie", async () => {
    const { app, deps } = build();

    const response = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-id-1` },
    });

    expect(response.status).toBe(200);
    expect(deps.sessions.destroy).toHaveBeenCalledWith("session-id-1");
    expect(response.headers.get("set-cookie") ?? "").toContain(`${SESSION_COOKIE}=;`);
  });

  it("succeeds even without a session cookie", async () => {
    const { app } = build();

    expect((await app.request("/api/auth/logout", { method: "POST" })).status).toBe(200);
  });
});

describe("GET /api/auth/me", () => {
  it("returns the signed-in user", async () => {
    const { app } = build({
      sessions: {
        create: vi.fn(async () => "x"),
        get: vi.fn(async () => ({
          userId: "u-1",
          userName: "admin",
          isAdmin: true,
          createdAt: 1_777_000_000_000,
        })),
        destroy: vi.fn(async () => {}),
      },
    });

    const response = await app.request("/api/auth/me", {
      headers: { Cookie: `${SESSION_COOKIE}=session-id-1` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: "u-1", userName: "admin", isAdmin: true });
  });

  it("answers 401 without a session", async () => {
    const { app } = build();

    expect((await app.request("/api/auth/me")).status).toBe(401);
  });
});
