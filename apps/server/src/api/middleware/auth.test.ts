import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requireAdmin } from "./auth.js";
import { SESSION_COOKIE, type SessionCookieConfig } from "../routes/auth.js";
import type { SessionRecord, SessionStore } from "../sessions.js";

const SESSION: SessionRecord = {
  userId: "u-1",
  userName: "admin",
  isAdmin: true,
  createdAt: 1_777_000_000_000,
};

const COOKIE_CONFIG: SessionCookieConfig = { cookieSecure: false, sessionTtlHours: 168 };

function build(get: SessionStore["get"], cookieConfig: SessionCookieConfig = COOKIE_CONFIG) {
  const sessions: SessionStore = {
    create: vi.fn(async () => "x"),
    get,
    destroy: vi.fn(async () => {}),
  };
  const app = new Hono<{ Variables: { session: SessionRecord } }>();
  app.use("/api/protected", requireAdmin(sessions, cookieConfig));
  app.get("/api/protected", (c) => c.json({ user: c.var.session.userName }));
  return app;
}

describe("requireAdmin", () => {
  it("allows a request carrying a valid admin session", async () => {
    const app = build(vi.fn(async () => SESSION));

    const response = await app.request("/api/protected", {
      headers: { Cookie: `${SESSION_COOKIE}=session-id-1` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: "admin" });
  });

  it("rejects a request with no cookie", async () => {
    const app = build(vi.fn(async () => SESSION));

    expect((await app.request("/api/protected")).status).toBe(401);
  });

  it("rejects an unknown or expired session id", async () => {
    const app = build(vi.fn(async () => null));

    const response = await app.request("/api/protected", {
      headers: { Cookie: `${SESSION_COOKIE}=stale-session` },
    });

    expect(response.status).toBe(401);
  });

  it("rejects a session whose isAdmin flag is false", async () => {
    const app = build(vi.fn(async () => ({ ...SESSION, isAdmin: false })));

    const response = await app.request("/api/protected", {
      headers: { Cookie: `${SESSION_COOKIE}=session-id-1` },
    });

    // Defence in depth: login already gates on this, but a stored session must
    // never grant access on its own.
    expect(response.status).toBe(401);
  });

  it("re-issues the session cookie with a fresh Max-Age on a successful request", async () => {
    // The session's TTL slides on every sessions.get() (see sessions.ts), but
    // the browser's cookie maxAge is fixed at login. Refreshing the cookie here
    // keeps the two in agreement instead of the browser dropping an
    // otherwise-still-alive session.
    const app = build(vi.fn(async () => SESSION), { cookieSecure: true, sessionTtlHours: 168 });

    const response = await app.request("/api/protected", {
      headers: { Cookie: `${SESSION_COOKIE}=session-id-1` },
    });

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=session-id-1`);
    expect(cookie).toMatch(/Max-Age=\d+/);
    // Must match login's cookie attributes exactly, or this becomes a second,
    // subtly different cookie rather than a refresh of the same one.
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
  });

  it("sets no cookie on a rejected request, whether missing, unknown, or non-admin", async () => {
    const missingCookie = await build(vi.fn(async () => SESSION)).request("/api/protected");
    expect(missingCookie.headers.get("set-cookie")).toBeNull();

    const unknownSession = await build(vi.fn(async () => null)).request("/api/protected", {
      headers: { Cookie: `${SESSION_COOKIE}=stale-session` },
    });
    expect(unknownSession.headers.get("set-cookie")).toBeNull();

    const nonAdmin = await build(vi.fn(async () => ({ ...SESSION, isAdmin: false }))).request(
      "/api/protected",
      { headers: { Cookie: `${SESSION_COOKIE}=session-id-1` } },
    );
    expect(nonAdmin.headers.get("set-cookie")).toBeNull();
  });
});
