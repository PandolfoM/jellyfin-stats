import { eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { appSettings } from "../schema.js";

/**
 * The only keys `app_settings` may hold. A closed set rather than an open
 * string: the table is written from an HTTP handler, and an unbounded key
 * would let a caller fill it with arbitrary rows.
 */
export const APP_SETTING_KEYS = ["custom_css"] as const;
export type AppSettingKey = (typeof APP_SETTING_KEYS)[number];

/**
 * Ceiling on a stored value, in characters. Custom CSS arrives from a textarea
 * and lands in a column with no length limit of its own, so the bound lives
 * here and in the route that writes it. 100k is far past any hand-written
 * stylesheet while still ruling out a request that tries to fill the disk.
 */
export const MAX_SETTING_LENGTH = 100_000;

/**
 * `null` when the key was never set. Callers treat that as "not configured"
 * rather than needing a separate "exists" check.
 */
export async function getSetting(db: Db, key: AppSettingKey): Promise<string | null> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);

  return rows[0]?.value ?? null;
}

/**
 * Upsert, because the caller does not know or care whether the key exists —
 * saving from a settings form is the same operation either way. An empty
 * string deletes instead of storing one, so "cleared" and "never set" are the
 * same state downstream and nothing has to special-case an empty value.
 */
export async function setSetting(db: Db, key: AppSettingKey, value: string): Promise<void> {
  if (value === "") {
    await db.delete(appSettings).where(eq(appSettings.key, key));
    return;
  }

  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    });
}
