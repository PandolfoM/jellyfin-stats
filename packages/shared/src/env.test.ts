import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const valid = {
  JELLYFIN_URL: "http://jellyfin.test:8096",
  JELLYFIN_API_KEY: "test-key",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
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

  it("loads without a SESSION_SECRET, which nothing reads", () => {
    // Session ids are 32 random bytes in Postgres and every gated request
    // round-trips to Postgres to resolve one, so there is nothing for a signing
    // secret to do. It used to be required, with an `openssl rand -hex 32`
    // ritual in the setup instructions, which taught operators it was
    // load-bearing. This pins the removal so it cannot creep back.
    expect(() => loadEnv(valid)).not.toThrow();
    expect(Object.keys(loadEnv(valid))).not.toContain("SESSION_SECRET");
  });

  it("still loads when an existing .env carries a SESSION_SECRET line", () => {
    // Backward compatibility: the schema is a non-strict z.object, so an
    // operator upgrading in place does not have to edit their .env at all.
    expect(() => loadEnv({ ...valid, SESSION_SECRET: "a".repeat(64) })).not.toThrow();
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

describe("cookie and session configuration", () => {
  it("defaults COOKIE_SECURE to false so a first run over plain HTTP works", () => {
    expect(loadEnv(valid).COOKIE_SECURE).toBe(false);
  });

  it("accepts the string 'true' from a .env file", () => {
    expect(loadEnv({ ...valid, COOKIE_SECURE: "true" }).COOKIE_SECURE).toBe(true);
  });

  it("treats any other value as false rather than throwing", () => {
    expect(loadEnv({ ...valid, COOKIE_SECURE: "yes" }).COOKIE_SECURE).toBe(false);
  });

  it("defaults the session lifetime to a week", () => {
    expect(loadEnv(valid).SESSION_TTL_HOURS).toBe(168);
  });

  it("rejects a non-positive session lifetime", () => {
    expect(() => loadEnv({ ...valid, SESSION_TTL_HOURS: "0" })).toThrow(/SESSION_TTL_HOURS/);
  });

  it("defaults TRUST_PROXY_HEADERS to false, so a direct unproxied deployment isn't spoofable", () => {
    expect(loadEnv(valid).TRUST_PROXY_HEADERS).toBe(false);
  });

  it("accepts the string 'true' from a .env file for TRUST_PROXY_HEADERS", () => {
    expect(loadEnv({ ...valid, TRUST_PROXY_HEADERS: "true" }).TRUST_PROXY_HEADERS).toBe(true);
  });
});
