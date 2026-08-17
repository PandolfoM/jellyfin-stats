import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "../client.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

let container: StartedPostgreSqlContainer | undefined;

/**
 * Starts one Postgres container for the whole file, runs migrations, and truncates
 * between cases. Real Postgres rather than a mock, because the behavior under test
 * IS the SQL — upsert arithmetic and constraint enforcement.
 */
export async function withTestDatabase(fn: (db: Db) => Promise<void>): Promise<void> {
  container ??= await new PostgreSqlContainer("postgres:17-alpine").start();
  const { db, pool } = createDb(container.getConnectionUri());

  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await pool.query(`
      TRUNCATE playback_rollup_daily, playback_sessions, items, libraries, devices, jellyfin_users
      RESTART IDENTITY CASCADE
    `);
    await fn(db);
  } finally {
    await pool.end();
  }
}

export async function stopTestDatabase(): Promise<void> {
  await container?.stop();
  container = undefined;
}
