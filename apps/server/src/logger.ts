import pino, { type DestinationStream } from "pino";

/**
 * `destination` is injected only so tests can assert against the bytes actually
 * written. Production callers pass nothing and get stdout.
 */
export function createLogger(level: string, destination?: DestinationStream) {
  const options = {
    level,
    // Never let a Jellyfin key reach the logs, whatever object gets logged.
    redact: {
      // fast-redact matches paths exactly, so the real casing must be listed too:
      // packages/jellyfin/src/client.ts sends the header as `Authorization`
      // (MediaBrowser convention), not `authorization`.
      paths: [
        "apiKey",
        "JELLYFIN_API_KEY",
        "SESSION_SECRET",
        "*.apiKey",
        "headers.authorization",
        "headers.Authorization",
      ],
      censor: "[redacted]",
    },
  };

  return destination === undefined ? pino(options) : pino(options, destination);
}

export type Logger = ReturnType<typeof createLogger>;
