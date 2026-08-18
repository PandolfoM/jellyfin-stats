import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLiveRoute } from "./api/routes/live.js";
import { closeApiServer } from "./main.js";
import { createShutdownHandler } from "./shutdown.js";

/**
 * These run a real HTTP server over a real socket, because the behavior under
 * test IS Node's connection accounting: `server.close()`'s callback is deferred
 * until every in-flight connection has ended, and an SSE handler that parks on
 * `stream.onAbort` never ends one on its own.
 *
 * closeApiServer moved from api.ts to main.ts when the api/worker/migrate
 * entrypoints were merged into one process; this file (renamed from
 * api.test.ts) still exercises the same function, unchanged.
 */

const HANG_WINDOW_MS = 750;

let running: ServerType | undefined;

afterEach(async () => {
  const server = running;
  running = undefined;
  if (server === undefined) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

function startServer(app: Hono): Promise<{ server: ServerType; url: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      running = server;
      resolve({ server, url: `http://127.0.0.1:${info.port}` });
    });
  });
}

/** The teardown a bare server.close() performs, with no stream registry: close the server, wait for the callback. */
function closeServerOnly(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  try {
    return (await Promise.race([work.then(() => "settled" as const), pending])) === "settled";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function liveApp() {
  const app = new Hono();
  const streams = registerLiveRoute(app, {
    loadCurrent: async () => [],
    subscribe: async () => async () => {},
  });
  return { app, streams };
}

describe("server shutdown with an open SSE stream", () => {
  it("hangs forever if the server is closed without first ending open streams", async () => {
    // Pins the failure mode this module's teardown exists to avoid, so a future
    // refactor that drops the stream registry fails here rather than in production.
    const { app } = liveApp();
    const { server, url } = await startServer(app);

    const response = await fetch(`${url}/api/live`);
    const reader = response.body?.getReader();
    await reader?.read(); // the stream is established and holding the connection

    const closed = closeServerOnly(server);

    expect(await settlesWithin(closed, HANG_WINDOW_MS)).toBe(false);

    await reader?.cancel();
    await closed;
    running = undefined;
  });

  it("completes when open streams are ended first", async () => {
    const { app, streams } = liveApp();
    const { server, url } = await startServer(app);

    const response = await fetch(`${url}/api/live`);
    const reader = response.body?.getReader();
    await reader?.read();
    expect(streams.size).toBe(1);

    expect(await settlesWithin(closeApiServer(server, streams), HANG_WINDOW_MS)).toBe(true);

    expect(streams.size).toBe(0);
    running = undefined;
    await reader?.cancel().catch(() => {});
  });

  it("unsubscribes each stream it ends, so no Redis connection outlives the process", async () => {
    const unsubscribe = vi.fn(async () => {});
    const app = new Hono();
    const streams = registerLiveRoute(app, {
      loadCurrent: async () => [],
      subscribe: async () => unsubscribe,
    });
    const { server, url } = await startServer(app);

    const response = await fetch(`${url}/api/live`);
    const reader = response.body?.getReader();
    await reader?.read();

    await closeApiServer(server, streams);
    running = undefined;

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await reader?.cancel().catch(() => {});
  });

  it("closes cleanly with no stream attached", async () => {
    const { app, streams } = liveApp();
    const { server, url } = await startServer(app);

    expect((await fetch(`${url}/api/health`).catch(() => null))?.status).toBe(404);

    expect(await settlesWithin(closeApiServer(server, streams), HANG_WINDOW_MS)).toBe(true);
    running = undefined;
  });

  it("is driven by the shutdown handler, which exits 0 rather than hanging", async () => {
    // The composition that runs in production: SIGTERM → createShutdownHandler
    // → closeApiServer. Before the stream registry existed this exited via the
    // timeout at best, and in production not at all — closeContext never ran,
    // so Postgres was never closed cleanly.
    const { app, streams } = liveApp();
    const { server, url } = await startServer(app);

    const response = await fetch(`${url}/api/live`);
    const reader = response.body?.getReader();
    await reader?.read();

    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      logger: { info: vi.fn(), error: vi.fn() },
      exit,
      startMessage: "shutting down",
      failureMessage: "shutdown failed",
      onShutdown: () => closeApiServer(server, streams),
      timeoutMs: 2_000,
    });

    shutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 3_000 });

    expect(exit).toHaveBeenCalledWith(0);
    running = undefined;
    await reader?.cancel().catch(() => {});
  });
});
