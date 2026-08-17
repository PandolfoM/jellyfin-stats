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
});
