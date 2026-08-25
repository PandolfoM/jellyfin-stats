import { serve, type ServerType } from "@hono/node-server";
import { applyRollupDelta, closeSession, findStaleOpenSessions } from "@jfstats/db";
import { loadEnv } from "@jfstats/shared";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./api/app.js";
import type { LiveStreamRegistry } from "./api/routes/live.js";
import { closeContext, createContext, type AppContext } from "./context.js";
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

/**
 * The pieces of the startup sequence that can plausibly need swapping out in a
 * test: the migration runner, session reconciliation, the scheduler, and the
 * HTTP listener. Defaulted to the real implementations below; overridden in
 * main.test.ts so the *order* they run in can be asserted without a real
 * Postgres, a real socket, or a real scheduler timer.
 */
export interface StartAppDeps {
  migrate: typeof migrate;
  reconcile: typeof reconcileOpenSessions;
  startScheduler: typeof startScheduler;
  serve: typeof serve;
}

const defaultStartAppDeps: StartAppDeps = {
  migrate,
  reconcile: reconcileOpenSessions,
  startScheduler,
  serve,
};

export interface StartedApp {
  scheduler: { stop(): Promise<void> };
  server: ServerType;
  liveStreams: LiveStreamRegistry;
}

/**
 * The startup sequence, in the one order that is safe:
 *
 * 1. Migrate — nothing else may touch the database first. One process means
 *    no second migrator to race, which is what let the separate migrate
 *    service go away.
 * 2. Reconcile — repairs sessions left open by an unclean shutdown. Startup
 *    behavior from the original pipeline; dropping it silently loses watch
 *    time. Must run after the schema exists (migrate) and before the
 *    scheduler starts polling, so a session-poll can never race reconciling
 *    the same row.
 * 3. Scheduler — its first tick reads `job_runs`, which migrate just created;
 *    nothing about serving requests needs to happen before this.
 * 4. HTTP listener — last, once everything it could route a request to is
 *    already in a consistent state.
 *
 * Exported, with the four steps behind `deps`, precisely so this order is
 * something a test can pin directly — see the "startApp order" tests in
 * main.test.ts, which fail if any step is skipped or reordered.
 */
export async function startApp(
  context: AppContext,
  deps: StartAppDeps = defaultStartAppDeps,
): Promise<StartedApp> {
  await deps.migrate(context.db, { migrationsFolder });
  context.logger.info("migrations applied");

  const repaired = await deps.reconcile({
    db: context.db,
    staleAfterMs: context.env.staleSessionAfterMs,
    completionThreshold: context.env.COMPLETION_THRESHOLD,
    findStaleOpenSessions,
    closeSession,
    applyRollupDelta,
  });
  context.logger.info({ repaired }, "startup reconciliation complete");

  const scheduler = deps.startScheduler(context);
  const { app, liveStreams } = createApp(context);

  const server = deps.serve({ fetch: app.fetch, port: context.env.PORT }, (info) => {
    context.logger.info({ port: info.port }, "listening");
  });

  return { scheduler, server, liveStreams };
}

export interface ShutdownAppArgs {
  scheduler: { stop(): Promise<void> };
  server: ServerType;
  liveStreams: LiveStreamRegistry;
  context: AppContext;
}

/**
 * Shutdown, in the one order that terminates rather than hanging or silently
 * corrupting a still-in-flight write:
 *
 * 1. Stop the scheduler and await its in-flight jobs — no new work starts
 *    while the rest tears down, and nothing is still running once the pool
 *    closes underneath it.
 * 2. `closeApiServer` — ends SSE streams before awaiting the HTTP server's
 *    close, for the reason documented on that function: its callback never
 *    fires while a stream is still open.
 * 3. Close the context — last, once nothing above still needs the database.
 *
 * Exported, taking its collaborators as one object, so this order is
 * something a test can pin directly — see the "shutdownApp order" tests in
 * main.test.ts, which fail if any step is skipped or reordered.
 */
export async function shutdownApp({
  scheduler,
  server,
  liveStreams,
  context,
}: ShutdownAppArgs): Promise<void> {
  await scheduler.stop();
  await closeApiServer(server, liveStreams);
  await closeContext(context);
}

async function main(): Promise<void> {
  const context = createContext(loadEnv());

  let started: StartedApp;
  try {
    started = await startApp(context);
  } catch (error) {
    // A rejection here (most likely migrate() failing because Postgres isn't
    // reachable) would otherwise propagate out of the top-level `await main()`
    // below as an unhandled rejection — printed by Node's default handler with
    // no logger line and therefore none of logger.ts's redaction. DATABASE_URL
    // carries a password, and a pg connection error routinely echoes the
    // connection string back. Routing it through the logger keeps it on the
    // redaction path; closeContext releases whatever startApp already opened
    // (at minimum the pool) instead of leaking it on exit.
    context.logger.error({ err: error }, "startup failed");
    await closeContext(context);
    process.exit(1);
  }

  const { scheduler, server, liveStreams } = started;

  const shutdown = createShutdownHandler({
    logger: context.logger,
    exit: process.exit,
    startMessage: "shutting down",
    failureMessage: "shutdown failed",
    onShutdown: () => shutdownApp({ scheduler, server, liveStreams, context }),
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
