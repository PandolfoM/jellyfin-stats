import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerSettingsRoutes, type SettingsDeps } from "./settings.js";

// Synthetic, non-secret values only — see the repo-wide rule against real
// hostnames/credentials in tracked files. This URL resolves nowhere.
const DEPS: SettingsDeps = {
  sessionPollIntervalMs: 5_000,
  referenceSyncIntervalMs: 900_000,
  completionThreshold: 0.9,
  jellyfinUrl: "http://jellyfin.example.invalid",
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
    });
  });

  it("reflects whatever values it is given, proving the response is not hardcoded", async () => {
    const app = build({
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
  it("returns exactly these four keys and no others", async () => {
    const app = build();

    const response = await app.request("/api/settings");
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      "completionThreshold",
      "jellyfinUrl",
      "referenceSyncIntervalMs",
      "sessionPollIntervalMs",
    ]);
  });
});
