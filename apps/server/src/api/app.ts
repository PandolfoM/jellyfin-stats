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
import { attachRedisErrorLogger, type AppContext } from "../context.js";
import type { Logger } from "../logger.js";
import { LIVE_CHANNEL } from "../sync/snapshot-store.js";
import { requireAdmin } from "./middleware/auth.js";
import { createRateLimiter } from "./rate-limit.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerImageRoutes, type ImageDeps } from "./routes/images.js";
import { registerLiveRoute, type LiveDeps } from "./routes/live.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerStaticRoutes } from "./static.js";
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
export function createLiveSubscriber(
  redis: Redis,
  logger: Pick<Logger, "error">,
): LiveDeps["subscribe"] {
  return async (onMessage) => {
    const subscriber = redis.duplicate();
    // Before SUBSCRIBE, so a failure during the round trip is already covered.
    // duplicate() does not carry listeners over, and there is one of these
    // connections per attached dashboard tab — each would otherwise fall back to
    // ioredis's unredacted console.error.
    attachRedisErrorLogger(subscriber, logger, "live subscriber connection error");
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
      // Swallowed here rather than at each call site. One of those call sites is
      // the stream's abort path, where Hono invokes subscribers through forEach
      // with no error handling — and ioredis rejects pending commands with
      // "Connection is closed." whenever the connection has already dropped. An
      // unobserved rejection there terminates the process under Node's default
      // --unhandled-rejections=throw. The connection being gone is exactly the
      // outcome quit() was called for, so there is nothing to report.
      try {
        await subscriber.quit();
      } catch {
        // already gone
      }
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

// No explicit return-type interface on createApp below — an annotation there
// would erase the richer, chained route schema that registerAuthRoutes (and
// every registerXRoutes call threaded after it) hands back (an annotated
// return type widens to the annotation, not the actual inferred value).
// AppType is derived from the real return value instead, so `hc<AppType>` on
// the web side sees every /api/* route registered below rather than
// resolving to `unknown`.
export function createApp(context: AppContext) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  const sessions = createSessionStore(context.redis, context.env.SESSION_TTL_HOURS * 60 * 60);
  const rateLimiter = createRateLimiter(context.redis, { limit: 10, windowSeconds: 900 });

  const cookieConfig = {
    cookieSecure: context.env.COOKIE_SECURE,
    sessionTtlHours: context.env.SESSION_TTL_HOURS,
  };

  // Every gate is declared here, in one block, ahead of the route registrations
  // it protects — Hono runs handlers for a path in registration order, so a
  // middleware registered after its route silently never runs first.
  //
  // /api/auth/me is gated like everything else rather than reading the session
  // store itself: reading it directly slid the Redis TTL without re-issuing the
  // cookie, so a client polling only /me kept its server-side session alive
  // while its browser cookie expired on the maxAge fixed at login. It was also
  // the one place a session was honoured without re-checking isAdmin.
  app.use("/api/auth/me", requireAdmin(sessions, cookieConfig));
  app.use("/api/stats/*", requireAdmin(sessions, cookieConfig));
  app.use("/api/history", requireAdmin(sessions, cookieConfig));
  // The live feed exposes who is watching what, in real time — the same
  // sensitivity as history, and gated the same way.
  app.use("/api/live", requireAdmin(sessions, cookieConfig));
  // Ungated, this would let anyone who can reach the port enumerate a
  // private media library by walking item ids.
  app.use("/api/images/*", requireAdmin(sessions, cookieConfig));
  // The effective sync intervals, completion threshold, and Jellyfin server
  // URL are configuration, not secrets — but they are still only meant for
  // whoever configured this deployment, not anyone who can reach the port.
  app.use("/api/settings", requireAdmin(sessions, cookieConfig));

  // Captured, and threaded into every registerXRoutes call below, because the
  // chained return value is what the web client's AppType is built from — see
  // registerAuthRoutes for why a bare statement here would lose the schema.
  const routedApp = registerAuthRoutes(app, {
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

  // Each of these, like registerAuthRoutes above, is threaded through the
  // previous call's returned app rather than the original `app` variable —
  // that chaining is what lets AppType (below) see auth, stats, history,
  // images, and live routes all together instead of only whichever call ran
  // last. app.notFound/app.onError below don't add typed routes, so they stay
  // on the original `app` (the same underlying instance either way).
  const statsApp = registerStatsRoutes(routedApp, {
    getOverview: (range) => getOverview(context.db, range),
    getWatchTimeSeries: (range) => getWatchTimeSeries(context.db, range),
    getTopItems: (range, options) => getTopItems(context.db, range, options),
    getUserStats: (range) => getUserStats(context.db, range),
    getUserDetail: (userId, range) => getUserDetail(context.db, userId, range),
    getLibraryStats: (range) => getLibraryStats(context.db, range),
  });

  const historyApp = registerHistoryRoutes(statsApp, {
    getHistory: (options) => getHistory(context.db, options),
  });

  // Built from context.env by picking exactly these four fields, by name —
  // this call site is the allow-list boundary settings.ts's own comment
  // refers to. Passing context.env itself (or any wider object) here would
  // defeat the whole point: registerSettingsRoutes only ever reads the
  // fields SettingsDeps declares, but nothing stops a future edit from
  // handing it something bigger unless this stays an explicit pick.
  const settingsApp = registerSettingsRoutes(historyApp, {
    sessionPollIntervalMs: context.env.SESSION_POLL_INTERVAL_MS,
    referenceSyncIntervalMs: context.env.REFERENCE_SYNC_INTERVAL_MS,
    completionThreshold: context.env.COMPLETION_THRESHOLD,
    jellyfinUrl: context.env.JELLYFIN_URL,
  });

  const imagesApp = registerImageRoutes(settingsApp, { fetchImage: createImageFetcher(context.env) });

  // registerLiveRoute returns one object carrying both the chained app (used
  // just below) and the LiveStreamRegistry members themselves — see that
  // file for why this one is flattened rather than following the same
  // pattern as statsApp/historyApp/imagesApp above.
  const liveStreams = registerLiveRoute(imagesApp, {
    loadCurrent: () => context.snapshots.loadLive(),
    subscribe: createLiveSubscriber(context.redis, context.logger),
  });

  registerStaticRoutes(app, context.env.WEB_ROOT);

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  // The client learns that the request failed, not why. Details go to the log,
  // which is redacted; an error message can carry a connection string.
  app.onError((error, c) => {
    context.logger?.error({ err: error, path: c.req.path }, "unhandled api error");
    return c.json({ error: "internal_error" }, 500);
  });

  return { app: liveStreams.app, liveStreams };
}

export type AppType = ReturnType<typeof createApp>["app"];
