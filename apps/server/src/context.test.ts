import { Writable } from "node:stream";
import { loadEnv } from "@jfstats/shared";
import { describe, expect, it } from "vitest";
import { createContext } from "./context.js";
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

describe("createContext", () => {
  const env = loadEnv({
    JELLYFIN_URL: "http://jellyfin.test:8096",
    JELLYFIN_API_KEY: "test-key",
    DATABASE_URL: "postgres://u:p@127.0.0.1:1/db",
    LOG_LEVEL: "error",
  });

  it("builds a context with no redis field", async () => {
    // Redis is gone from AppContext now that everything runs in one process —
    // this pins that removal so it cannot silently regress.
    const context = createContext(env);

    try {
      expect(context).not.toHaveProperty("redis");
    } finally {
      await context.pool.end();
    }
  });
});
