import { getConnInfo } from "@hono/node-server/conninfo";
import { JellyfinAuthError } from "@jfstats/jellyfin";
import type { Context, Env, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { SessionRecord, SessionStore } from "../sessions.js";
import type { RateLimiter } from "../rate-limit.js";

/** The context variable requireAdmin populates; /api/auth/me reads it. */
export type SessionEnv = { Variables: { session: SessionRecord } };

export const SESSION_COOKIE = "jfstats_session";

/** The subset of config needed to write the session cookie. Shared with the
 * admin middleware so a session refresh re-issues an identical cookie. */
export interface SessionCookieConfig {
  cookieSecure: boolean;
  sessionTtlHours: number;
}

export interface AuthDeps extends SessionCookieConfig {
  authenticateByName(
    username: string,
    password: string,
  ): Promise<{
    userId: string;
    userName: string;
    isAdmin: boolean;
    accessToken: string;
  }>;
  revokeToken(accessToken: string): Promise<void>;
  sessions: SessionStore;
  rateLimiter: RateLimiter;
  fallbackAdmin: { username: string; password: string } | null;
  // Off unless a reverse proxy that actually sets X-Forwarded-For sits in
  // front of the app. See resolveClientKey for why this gates the header.
  trustProxyHeaders: boolean;
}

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * Returns the app with these routes chained onto it (rather than `void`) so
 * that `hc<AppType>` on the web side can actually see `/api/auth/*` in its
 * schema. A bare `app.post(...)` statement mutates the same Hono instance at
 * runtime either way, but only the chained return value carries the route
 * types back to the caller — assigning it is what makes the typed client
 * usable instead of resolving to `unknown`.
 */
export function registerAuthRoutes<E extends Env & SessionEnv>(app: Hono<E>, deps: AuthDeps) {
  return (
    app
      .post("/api/auth/login", async (c) => {
        const clientKey = resolveClientKey(c, deps);

        const limit = await deps.rateLimiter.check(clientKey);
        if (!limit.allowed) {
          return c.json({ error: "too_many_attempts" }, 429);
        }

        const body = loginSchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) {
          return c.json({ error: "invalid_request" }, 400);
        }

        const { username, password } = body.data;

        // Checked before Jellyfin on purpose: the fallback exists precisely for when
        // Jellyfin is unreachable, so it cannot depend on reaching it.
        if (
          deps.fallbackAdmin !== null &&
          username === deps.fallbackAdmin.username &&
          password === deps.fallbackAdmin.password
        ) {
          const id = await deps.sessions.create({
            userId: "fallback-admin",
            userName: username,
            isAdmin: true,
            createdAt: Date.now(),
          });
          writeSessionCookie(c, id, deps);
          return c.json({ userId: "fallback-admin", userName: username, isAdmin: true });
        }

        let result: Awaited<ReturnType<AuthDeps["authenticateByName"]>>;

        try {
          result = await deps.authenticateByName(username, password);
        } catch (error) {
          if (error instanceof JellyfinAuthError) {
            if (error.kind === "invalid_credentials") {
              return c.json({ error: "invalid_credentials" }, 401);
            }
            return c.json({ error: "jellyfin_unavailable" }, 503);
          }
          // Not a recognized auth failure — a real bug, not a Jellyfin outage.
          // Rethrow so it reaches app.onError, gets logged, and answers 500
          // rather than being mislabelled as "jellyfin_unavailable".
          throw error;
        }

        // Revoke regardless of the admin decision — we asked Jellyfin for a token we
        // never intend to use, and leaving it live is a credential we do not need.
        await deps.revokeToken(result.accessToken);

        if (!result.isAdmin) {
          return c.json({ error: "not_an_administrator" }, 403);
        }

        const id = await deps.sessions.create({
          userId: result.userId,
          userName: result.userName,
          isAdmin: true,
          createdAt: Date.now(),
        });
        writeSessionCookie(c, id, deps);

        return c.json({ userId: result.userId, userName: result.userName, isAdmin: true });
      })
      .post("/api/auth/logout", async (c) => {
        const id = getCookie(c, SESSION_COOKIE);
        if (id !== undefined) {
          await deps.sessions.destroy(id);
        }
        deleteCookie(c, SESSION_COOKIE, { path: "/" });
        return c.json({ ok: true });
      })
      // No session lookup of its own: requireAdmin (mounted in api/app.ts) is the
      // single gate, and it is what re-checks isAdmin and refreshes both sides of
      // the session — its TTL and the browser cookie. Reading the store
      // directly here slid the TTL without re-issuing the cookie, so a client
      // polling only this route kept its server-side session alive while its own
      // cookie expired on the maxAge fixed at login.
      .get("/api/auth/me", (c) => {
        const session = c.get("session");

        return c.json({
          userId: session.userId,
          userName: session.userName,
          isAdmin: session.isAdmin,
        });
      })
  );
}

/**
 * X-Forwarded-For is whatever the client sends unless something in front of
 * this app overwrites it. Trusting it unconditionally lets an attacker mint a
 * fresh rate-limit identity on every request (header-set) while pooling every
 * legitimate caller into one "unknown" bucket when nobody sets it at all
 * (worse than no mitigation). So: the header is only consulted when the
 * deployment has explicitly said a real proxy is in front of it. Otherwise
 * the key is the TCP connection's own remote address, which the client does
 * not control.
 */
function resolveClientKey<E extends Env>(c: Context<E>, deps: AuthDeps): string {
  if (deps.trustProxyHeaders) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded !== undefined && forwarded.length > 0) {
      return forwarded;
    }
    const realIp = c.req.header("x-real-ip");
    if (realIp !== undefined && realIp.length > 0) {
      return realIp;
    }
    return "unknown";
  }

  // Last resort only: reachable when this isn't served through
  // @hono/node-server (e.g. a bare test harness with no connection bound).
  try {
    const address = getConnInfo(c).remote.address;
    if (address !== undefined && address.length > 0) {
      return address;
    }
  } catch {
    // fall through
  }
  return "unknown";
}

/**
 * Writes the session cookie. Shared by login (fresh cookie) and the admin
 * middleware (refresh on each authenticated request) so the two can never
 * drift into writing subtly different cookies for the same session.
 */
export function writeSessionCookie<E extends Env>(
  c: Context<E>,
  id: string,
  config: SessionCookieConfig,
): void {
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: config.sessionTtlHours * 60 * 60,
  });
}
