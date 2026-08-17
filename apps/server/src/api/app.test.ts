import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AppContext } from "../context.js";

function testContext(): AppContext {
  return { env: { LOG_LEVEL: "error" } } as unknown as AppContext;
}

describe("createApp", () => {
  it("serves a health check without authentication", async () => {
    const app = createApp(testContext());

    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns JSON 404 for an unknown route rather than HTML", async () => {
    const app = createApp(testContext());

    const response = await app.request("/api/nope");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("reports an unhandled route error as JSON without leaking the message", async () => {
    const app = createApp(testContext());
    app.get("/api/boom", () => {
      throw new Error("internal detail that must not reach the client");
    });

    const response = await app.request("/api/boom");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });
});
