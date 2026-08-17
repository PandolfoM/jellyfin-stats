import {
  getHistory,
  getLibraryStats,
  getOverview,
  getTopItems,
  getUserDetail,
  getUserStats,
  getWatchTimeSeries,
} from "@jfstats/db";
import type { AppEnv } from "@jfstats/shared";
import { Hono } from "hono";
import type Redis from "ioredis";
import type { AppContext } from "../context.js";
import { LIVE_CHANNEL } from "../sync/snapshot-store.js";
import { requireAdmin } from "./middleware/auth.js";
import { createRateLimiter } from "./rate-limit.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerImageRoutes, type ImageDeps } from "./routes/images.js";
import { registerLiveRoute, type LiveDeps } from "./routes/live.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { createSessionStore, type SessionRecord } from "./sessions.js";

/** Populated by requireAdmin (see middleware/auth.ts) once a request's
 * session has been resolved and re-checked for admin access. */
export interface AppVariables {
  session: SessionRecord;
}

/**
 * A subscribed ioredis client cannot run ordinary commands, so this duplicates
 * the shared connection rather than reusing it — sharing it would break the
 * session store on the first SSE connection.
 *
 * Exported so the exception-safety of the try/catch below (a duplicated
 * connection must not be leaked if the SUBSCRIBE call itself fails) can be
 * unit-tested without going through the full authenticated request path.
 */
export function createLiveSubscriber(redis: Redis): LiveDeps["subscribe"] {
  return async (onMessage) => {
    const subscriber = redis.duplicate();
    try {
      await subscriber.subscribe(LIVE_CHANNEL);
    } catch (error) {
      // subscriber.duplicate() already opened the connection; if SUBSCRIBE
      // itself fails, nothing else will ever call quit() on it.
      await subscriber.quit();
      throw error;
    }
    subscriber.on("message", (_channel, payload) => onMessage(payload));
    return async () => {
      await subscriber.quit();
    };
  };
}

/**
 * Builds the outbound Jellyfin request for one item's poster art.
 *
 * itemId is validated as a 32-character hex GUID by registerImageRoutes
 * before this ever runs, but it is still encodeURIComponent'd here rather
 * than interpolated raw: Hono's router matches :itemId against the
 * still-encoded path segment, and c.req.param() only decodeURIComponent's
 * it *after* matching succeeds. A payload like "..%2F..%2FUsers%23" decodes
 * to the literal "../../Users#" — dot-segments the URL constructor collapses
 * and an unescaped "#" it treats as a fragment, silently dropping the
 * "/Images/Primary" suffix that was supposed to pin the request. Since the
 * admin Jellyfin API key rides along in this request's Authorization header,
 * an unpinned path would hand that key to whatever endpoint survived. Belt
 * and braces: the validator in images.ts is the primary defense; this
 * encoding means a future loosening of that validator does not immediately
 * reopen the traversal.
 *
 * Exported so the URL-building logic can be unit-tested directly, the same
 * way createLiveSubscriber below is tested without going through the full
 * authenticated request path.
 */
export function createImageFetcher(
  env: Pick<AppEnv, "JELLYFIN_URL" | "JELLYFIN_API_KEY">,
): ImageDeps["fetchImage"] {
  return async (itemId, options) => {
    const url = new URL(`${env.JELLYFIN_URL}/Items/${encodeURIComponent(itemId)}/Images/Primary`);
    url.searchParams.set("maxWidth", String(options.maxWidth));
    if (options.tag !== undefined) url.searchParams.set("tag", options.tag);

    // The API key travels only in this server-to-server Authorization
    // header — never in the URL (query strings end up in logs) and never
    // forwarded to the browser.
    return fetch(url, {
      headers: { Authorization: `MediaBrowser Token="${env.JELLYFIN_API_KEY}"` },
      signal: AbortSignal.timeout(15_000),
    });
  };
}

export function createApp(context: AppContext) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  const sessions = createSessionStore(context.redis, context.env.SESSION_TTL_HOURS * 60 * 60);
  const rateLimiter = createRateLimiter(context.redis, { limit: 10, windowSeconds: 900 });

  registerAuthRoutes(app, {
    authenticateByName: (u, p) => context.jellyfin.authenticateByName(u, p),
    revokeToken: (t) => context.jellyfin.revokeToken(t),
    sessions,
    rateLimiter,
    cookieSecure: context.env.COOKIE_SECURE,
    sessionTtlHours: context.env.SESSION_TTL_HOURS,
    trustProxyHeaders: context.env.TRUST_PROXY_HEADERS,
    fallbackAdmin:
      context.env.fallbackAdminEnabled &&
      context.env.FALLBACK_ADMIN_USER !== undefined &&
      context.env.FALLBACK_ADMIN_PASSWORD !== undefined
        ? {
            username: context.env.FALLBACK_ADMIN_USER,
            password: context.env.FALLBACK_ADMIN_PASSWORD,
          }
        : null,
  });

  const cookieConfig = {
    cookieSecure: context.env.COOKIE_SECURE,
    sessionTtlHours: context.env.SESSION_TTL_HOURS,
  };

  app.use("/api/stats/*", requireAdmin(sessions, cookieConfig));
  app.use("/api/history", requireAdmin(sessions, cookieConfig));
  // The live feed exposes who is watching what, in real time — the same
  // sensitivity as history, and gated the same way.
  app.use("/api/live", requireAdmin(sessions, cookieConfig));
  // Ungated, this would let anyone who can reach the port enumerate a
  // private media library by walking item ids.
  app.use("/api/images/*", requireAdmin(sessions, cookieConfig));

  registerStatsRoutes(app, {
    getOverview: (range) => getOverview(context.db, range),
    getWatchTimeSeries: (range) => getWatchTimeSeries(context.db, range),
    getTopItems: (range, options) => getTopItems(context.db, range, options),
    getUserStats: (range) => getUserStats(context.db, range),
    getUserDetail: (userId, range) => getUserDetail(context.db, userId, range),
    getLibraryStats: (range) => getLibraryStats(context.db, range),
  });

  registerHistoryRoutes(app, { getHistory: (options) => getHistory(context.db, options) });

  registerImageRoutes(app, { fetchImage: createImageFetcher(context.env) });

  registerLiveRoute(app, {
    loadCurrent: () => context.snapshots.loadLive(),
    subscribe: createLiveSubscriber(context.redis),
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  // The client learns that the request failed, not why. Details go to the log,
  // which is redacted; an error message can carry a connection string.
  app.onError((error, c) => {
    context.logger?.error({ err: error, path: c.req.path }, "unhandled api error");
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
