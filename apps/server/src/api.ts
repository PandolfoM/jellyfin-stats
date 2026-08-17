import { serve } from "@hono/node-server";
import { loadEnv } from "@jfstats/shared";
import { createApp } from "./api/app.js";
import { closeContext, createContext } from "./context.js";
import { createShutdownHandler } from "./shutdown.js";

async function main(): Promise<void> {
  const context = createContext(loadEnv());
  const app = createApp(context);

  const server = serve({ fetch: app.fetch, port: context.env.PORT }, (info) => {
    context.logger.info({ port: info.port }, "api listening");
  });

  // server.close()'s callback fires once in-flight connections have drained, so
  // sequencing it before closeContext keeps the DB/Redis connections alive for any
  // request still being served rather than yanking them out from under it.
  const closeServer = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

  const shutdown = createShutdownHandler({
    logger: context.logger,
    exit: process.exit,
    startMessage: "api shutting down",
    failureMessage: "api shutdown failed",
    onShutdown: async () => {
      await closeServer();
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
