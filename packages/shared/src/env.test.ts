import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const valid = {
  JELLYFIN_URL: "http://jellyfin.test:8096",
  JELLYFIN_API_KEY: "test-key",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "a".repeat(64),
};

describe("loadEnv", () => {
  it("applies documented defaults", () => {
    const env = loadEnv(valid);
    expect(env.SESSION_POLL_INTERVAL_MS).toBe(5000);
    expect(env.REFERENCE_SYNC_INTERVAL_MS).toBe(900_000);
    expect(env.COMPLETION_THRESHOLD).toBe(0.9);
    expect(env.PORT).toBe(3000);
  });

  it("coerces numeric strings", () => {
    const env = loadEnv({ ...valid, SESSION_POLL_INTERVAL_MS: "2000" });
    expect(env.SESSION_POLL_INTERVAL_MS).toBe(2000);
  });

  it("strips a trailing slash from JELLYFIN_URL", () => {
    const env = loadEnv({ ...valid, JELLYFIN_URL: "http://jellyfin.test:8096/" });
    expect(env.JELLYFIN_URL).toBe("http://jellyfin.test:8096");
  });

  it("throws a message naming the missing variable", () => {
    const { JELLYFIN_API_KEY: _omitted, ...missing } = valid;
    expect(() => loadEnv(missing)).toThrow(/JELLYFIN_API_KEY/);
  });

  it("rejects a session secret shorter than 32 characters", () => {
    expect(() => loadEnv({ ...valid, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });

  it("rejects a completion threshold above 1", () => {
    expect(() => loadEnv({ ...valid, COMPLETION_THRESHOLD: "1.5" })).toThrow(/COMPLETION_THRESHOLD/);
  });

  it("enables the fallback admin only when both credentials are set", () => {
    expect(loadEnv(valid).fallbackAdminEnabled).toBe(false);
    expect(loadEnv({ ...valid, FALLBACK_ADMIN_USER: "rescue" }).fallbackAdminEnabled).toBe(false);
    const both = loadEnv({
      ...valid,
      FALLBACK_ADMIN_USER: "rescue",
      FALLBACK_ADMIN_PASSWORD: "rescue-password",
    });
    expect(both.fallbackAdminEnabled).toBe(true);
  });
});
