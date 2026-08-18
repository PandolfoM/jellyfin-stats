import { describe, expect, it, vi } from "vitest";
import { createShutdownHandler } from "./shutdown.js";

function testLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

describe("createShutdownHandler", () => {
  it("runs the close steps and exits 0 on a clean shutdown", async () => {
    const logger = testLogger();
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      logger,
      onShutdown,
      exit,
      startMessage: "test shutting down",
      failureMessage: "test shutdown failed",
    });

    shutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.info).toHaveBeenCalledWith("test shutting down");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("still exits, non-zero, and logs when close rejects", async () => {
    const logger = testLogger();
    const failure = new Error("redis unreachable");
    const onShutdown = vi.fn().mockRejectedValue(failure);
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      logger,
      onShutdown,
      exit,
      startMessage: "test shutting down",
      failureMessage: "test shutdown failed",
    });

    shutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith({ err: failure }, "test shutdown failed");
  });

  it("does not run teardown twice when invoked again while in flight", async () => {
    const logger = testLogger();
    let resolveClose: (() => void) | undefined;
    const onShutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      logger,
      onShutdown,
      exit,
      startMessage: "test shutting down",
      failureMessage: "test shutdown failed",
    });

    shutdown();
    shutdown();

    expect(onShutdown).toHaveBeenCalledTimes(1);

    resolveClose?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("gives up and exits non-zero when teardown never settles", async () => {
    // The backstop for a whole class of bug: any teardown step that can hang
    // (an SSE handler still holding a connection, a socket that never drains)
    // would otherwise leave the process alive past the signal with no log line
    // after startMessage, until the supervisor's grace period expires and
    // SIGKILL lands. A never-settling promise stands in for all of them.
    const logger = testLogger();
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      logger,
      onShutdown: () => new Promise<void>(() => {}),
      exit,
      startMessage: "test shutting down",
      failureMessage: "test shutdown failed",
      timeoutMs: 25,
    });

    shutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith({ timeoutMs: 25 }, "test shutdown failed");
  });

  it("does not report a second exit code if teardown finishes after the timeout fired", async () => {
    const logger = testLogger();
    const exit = vi.fn();
    let resolveClose: (() => void) | undefined;
    const shutdown = createShutdownHandler({
      logger,
      onShutdown: () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
      exit,
      startMessage: "test shutting down",
      failureMessage: "test shutdown failed",
      timeoutMs: 25,
    });

    shutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    resolveClose?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalledWith(0);
  });

  it("does not time out a teardown that completes in time", async () => {
    const logger = testLogger();
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      logger,
      onShutdown: async () => {},
      exit,
      startMessage: "test shutting down",
      failureMessage: "test shutdown failed",
      timeoutMs: 25,
    });

    shutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
