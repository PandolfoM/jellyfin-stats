import { Writable } from "node:stream";
import { loadEnv } from "@jfstats/shared";
import { describe, expect, it, vi } from "vitest";
import { attachRedisErrorLogger, createContext } from "./context.js";
import { createLogger } from "./logger.js";

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });

  // The real factory, not a copy of its config — otherwise this test would pass
  // even if logger.ts had no redaction at all.
  return { logger: createLogger("info", destination), lines };
}

describe("logger redaction", () => {
  it("never writes a Jellyfin api key to the log", () => {
    const { logger, lines } = captureLogger();

    logger.info({ apiKey: "super-secret-key" }, "connecting");

    expect(lines.join("")).not.toContain("super-secret-key");
    expect(lines.join("")).toContain("[redacted]");
  });

  it("redacts a nested api key", () => {
    const { logger, lines } = captureLogger();

    logger.info({ jellyfin: { apiKey: "super-secret-key" } }, "connecting");

    expect(lines.join("")).not.toContain("super-secret-key");
  });

  it("redacts an authorization header", () => {
    const { logger, lines } = captureLogger();

    logger.info({ headers: { authorization: 'MediaBrowser Token="super-secret-key"' } }, "request");

    expect(lines.join("")).not.toContain("super-secret-key");
  });

  it("redacts the real Authorization header casing the Jellyfin client sends", () => {
    // packages/jellyfin/src/client.ts sets `Authorization` (capital A), not
    // `authorization`. fast-redact (which backs pino's redact option) matches paths
    // exactly, so a lowercase-only entry silently never fires on the real header
    // shape — this is the case that was broken.
    const { logger, lines } = captureLogger();

    logger.info({ headers: { Authorization: 'MediaBrowser Token="super-secret-key"' } }, "request");

    expect(lines.join("")).not.toContain("super-secret-key");
    expect(lines.join("")).toContain("[redacted]");
  });
});

describe("attachRedisErrorLogger", () => {
  it("routes an ioredis error event through the app logger", () => {
    const listeners = new Map<string, (error: Error) => void>();
    const redis = {
      on: vi.fn((event: string, listener: (error: Error) => void) => {
        listeners.set(event, listener);
      }),
    };
    const logger = { error: vi.fn() };

    attachRedisErrorLogger(redis, logger);
    const failure = new Error("ECONNREFUSED");
    listeners.get("error")?.(failure);

    expect(logger.error).toHaveBeenCalledWith({ err: failure }, "redis connection error");
  });

  it("never writes a REDIS_URL password to the log by falling back to console.error", () => {
    // The reason this exists at all. With no `error` listener, ioredis's
    // silentEmit falls back to console.error("[ioredis] Unhandled error
    // event:", ...), which bypasses LOG_LEVEL *and* every redaction path in
    // logger.ts — and REDIS_URL can carry a password.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { logger, lines } = captureLogger();
      const listeners = new Map<string, (error: Error) => void>();
      const redis = {
        on: (event: string, listener: (error: Error) => void) => {
          listeners.set(event, listener);
        },
      };

      attachRedisErrorLogger(redis, logger);
      listeners.get("error")?.(new Error("connect ECONNREFUSED"));

      expect(consoleError).not.toHaveBeenCalled();
      expect(lines.join("")).toContain("redis connection error");
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("createContext", () => {
  const env = loadEnv({
    JELLYFIN_URL: "http://jellyfin.test:8096",
    JELLYFIN_API_KEY: "test-key",
    DATABASE_URL: "postgres://u:p@127.0.0.1:1/db",
    // Nothing listens here; the client is disconnected before it can retry.
    REDIS_URL: "redis://127.0.0.1:1",
    LOG_LEVEL: "error",
  });

  it("gives both entrypoints a Redis error listener, not just the worker", () => {
    // api.ts and worker.ts share this factory. The listener used to be
    // registered in worker.ts only, so every API process — and every per-SSE
    // duplicate() — fell back to ioredis's unredacted console.error.
    const context = createContext(env);

    try {
      expect(context.redis.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      context.redis.disconnect();
    }
  });
});
