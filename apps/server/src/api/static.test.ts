import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { registerStaticRoutes } from "./static.js";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(path.join(tmpdir(), "jfstats-web-"));
  mkdirSync(path.join(webRoot, "assets"));
  writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>jfstats</title>");
  writeFileSync(path.join(webRoot, "assets", "app-abc123.js"), "console.log('spa');");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

/** Mirrors production order: API routes and the JSON 404 exist before static is registered. */
function buildApp(root: string | undefined): Hono {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  registerStaticRoutes(app, root);
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}

describe("static serving", () => {
  it("serves index.html for a deep link so a refresh does not 404", async () => {
    const res = await buildApp(webRoot).request("/users/abc");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>jfstats</title>");
  });

  it("serves a real asset with its own content", async () => {
    const res = await buildApp(webRoot).request("/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('spa');");
  });

  it("leaves an unknown /api path as a JSON 404 rather than shadowing it with index.html", async () => {
    const res = await buildApp(webRoot).request("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("does not shadow a registered API route", async () => {
    const res = await buildApp(webRoot).request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  // Guards the non-vacuity of every assertion above: with WEB_ROOT unset the
  // same deep link must 404, which proves the fallback is what serves it.
  it("registers nothing when no web root is configured", async () => {
    const res = await buildApp(undefined).request("/users/abc");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  // Pins serveStatic's own traversal handling (verified by probe) so a
  // dependency bump that regresses it fails here rather than in production.
  it.each(["/../../package.json", "/..%2f..%2fpackage.json", "/%2e%2e/package.json"])(
    "refuses to escape the web root via %s",
    async (attack) => {
      const res = await buildApp(webRoot).request(attack);
      const body = await res.text();
      expect(body).not.toContain("@jfstats/server");
      expect(body).not.toContain("dependencies");
    },
  );
});
