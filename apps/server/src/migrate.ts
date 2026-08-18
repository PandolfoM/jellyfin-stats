import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@jfstats/shared";

const env = loadEnv();
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

// Resolved from this file, not from cwd: compose runs it from /app.
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/drizzle",
);

try {
  await migrate(drizzle(pool), { migrationsFolder });
  console.log("migrations applied");
} finally {
  await pool.end();
}
