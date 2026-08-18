import { serve, type ServerType } from "@hono/node-server";
import { applyRollupDelta, closeSession, findStaleOpenSessions } from "@jfstats/db";
import { loadEnv } from "@jfstats/shared";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./api/app.js";
import type { LiveStreamRegistry } from "./api/routes/live.js";
import { closeContext, createContext } from "./context.js";
import { startScheduler } from "./scheduler.js";
import { createShutdownHandler } from "./shutdown.js";
import { reconcileOpenSessions } from "./sync/reconcile.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/drizzle",
);

/**
 * Shuts the HTTP server down in the one order that terminates.
 *
 * `server.close()`'s callback does not fire until every in-flight connection has
 * ended, and an SSE handler parks until its client disconnects — so closing the
 * server first, with a dashboard tab attached, waits forever: closeContext never
 * runs, Postgres is never closed cleanly, and the process only dies when the
 * supervisor's grace period expires and SIGKILL lands. Ending the open streams
 * first turns those connections idle, which is what lets close() finish.
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

  // Before anything reads or writes. One process means no second migrator to
  // race, which is what let the separate migrate service go away.
  await migrate(context.db, { migrationsFolder });
  context.logger.info("migrations applied");

  // Repairs sessions left open by an unclean shutdown. Startup behavior from
  // the original pipeline — dropping it silently loses watch time.
  const repaired = await reconcileOpenSessions({
    db: context.db,
    staleAfterMs: context.env.staleSessionAfterMs,
    completionThreshold: context.env.COMPLETION_THRESHOLD,
    findStaleOpenSessions,
    closeSession,
    applyRollupDelta,
  });
  context.logger.info({ repaired }, "startup reconciliation complete");

  const scheduler = startScheduler(context);
  const { app, liveStreams } = createApp(context);

  const server = serve({ fetch: app.fetch, port: context.env.PORT }, (info) => {
    context.logger.info({ port: info.port }, "listening");
  });

  const shutdown = createShutdownHandler({
    logger: context.logger,
    exit: process.exit,
    startMessage: "shutting down",
    failureMessage: "shutdown failed",
    onShutdown: async () => {
      // Scheduler first: no new work starts while the rest is torn down.
      await scheduler.stop();
      // SSE streams before the server close. server.close()'s callback waits
      // for every in-flight connection, and an attached stream never ends on
      // its own — closing the server first waits forever.
      await closeApiServer(server, liveStreams);
      await closeContext(context);
    },
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Boot when run directly, whether via tsx (src/main.ts) or compiled (dist/main.js).
// Without this guard, importing main.ts anywhere (e.g. main.test.ts, to reach
// closeApiServer) would run the whole startup sequence — migrations, a real HTTP
// listener, signal handlers — as a side effect of the import. Plan 1's
// `endsWith(".ts")` guard on the old worker.ts silently no-ops the compiled build;
// this mirrors api.ts's regex instead, which does not have that gap.
const entry = process.argv[1] ?? "";
if (/[/\\]main\.(ts|js)$/.test(entry)) {
  await main();
}
