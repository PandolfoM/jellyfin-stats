import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLiveRoute, type LiveStreamRegistry } from "./api/routes/live.js";
import type { AppContext } from "./context.js";
import { closeApiServer, shutdownApp, startApp, type StartAppDeps } from "./main.js";
import { createShutdownHandler } from "./shutdown.js";
import { createSnapshotStore } from "./sync/snapshot-store.js";

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

  it("unsubscribes each stream it ends, so no listener outlives the process", async () => {
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
    // Only createShutdownHandler + closeApiServer, not the full production
    // composition — this handler's onShutdown is `() => closeApiServer(...)`
    // alone, deliberately, to isolate exit-0-vs-hang from everything else
    // onShutdown does in production. The real composition — scheduler.stop()
    // before closeApiServer before closeContext — is `shutdownApp`, and its
    // *order* (not just that it eventually exits 0) is what the "shutdownApp
    // order" tests below pin. Before the stream registry existed at all, this
    // exited via the timeout at best, and in production not at all —
    // closeContext never ran, so Postgres was never closed cleanly.
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

/**
 * `main()` itself is not exported or exercised here — it does real env
 * loading, a real Postgres connection, and process.on registration, none of
 * which belongs in a unit test. `startApp` and `shutdownApp` exist precisely
 * so the *order* of the startup and shutdown sequences — the entire reason
 * this task exists — is something these tests can pin with injected fakes
 * and no real Postgres, socket, or scheduler timer, rather than only being
 * checked by eye or by the manual boot in the task report.
 */
describe("startApp order", () => {
  function fakeContext(): AppContext {
    // Only what createApp reads directly during construction (not via a
    // closure it defers until a real request/shutdown) needs a real shape;
    // everything else is a stand-in that is never called in this test.
    return {
      env: {
        PORT: 0,
        staleSessionAfterMs: 0,
        COMPLETION_THRESHOLD: 0.9,
        SESSION_TTL_HOURS: 1,
        COOKIE_SECURE: false,
        TRUST_PROXY_HEADERS: false,
      },
      db: {},
      pool: {},
      jellyfin: {},
      snapshots: createSnapshotStore(),
      logger: { info: vi.fn(), error: vi.fn() },
    } as unknown as AppContext;
  }

  function fakeDeps(order: string[], fakeServer: ServerType): StartAppDeps {
    return {
      migrate: (async () => {
        order.push("migrate");
      }) as unknown as StartAppDeps["migrate"],
      reconcile: (async () => {
        order.push("reconcile");
        return 0;
      }) as unknown as StartAppDeps["reconcile"],
      startScheduler: (() => {
        order.push("scheduler");
        return { stop: async () => {} };
      }) as unknown as StartAppDeps["startScheduler"],
      serve: ((_options: unknown, listener?: (info: AddressInfo) => void) => {
        order.push("serve");
        listener?.({ address: "127.0.0.1", family: "IPv4", port: 0 } as AddressInfo);
        return fakeServer;
      }) as unknown as StartAppDeps["serve"],
    };
  }

  it("runs migrate, then reconcile, then the scheduler, then the HTTP listener — in that order", async () => {
    // This is the assertion the report's finding 1 says nothing pins: delete
    // the reconcile step (or reorder any of the four) in main.ts's startApp
    // and this goes red, where it was previously silently green under any
    // mutation to that sequence.
    const order: string[] = [];
    const fakeServer = { close: vi.fn() } as unknown as ServerType;

    const started = await startApp(fakeContext(), fakeDeps(order, fakeServer));

    expect(order).toEqual(["migrate", "reconcile", "scheduler", "serve"]);
    expect(started.server).toBe(fakeServer);
  });
});

describe("shutdownApp order", () => {
  it("stops the scheduler, then ends streams and closes the server, then closes the context", async () => {
    // The order the brief calls the most important thing in this task, and
    // which nothing else pins: scheduler.stop() must finish (draining
    // in-flight jobs) before closeApiServer runs, and closeApiServer's own
    // stream-then-server sequencing must finish before closeContext tears
    // down the pool a still-running job could otherwise write into.
    const order: string[] = [];

    const scheduler = {
      stop: vi.fn(async () => {
        order.push("scheduler");
      }),
    };
    const liveStreams = {
      size: 0,
      closeAll: vi.fn(async () => {
        order.push("streams");
      }),
    } as unknown as LiveStreamRegistry;
    const server = {
      close: vi.fn((cb?: (error?: Error) => void) => {
        order.push("server");
        cb?.();
      }),
    } as unknown as ServerType;
    const context = {
      pool: {
        end: vi.fn(async () => {
          order.push("context");
        }),
      },
    } as unknown as AppContext;

    await shutdownApp({ scheduler, server, liveStreams, context });

    expect(order).toEqual(["scheduler", "streams", "server", "context"]);
  });
});
