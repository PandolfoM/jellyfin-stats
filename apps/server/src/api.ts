import { serve, type ServerType } from "@hono/node-server";
import { loadEnv } from "@jfstats/shared";
import { createApp } from "./api/app.js";
import type { LiveStreamRegistry } from "./api/routes/live.js";
import { closeContext, createContext } from "./context.js";
import { createShutdownHandler } from "./shutdown.js";

/**
 * Shuts the HTTP server down in the one order that terminates.
 *
 * `server.close()`'s callback does not fire until every in-flight connection has
 * ended, and an SSE handler parks until its client disconnects — so closing the
 * server first, with a dashboard tab attached, waits forever: closeContext never
 * runs, Postgres and Redis are never closed cleanly, and the process only dies
 * when the supervisor's grace period expires and SIGKILL lands. Ending the open
 * streams first turns those connections idle, which is what lets close() finish.
 *
 * Ordinary in-flight requests are still drained rather than destroyed (no
 * closeAllConnections here) — they end on their own in milliseconds, and
 * createShutdownHandler's timeout is the backstop if one does not.
 *
 * Exported so the deadlock this prevents can be tested against a real socket.
 */
export async function closeApiServer(
  server: ServerType,
  liveStreams: LiveStreamRegistry,
): Promise<void> {
  await liveStreams.closeAll();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const context = createContext(loadEnv());
  const { app, liveStreams } = createApp(context);

  const server = serve({ fetch: app.fetch, port: context.env.PORT }, (info) => {
    context.logger.info({ port: info.port }, "api listening");
  });

  const shutdown = createShutdownHandler({
    logger: context.logger,
    exit: process.exit,
    startMessage: "api shutting down",
    failureMessage: "api shutdown failed",
    onShutdown: async () => {
      // Sequenced before closeContext so the DB/Redis connections stay alive for
      // any request still being served rather than being yanked out from under it.
      await closeApiServer(server, liveStreams);
      await closeContext(context);
    },
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Boot when run directly, whether via tsx (src/api.ts) or compiled (dist/api.js).
// Plan 1's `endsWith(".ts")` guard silently no-ops the compiled build; don't repeat it.
const entry = process.argv[1] ?? "";
if (/[/\\]api\.(ts|js)$/.test(entry)) {
  await main();
}
