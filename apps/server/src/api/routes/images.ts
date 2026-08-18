import type { Env, Hono, Schema } from "hono";

export interface ImageDeps {
  fetchImage(itemId: string, options: { tag?: string; maxWidth: number }): Promise<Response>;
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

/**
 * Returns the app with this route chained onto it (rather than `void`), the
 * same reason registerAuthRoutes does — see that file for why. The incoming
 * `S` is generic (not defaulted to Hono's blank schema) so that a caller
 * threading in an already-chained app keeps those routes in the returned
 * type instead of them being erased at this call.
 */
export function registerImageRoutes<E extends Env, S extends Schema>(app: Hono<E, S>, deps: ImageDeps) {
  return app.get("/api/images/items/:itemId", async (c) => {
    const itemId = c.req.param("itemId");
    if (!ITEM_ID_PATTERN.test(itemId)) {
      return c.json({ error: "invalid_item_id" }, 400);
    }

    const requested = Number(c.req.query("maxWidth") ?? DEFAULT_WIDTH);
    const maxWidth = Number.isFinite(requested)
      ? Math.min(Math.max(1, Math.trunc(requested)), MAX_IMAGE_WIDTH)
      : DEFAULT_WIDTH;

    let upstream: Response;

    try {
      upstream = await deps.fetchImage(itemId, {
        tag: c.req.query("tag"),
        maxWidth,
      });
    } catch {
      // The upstream message can name an internal host; it never reaches the client.
      return c.json({ error: "image_unavailable" }, 502);
    }

    if (upstream.status === 404) {
      // Undici can hold the underlying connection open until the body is
      // consumed or cancelled; under sustained upstream failures this leaves
      // it unreleased even though nothing will ever read it.
      await upstream.body?.cancel();
      return c.json({ error: "not_found" }, 404);
    }
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return c.json({ error: "image_unavailable" }, 502);
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
        // Art for a given tag never changes; the tag changes when the art does.
        // private: this response is behind the admin gate, so a shared/proxy
        // cache must never store it — only the requesting browser may.
        "Cache-Control": `private, max-age=${CACHE_SECONDS}`,
      },
    });
  });
}
