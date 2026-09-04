import type { Env, Hono, Schema } from "hono";

export interface ImageDeps {
  fetchImage(itemId: string, options: { tag?: string; maxWidth: number }): Promise<Response>;
  /** A user's avatar (`/Users/{id}/Images/Primary`). No tag: the users table stores none. */
  fetchUserImage(userId: string, options: { maxWidth: number }): Promise<Response>;
}

export const MAX_IMAGE_WIDTH = 1000;
const DEFAULT_WIDTH = 400;
export const CACHE_SECONDS = 60 * 60 * 24 * 30;

// Jellyfin item ids are 32-character hex GUIDs (no dashes, as Jellyfin's REST
// API emits them). Rejecting anything else here — before any outbound
// request is built — means a path-traversal or URL-fragment payload
// (e.g. "..%2F..%2FUsers%23", which Hono's router matches as a single
// :itemId segment and only decodes *after* matching) can never reach the
// upstream fetch, where it would carry the admin Jellyfin API key to
// whatever path survived URL parsing instead of the intended image endpoint.
const ITEM_ID_PATTERN = /^[0-9a-f]{32}$/i;

function clampWidth(raw: string | undefined): number {
  const requested = Number(raw ?? DEFAULT_WIDTH);
  return Number.isFinite(requested)
    ? Math.min(Math.max(1, Math.trunc(requested)), MAX_IMAGE_WIDTH)
    : DEFAULT_WIDTH;
}

/**
 * Turns an upstream image response into ours, or the matching error. Shared
 * by the poster and avatar routes so the two can never drift on the parts
 * that matter: a 404 and a non-OK status both cancel the upstream body
 * (undici otherwise holds the connection until it is consumed), and the
 * success path carries the private cache header — these responses sit
 * behind the admin gate, so a shared cache must never store them.
 */
async function relayImage(fetchUpstream: () => Promise<Response>) {
  let upstream: Response;
  try {
    upstream = await fetchUpstream();
  } catch {
    // The upstream message can name an internal host; it never reaches the client.
    return { error: "image_unavailable" as const, status: 502 as const };
  }

  if (upstream.status === 404) {
    await upstream.body?.cancel();
    return { error: "not_found" as const, status: 404 as const };
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return { error: "image_unavailable" as const, status: 502 as const };
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
      "Cache-Control": `private, max-age=${CACHE_SECONDS}`,
    },
  });
}

/**
 * Returns the app with this route chained onto it (rather than `void`), the
 * same reason registerAuthRoutes does — see that file for why. The incoming
 * `S` is generic (not defaulted to Hono's blank schema) so that a caller
 * threading in an already-chained app keeps those routes in the returned
 * type instead of them being erased at this call.
 */
export function registerImageRoutes<E extends Env, S extends Schema>(
  app: Hono<E, S>,
  deps: ImageDeps,
) {
  return app
    .get("/api/images/items/:itemId", async (c) => {
      const itemId = c.req.param("itemId");
      if (!ITEM_ID_PATTERN.test(itemId)) {
        return c.json({ error: "invalid_item_id" }, 400);
      }

      const maxWidth = clampWidth(c.req.query("maxWidth"));
      const tag = c.req.query("tag");
      const result = await relayImage(() => deps.fetchImage(itemId, { tag, maxWidth }));
      if (result instanceof Response) return result;
      return c.json({ error: result.error }, result.status);
    })
    .get("/api/images/users/:userId", async (c) => {
      // Jellyfin user ids are the same 32-hex shape as item ids, and the same
      // traversal concern applies: validated before any outbound request.
      const userId = c.req.param("userId");
      if (!ITEM_ID_PATTERN.test(userId)) {
        return c.json({ error: "invalid_user_id" }, 400);
      }

      const maxWidth = clampWidth(c.req.query("maxWidth"));
      const result = await relayImage(() => deps.fetchUserImage(userId, { maxWidth }));
      if (result instanceof Response) return result;
      return c.json({ error: result.error }, result.status);
    });
}
