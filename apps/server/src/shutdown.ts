import type { Logger } from "./logger.js";

export interface ShutdownHandlerOptions {
  logger: Pick<Logger, "info" | "error">;
  /** Performs the actual teardown (closing servers, queues, connections). */
  onShutdown: () => Promise<void>;
  /** Injected so tests can assert on the exit code without killing the process. */
  exit: (code: number) => void;
  /** Logged once, before teardown starts. */
  startMessage: string;
  /** Logged, with the error, if `onShutdown` rejects. */
  failureMessage: string;
}

/**
 * Builds a signal handler that tears down a process exactly once.
 *
 * A bare `process.on("SIGTERM", () => void shutdown())` has two failure modes: a
 * rejection from the async body becomes an unhandled promise rejection and
 * `process.exit` is never reached (the process hangs past the signal instead of
 * dying), and a second signal arriving mid-teardown re-enters the same async body
 * and runs cleanup twice. This wraps the teardown so a rejection is caught, logged,
 * and still followed by `exit`, and so a second invocation while the first is still
 * in flight is a no-op.
 */
export function createShutdownHandler({
  logger,
  onShutdown,
  exit,
  startMessage,
  failureMessage,
}: ShutdownHandlerOptions): () => void {
  let shuttingDown = false;

  return () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    void (async () => {
      logger.info(startMessage);
      try {
        await onShutdown();
        exit(0);
      } catch (error) {
        // Cleanup failed partway (e.g. Redis quit rejected but the pool is still
        // open). Exiting non-zero is more honest than hanging past the signal, and
        // the reason is still visible in the log rather than lost as an unhandled
        // rejection.
        logger.error({ err: error }, failureMessage);
        exit(1);
      }
    })();
  };
}
