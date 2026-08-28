import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { MAX_SETTING_LENGTH } from "@jfstats/db";
import { registerSettingsRoutes, type SettingsDeps } from "./settings.js";

// Synthetic, non-secret values only — see the repo-wide rule against real
// hostnames/credentials in tracked files. This URL resolves nowhere.
const DEPS: SettingsDeps = {
  sessionPollIntervalMs: 5_000,
  referenceSyncIntervalMs: 900_000,
  completionThreshold: 0.9,
  jellyfinUrl: "http://jellyfin.example.invalid",
  getCustomCss: async () => null,
  saveCustomCss: async () => {},
};

function build(deps: SettingsDeps = DEPS) {
  const app = new Hono();
  registerSettingsRoutes(app, deps);
  return app;
}

describe("GET /api/settings", () => {
  it("returns the effective non-secret configuration", async () => {
    const app = build();

    const response = await app.request("/api/settings");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessionPollIntervalMs: 5_000,
      referenceSyncIntervalMs: 900_000,
      completionThreshold: 0.9,
      jellyfinUrl: "http://jellyfin.example.invalid",
      customCss: "",
    });
  });

  it("reflects whatever values it is given, proving the response is not hardcoded", async () => {
    const app = build({
      ...DEPS,
      sessionPollIntervalMs: 1_234,
      referenceSyncIntervalMs: 567_000,
      completionThreshold: 0.5,
      jellyfinUrl: "http://other.example.invalid",
    });

    const response = await app.request("/api/settings");

    expect(await response.json()).toEqual({
      sessionPollIntervalMs: 1_234,
      referenceSyncIntervalMs: 567_000,
      completionThreshold: 0.5,
      jellyfinUrl: "http://other.example.invalid",
      customCss: "",
    });
  });

  /**
   * The most important test in this file, and the easiest to write hollow.
   * `expect(body.jellyfinApiKey).toBeUndefined()` would pass trivially and
   * forever — including against a handler that spreads the entire env
   * object, since that field would never have been in `deps` to begin with
   * under this test's own fixture. Asserting the exact key set instead
   * catches ANY extra field reaching the response, named or not, including
   * a field that does not exist yet — which is exactly the shape a future
   * "just add this one more setting" change could take.
   *
   * This was verified non-hollow by temporarily changing the handler in
   * settings.ts to spread `deps` plus an extra `secret` field into the
   * response, confirming this assertion went red, then reverting — see the
   * task report for the exact diff and output.
   */
  it("returns exactly these five keys and no others", async () => {
    const app = build();

    const response = await app.request("/api/settings");
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      "completionThreshold",
      "customCss",
      "jellyfinUrl",
      "referenceSyncIntervalMs",
      "sessionPollIntervalMs",
    ]);
  });

  it("serves the saved custom CSS", async () => {
    const app = build({ ...DEPS, getCustomCss: async () => ":root { --primary: red; }" });

    const body = (await (await app.request("/api/settings")).json()) as { customCss: string };

    expect(body.customCss).toBe(":root { --primary: red; }");
  });

  it("reads the CSS per request rather than once at wiring time", async () => {
    // The four env fields above are fixed for the process's life; this one is
    // edited at runtime. Resolving it when the route was registered would keep
    // serving the old stylesheet until a restart.
    let stored = "a {}";
    const app = build({ ...DEPS, getCustomCss: async () => stored });

    const first = (await (await app.request("/api/settings")).json()) as { customCss: string };
    stored = "b {}";
    const second = (await (await app.request("/api/settings")).json()) as { customCss: string };

    expect(first.customCss).toBe("a {}");
    expect(second.customCss).toBe("b {}");
  });

  it("serves an empty string, not null, when nothing is saved", async () => {
    // One type for the client to render into a textarea, with no null branch.
    const body = (await (await build().request("/api/settings")).json()) as { customCss: unknown };

    expect(body.customCss).toBe("");
  });
});

describe("PUT /api/settings/custom-css", () => {
  function put(app: ReturnType<typeof build>, body: unknown) {
    return app.request("/api/settings/custom-css", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("saves the submitted CSS", async () => {
    const saveCustomCss = vi.fn(async () => {});
    const app = build({ ...DEPS, saveCustomCss });

    const response = await put(app, { css: "body { color: red; }" });

    expect(response.status).toBe(200);
    expect(saveCustomCss).toHaveBeenCalledWith("body { color: red; }");
  });

  it("accepts an empty string as a clear rather than rejecting it", async () => {
    // The Clear button in the UI submits this; setSetting deletes the row, so
    // "cleared" and "never set" end up the same state.
    const saveCustomCss = vi.fn(async () => {});
    const app = build({ ...DEPS, saveCustomCss });

    expect((await put(app, { css: "" })).status).toBe(200);
    expect(saveCustomCss).toHaveBeenCalledWith("");
  });

  it("rejects a body with no css field", async () => {
    const saveCustomCss = vi.fn(async () => {});
    const app = build({ ...DEPS, saveCustomCss });

    expect((await put(app, { notCss: "x" })).status).toBe(400);
    expect(saveCustomCss).not.toHaveBeenCalled();
  });

  it("rejects a non-string css value rather than coercing it", async () => {
    const saveCustomCss = vi.fn(async () => {});
    const app = build({ ...DEPS, saveCustomCss });

    expect((await put(app, { css: 42 })).status).toBe(400);
    expect(saveCustomCss).not.toHaveBeenCalled();
  });

  it("rejects a body past the length cap before it reaches the database", async () => {
    // The repository bounds this too, but an oversized body should never get
    // that far -- the cap is what stops a request filling the disk.
    const saveCustomCss = vi.fn(async () => {});
    const app = build({ ...DEPS, saveCustomCss });

    const response = await put(app, { css: "a".repeat(MAX_SETTING_LENGTH + 1) });

    expect(response.status).toBe(400);
    expect(saveCustomCss).not.toHaveBeenCalled();
  });

  it("accepts a body exactly at the cap, proving the bound is inclusive", async () => {
    const saveCustomCss = vi.fn(async () => {});
    const app = build({ ...DEPS, saveCustomCss });

    expect((await put(app, { css: "a".repeat(MAX_SETTING_LENGTH) })).status).toBe(200);
    expect(saveCustomCss).toHaveBeenCalledOnce();
  });

  it("rejects a malformed JSON body without throwing", async () => {
    const app = build();

    const response = await app.request("/api/settings/custom-css", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(response.status).toBe(400);
  });
});
