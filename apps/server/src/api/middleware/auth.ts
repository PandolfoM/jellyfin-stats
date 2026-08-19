import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE, writeSessionCookie, type SessionCookieConfig } from "../routes/auth.js";
import type { SessionRecord, SessionStore } from "../sessions.js";

export function requireAdmin(
  sessions: SessionStore,
  cookieConfig: SessionCookieConfig,
): MiddlewareHandler<{ Variables: { session: SessionRecord } }> {
  return async (c, next) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id === undefined) {
      return c.json({ error: "unauthenticated" }, 401);
    }

    const session = await sessions.get(id);

    // Re-check isAdmin rather than trusting that login gated it. A stored
    // session record must never be sufficient on its own to grant access —
    // this is the layer that still refuses if a session was ever created by
    // a path that skipped the admin check, or an old record survived a
    // policy change.
    if (session === null || !session.isAdmin) {
      return c.json({ error: "unauthenticated" }, 401);
    }

    c.set("session", session);

    // sessions.get() above already slid the session's TTL forward (see
    // sessions.ts), but the browser's cookie maxAge was fixed at login and
    // never refreshed on its own. Without this, an actively-used session
    // stays alive server-side indefinitely while the browser drops the
    // cookie on schedule regardless of activity, forcing an unexpected
    // re-login. Reusing writeSessionCookie keeps the attributes identical to
    // what login set, rather than risking a second, subtly different cookie.
    writeSessionCookie(c, id, cookieConfig);

    await next();
  };
}
