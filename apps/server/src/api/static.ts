import { serveStatic } from "@hono/node-server/serve-static";
import type { Env, Hono, Schema } from "hono";

/**
 * Serves the built SPA. Registered after every /api route so it can never
 * shadow one: both handlers defer immediately on an /api path, which keeps an
 * unknown API route a JSON 404 instead of a 200 carrying index.html.
 *
 * `root` must be absolute — @hono/node-server resolves a relative root against
 * the current working directory, which differs between `pnpm --filter` (the
 * package directory) and Vitest (the repo root).
 *
 * Passing `undefined` registers nothing, which is the development case: Vite
 * serves the SPA and apps/web/dist does not exist.
 *
 * Traversal note: the asset handler below resolves `serveStatic({ root })`
 * against the real request path, so it's @hono/node-server's own traversal
 * check that keeps it from escaping `root` — that check only runs on the
 * branch of serveStatic taken when `options.path` is unset. The SPA-fallback
 * handler sets `path: "index.html"` explicitly, so it never takes that
 * branch and the check never runs for it — but it is still safe, because the
 * file it serves is a hardcoded literal, not derived from the request path
 * at all. There is nothing there for a traversal string to influence. Do not
 * "fix" this by deriving the fallback's path from the request — that would
 * both reintroduce a real traversal surface and break deep-link refreshes,
 * which depend on every non-API, non-asset path rendering the same shell.
 */
export function registerStaticRoutes<E extends Env, S extends Schema>(
  app: Hono<E, S>,
  root: string | undefined,
): void {
  if (root === undefined) return;

  const isApi = (path: string): boolean => path === "/api" || path.startsWith("/api/");

  // Real files: assets, favicon, manifest. Falls through when nothing matches.
  app.use("*", async (c, next) => {
    if (isApi(c.req.path)) return next();
    return serveStatic({ root })(c, next);
  });

  // Client-routed paths: anything left over renders the SPA shell.
  app.get("*", async (c, next) => {
    if (isApi(c.req.path)) return next();
    return serveStatic({ root, path: "index.html" })(c, next);
  });
}
