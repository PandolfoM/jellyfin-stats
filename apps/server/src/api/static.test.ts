import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { registerStaticRoutes } from "./static.js";

let testRoot: string;
let webRoot: string;

// Distinctive content living one directory above webRoot. No path under test
// is ever supposed to reach it — it exists only so the traversal assertions
// below have something real to detect. An earlier version of this test
// instead asserted the response body didn't contain literal substrings
// ("@jfstats/server", "dependencies") lifted from this repo's own
// package.json; that happened to also describe the fallback handler's
// actual (safe) behavior of always serving webRoot/index.html verbatim
// regardless of the request path, so it passed whether or not any
// protection existed. See task-12-report.md for the temporarily-broken run
// that confirms this version actually goes red when the property it guards
// — no content from outside WEB_ROOT is ever served — is violated.
const OUTSIDE_WEB_ROOT_SENTINEL = "OUTSIDE-WEB-ROOT-SENTINEL-9c14";

beforeAll(() => {
  testRoot = mkdtempSync(path.join(tmpdir(), "jfstats-statictest-"));
  webRoot = path.join(testRoot, "web");
  mkdirSync(webRoot);
  mkdirSync(path.join(webRoot, "assets"));
  writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>jfstats</title>");
  writeFileSync(path.join(webRoot, "assets", "app-abc123.js"), "console.log('spa');");

  // Named index.html and placed directly outside webRoot (one level up) so
  // that pointing the fallback's root at testRoot instead of webRoot — the
  // discrimination check recorded in task-12-report.md — actually surfaces
  // this content instead of 404ing on an unrelated filename.
  writeFileSync(path.join(testRoot, "index.html"), OUTSIDE_WEB_ROOT_SENTINEL);
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
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

  // The property worth pinning is "no request can cause content from
  // outside WEB_ROOT to be served" — not a status code, and not a fixed
  // string that happens to be absent from whatever the handler actually
  // returns. The fallback handler always serves webRoot/index.html verbatim
  // regardless of the request path (see static.ts), so these attack strings
  // never reach @hono/node-server's own request-path-driven traversal check
  // at all — that check only applies to the asset handler above, which
  // resolves against the real request path. What keeps the fallback safe is
  // that its file is hardcoded, not derived from user input; this test is
  // what would catch a regression of that fact.
  it.each(["/../../package.json", "/..%2f..%2fpackage.json", "/%2e%2e/package.json"])(
    "never leaks content from outside the web root via %s",
    async (attack) => {
      const res = await buildApp(webRoot).request(attack);
      const body = await res.text();
      expect(body).not.toContain(OUTSIDE_WEB_ROOT_SENTINEL);
    },
  );
});
