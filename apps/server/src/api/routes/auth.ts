import { JellyfinAuthError } from "@jfstats/jellyfin";
import type { Context, Env, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { SessionStore } from "../sessions.js";
import type { RateLimiter } from "../rate-limit.js";

export const SESSION_COOKIE = "jfstats_session";

export interface AuthDeps {
  authenticateByName(username: string, password: string): Promise<{
    userId: string;
    userName: string;
    isAdmin: boolean;
    accessToken: string;
  }>;
  revokeToken(accessToken: string): Promise<void>;
  sessions: SessionStore;
  rateLimiter: RateLimiter;
  cookieSecure: boolean;
  sessionTtlHours: number;
  fallbackAdmin: { username: string; password: string } | null;
}

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export function registerAuthRoutes<E extends Env>(app: Hono<E>, deps: AuthDeps): void {
  app.post("/api/auth/login", async (c) => {
    const clientKey =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";

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
      if (error instanceof JellyfinAuthError && error.kind === "invalid_credentials") {
        return c.json({ error: "invalid_credentials" }, 401);
      }
      return c.json({ error: "jellyfin_unavailable" }, 503);
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
  });

  app.post("/api/auth/logout", async (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id !== undefined) {
      await deps.sessions.destroy(id);
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/auth/me", async (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    const session = id === undefined ? null : await deps.sessions.get(id);

    if (session === null) {
      return c.json({ error: "unauthenticated" }, 401);
    }

    return c.json({
      userId: session.userId,
      userName: session.userName,
      isAdmin: session.isAdmin,
    });
  });
}

function writeSessionCookie<E extends Env>(c: Context<E>, id: string, deps: AuthDeps): void {
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    secure: deps.cookieSecure,
    path: "/",
    maxAge: deps.sessionTtlHours * 60 * 60,
  });
}
