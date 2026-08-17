import type { Env, Hono } from "hono";

export interface ImageDeps {
  fetchImage(itemId: string, options: { tag?: string; maxWidth: number }): Promise<Response>;
}

export const MAX_IMAGE_WIDTH = 1000;
const DEFAULT_WIDTH = 400;
const CACHE_SECONDS = 60 * 60 * 24 * 30;

export function registerImageRoutes<E extends Env>(app: Hono<E>, deps: ImageDeps): void {
  app.get("/api/images/items/:itemId", async (c) => {
    const requested = Number(c.req.query("maxWidth") ?? DEFAULT_WIDTH);
    const maxWidth = Number.isFinite(requested)
      ? Math.min(Math.max(1, Math.trunc(requested)), MAX_IMAGE_WIDTH)
      : DEFAULT_WIDTH;

    let upstream: Response;

    try {
      upstream = await deps.fetchImage(c.req.param("itemId"), {
        tag: c.req.query("tag"),
        maxWidth,
      });
    } catch {
      // The upstream message can name an internal host; it never reaches the client.
      return c.json({ error: "image_unavailable" }, 502);
    }

    if (upstream.status === 404) return c.json({ error: "not_found" }, 404);
    if (!upstream.ok) return c.json({ error: "image_unavailable" }, 502);

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
