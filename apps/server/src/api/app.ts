import {
  getHistory,
  getLibraryStats,
  getOverview,
  getTopItems,
  getUserDetail,
  getUserStats,
  getWatchTimeSeries,
} from "@jfstats/db";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { LIVE_CHANNEL } from "../sync/snapshot-store.js";
import { requireAdmin } from "./middleware/auth.js";
import { createRateLimiter } from "./rate-limit.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerImageRoutes } from "./routes/images.js";
import { registerLiveRoute } from "./routes/live.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { createSessionStore, type SessionRecord } from "./sessions.js";

/** Populated by requireAdmin (see middleware/auth.ts) once a request's
 * session has been resolved and re-checked for admin access. */
export interface AppVariables {
  session: SessionRecord;
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

  registerImageRoutes(app, {
    fetchImage: async (itemId, options) => {
      const url = new URL(`${context.env.JELLYFIN_URL}/Items/${itemId}/Images/Primary`);
      url.searchParams.set("maxWidth", String(options.maxWidth));
      if (options.tag !== undefined) url.searchParams.set("tag", options.tag);

      // The API key travels only in this server-to-server Authorization
      // header — never in the URL (query strings end up in logs) and never
      // forwarded to the browser.
      return fetch(url, {
        headers: { Authorization: `MediaBrowser Token="${context.env.JELLYFIN_API_KEY}"` },
        signal: AbortSignal.timeout(15_000),
      });
    },
  });

  registerLiveRoute(app, {
    loadCurrent: () => context.snapshots.loadLive(),
    subscribe: async (onMessage) => {
      // A subscribed ioredis client cannot run ordinary commands. Sharing
      // context.redis would break the session store on the first SSE connection.
      const subscriber = context.redis.duplicate();
      await subscriber.subscribe(LIVE_CHANNEL);
      subscriber.on("message", (_channel, payload) => onMessage(payload));
      return async () => {
        await subscriber.quit();
      };
    },
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
