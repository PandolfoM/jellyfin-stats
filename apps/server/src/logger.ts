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
      paths: ["apiKey", "JELLYFIN_API_KEY", "SESSION_SECRET", "*.apiKey", "headers.authorization"],
      censor: "[redacted]",
    },
  };

  return destination === undefined ? pino(options) : pino(options, destination);
}

export type Logger = ReturnType<typeof createLogger>;
