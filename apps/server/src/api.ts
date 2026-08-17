import { serve } from "@hono/node-server";
import { loadEnv } from "@jfstats/shared";
import { createApp } from "./api/app.js";
import { closeContext, createContext } from "./context.js";

async function main(): Promise<void> {
  const context = createContext(loadEnv());
  const app = createApp(context);

  const server = serve({ fetch: app.fetch, port: context.env.PORT }, (info) => {
    context.logger.info({ port: info.port }, "api listening");
  });

  const shutdown = async (): Promise<void> => {
    context.logger.info("api shutting down");
    server.close();
    await closeContext(context);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

// Boot when run directly, whether via tsx (src/api.ts) or compiled (dist/api.js).
// Plan 1's `endsWith(".ts")` guard silently no-ops the compiled build; don't repeat it.
const entry = process.argv[1] ?? "";
if (/[/\\]api\.(ts|js)$/.test(entry)) {
  await main();
}
