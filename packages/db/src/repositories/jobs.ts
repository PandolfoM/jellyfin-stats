import type { Db } from "../client.js";
import { jobRuns } from "../schema.js";

/**
 * All recorded job-run timestamps, keyed by job name. This is what replaces
 * BullMQ's in-Redis repeatable-job bookkeeping: the scheduler reads this map
 * once per tick and asks `isDue` (packages/db has no opinion on scheduling
 * logic — it only stores and returns the timestamps) whether each job should
 * run.
 */
export async function readJobRuns(db: Db): Promise<Map<string, Date>> {
  const rows = await db.select().from(jobRuns);
  return new Map(rows.map((row) => [row.name, row.lastRunAt]));
}

/**
 * Upsert rather than insert: `name` is the primary key, and a job runs many
 * times over the life of the process, so this must overwrite the existing row
 * rather than accumulate one row per run.
 */
export async function writeJobRun(db: Db, name: string, at: Date): Promise<void> {
  await db
    .insert(jobRuns)
    .values({ name, lastRunAt: at })
    .onConflictDoUpdate({ target: jobRuns.name, set: { lastRunAt: at } });
}
