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
  /**
   * Teardown is abandoned and the process exits non-zero after this long.
   * Defaults to {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}

/**
 * Long enough for a real drain (an in-flight query, a Redis quit), short enough
 * to land well inside the 10s grace period Docker allows before SIGKILL.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

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
 *
 * It also refuses to wait forever. A teardown step that never settles — an SSE
 * handler holding a connection open, a socket that never drains — would
 * otherwise leave the process alive past the signal with no log line after
 * `startMessage`, until the supervisor's grace period expires and SIGKILL lands.
 * The timeout converts that class of hang into a prompt, non-zero, *logged*
 * exit, whatever future long-lived handler causes it.
 */
export function createShutdownHandler({
  logger,
  onShutdown,
  exit,
  startMessage,
  failureMessage,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
}: ShutdownHandlerOptions): () => void {
  let shuttingDown = false;

  return () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    void (async () => {
      logger.info(startMessage);

      let exited = false;
      // Guarded so a teardown that finishes just after the timeout fired cannot
      // report a second, contradictory exit code.
      const exitOnce = (code: number): void => {
        if (exited) return;
        exited = true;
        exit(code);
      };

      const timer = setTimeout(() => {
        logger.error({ timeoutMs }, failureMessage);
        exitOnce(1);
      }, timeoutMs);
      // The timeout is a backstop, not a reason to keep an otherwise-idle event
      // loop alive.
      timer.unref();

      try {
        await onShutdown();
        exitOnce(0);
      } catch (error) {
        // Cleanup failed partway (e.g. Redis quit rejected but the pool is still
        // open). Exiting non-zero is more honest than hanging past the signal, and
        // the reason is still visible in the log rather than lost as an unhandled
        // rejection.
        logger.error({ err: error }, failureMessage);
        exitOnce(1);
      } finally {
        clearTimeout(timer);
      }
    })();
  };
}
