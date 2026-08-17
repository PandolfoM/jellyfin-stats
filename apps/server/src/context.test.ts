import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
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
});
