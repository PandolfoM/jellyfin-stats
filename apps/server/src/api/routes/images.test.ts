import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerImageRoutes, type ImageDeps } from "./images.js";

function build(overrides: Partial<ImageDeps> = {}) {
  const deps: ImageDeps = {
    fetchImage: vi.fn(
      async () => new Response("binary", { status: 200, headers: { "content-type": "image/jpeg" } }),
    ),
    ...overrides,
  };
  const app = new Hono();
  registerImageRoutes(app, deps);
  return { app, deps };
}

describe("GET /api/images/items/:itemId", () => {
  it("streams the upstream image with its content type", async () => {
    const { app } = build();

    const response = await app.request("/api/images/items/item-1");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  it("passes the tag through so cached art busts correctly", async () => {
    const { app, deps } = build();

    await app.request("/api/images/items/item-1?tag=abc123");

    expect(deps.fetchImage).toHaveBeenCalledWith("item-1", expect.objectContaining({ tag: "abc123" }));
  });

  it("clamps maxWidth so a caller cannot force huge transcodes", async () => {
    const { app, deps } = build();

    await app.request("/api/images/items/item-1?maxWidth=99999");

    const call = (deps.fetchImage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[1].maxWidth).toBeLessThanOrEqual(1000);
  });

  it("sets a long cache header, since art is immutable for a given tag", async () => {
    const { app } = build();

    const response = await app.request("/api/images/items/item-1?tag=abc123");

    expect(response.headers.get("cache-control")).toContain("max-age=");
  });

  it("answers 404 when Jellyfin has no image for the item", async () => {
    const { app } = build({
      fetchImage: vi.fn(async () => new Response(null, { status: 404 })),
    });

    expect((await app.request("/api/images/items/missing")).status).toBe(404);
  });

  it("answers 502 when Jellyfin is unreachable", async () => {
    const { app } = build({
      fetchImage: vi.fn(async () => {
        throw new Error("network");
      }),
    });

    expect((await app.request("/api/images/items/item-1")).status).toBe(502);
  });

  it("does not leak the upstream error message", async () => {
    const { app } = build({
      fetchImage: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:8096");
      }),
    });

    const response = await app.request("/api/images/items/item-1");

    expect(await response.text()).not.toContain("10.0.0.5");
  });
});
