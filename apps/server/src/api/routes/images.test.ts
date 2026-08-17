import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { CACHE_SECONDS, registerImageRoutes, type ImageDeps } from "./images.js";

// A real Jellyfin item id: 32 lowercase hex characters, no dashes.
const VALID_ITEM_ID = "a1b2c3d4e5f67890a1b2c3d4e5f67890";
const MISSING_ITEM_ID = "ffffffffffffffffffffffffffffffff".slice(0, 32);

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

    const response = await app.request(`/api/images/items/${VALID_ITEM_ID}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  it("passes the tag through so cached art busts correctly", async () => {
    const { app, deps } = build();

    await app.request(`/api/images/items/${VALID_ITEM_ID}?tag=abc123`);

    expect(deps.fetchImage).toHaveBeenCalledWith(
      VALID_ITEM_ID,
      expect.objectContaining({ tag: "abc123" }),
    );
  });

  it("clamps maxWidth so a caller cannot force huge transcodes", async () => {
    const { app, deps } = build();

    await app.request(`/api/images/items/${VALID_ITEM_ID}?maxWidth=99999`);

    const call = (deps.fetchImage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[1].maxWidth).toBeLessThanOrEqual(1000);
  });

  it("falls back to the default width when maxWidth is not a number", async () => {
    const { app, deps } = build();

    await app.request(`/api/images/items/${VALID_ITEM_ID}?maxWidth=abc`);

    const call = (deps.fetchImage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[1].maxWidth).toBe(400);
  });

  it("clamps a negative maxWidth up to the minimum of 1", async () => {
    const { app, deps } = build();

    await app.request(`/api/images/items/${VALID_ITEM_ID}?maxWidth=-5`);

    const call = (deps.fetchImage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[1].maxWidth).toBe(1);
  });

  it("truncates a fractional maxWidth to an integer", async () => {
    const { app, deps } = build();

    await app.request(`/api/images/items/${VALID_ITEM_ID}?maxWidth=1.7`);

    const call = (deps.fetchImage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[1].maxWidth).toBe(1);
  });

  it("uses the default width when maxWidth is absent", async () => {
    const { app, deps } = build();

    await app.request(`/api/images/items/${VALID_ITEM_ID}`);

    const call = (deps.fetchImage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[1].maxWidth).toBe(400);
  });

  it("sets an exact private, long-lived cache header, since art is immutable for a given tag", async () => {
    const { app } = build();

    const response = await app.request(`/api/images/items/${VALID_ITEM_ID}?tag=abc123`);

    // Exact match, not a substring check: "public, max-age=0" would also
    // contain "max-age=" and must not pass here. private is load-bearing —
    // this route is behind the admin gate, so a shared cache must never
    // store the response.
    expect(response.headers.get("cache-control")).toBe(`private, max-age=${CACHE_SECONDS}`);
  });

  it("answers 404 when Jellyfin has no image for the item", async () => {
    const { app } = build({
      fetchImage: vi.fn(async () => new Response(null, { status: 404 })),
    });

    expect((await app.request(`/api/images/items/${MISSING_ITEM_ID}`)).status).toBe(404);
  });

  it("cancels the upstream body on a 404, so undici does not hold the connection open", async () => {
    const stream = new ReadableStream();
    const cancelSpy = vi.spyOn(stream, "cancel");
    const { app } = build({
      fetchImage: vi.fn(async () => new Response(stream, { status: 404 })),
    });

    await app.request(`/api/images/items/${MISSING_ITEM_ID}`);

    expect(cancelSpy).toHaveBeenCalled();
  });

  it("cancels the upstream body on a non-OK, non-404 status", async () => {
    const stream = new ReadableStream();
    const cancelSpy = vi.spyOn(stream, "cancel");
    const { app } = build({
      fetchImage: vi.fn(async () => new Response(stream, { status: 500 })),
    });

    await app.request(`/api/images/items/${VALID_ITEM_ID}`);

    expect(cancelSpy).toHaveBeenCalled();
  });

  it("answers 502 when Jellyfin is unreachable", async () => {
    const { app } = build({
      fetchImage: vi.fn(async () => {
        throw new Error("network");
      }),
    });

    expect((await app.request(`/api/images/items/${VALID_ITEM_ID}`)).status).toBe(502);
  });

  it("does not leak the upstream error message", async () => {
    const { app } = build({
      fetchImage: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:8096");
      }),
    });

    const response = await app.request(`/api/images/items/${VALID_ITEM_ID}`);

    expect(await response.text()).not.toContain("10.0.0.5");
  });

  describe("item id validation", () => {
    // Hono's router matches :itemId against the still-encoded path segment,
    // so "%2F" does not split it into multiple segments — the whole thing
    // is captured as one param. Only afterwards does c.req.param()
    // decodeURIComponent it, turning "..%2F..%2FUsers%23" into the literal
    // "../../Users#". If that reached the upstream fetch unchecked, the
    // admin-keyed request would land on an attacker-chosen Jellyfin path
    // instead of the intended image endpoint.
    it("rejects a path-traversal payload with a fragment and never calls fetchImage", async () => {
      const { app, deps } = build();

      const response = await app.request("/api/images/items/..%2F..%2FUsers%23");

      expect(response.status).toBe(400);
      expect(deps.fetchImage).not.toHaveBeenCalled();
    });

    it("rejects a path-traversal payload without a fragment and never calls fetchImage", async () => {
      const { app, deps } = build();

      const response = await app.request("/api/images/items/..%2F..%2FUsers");

      expect(response.status).toBe(400);
      expect(deps.fetchImage).not.toHaveBeenCalled();
    });

    it("accepts a valid 32-character hex item id and calls fetchImage with it unchanged", async () => {
      const { app, deps } = build();

      const response = await app.request(`/api/images/items/${VALID_ITEM_ID}`);

      expect(response.status).toBe(200);
      expect(deps.fetchImage).toHaveBeenCalledWith(VALID_ITEM_ID, expect.anything());
    });
  });
});
