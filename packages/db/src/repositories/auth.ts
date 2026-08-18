import { and, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { rateLimits, sessions } from "../schema.js";

export interface SessionRow {
  id: string;
  userId: string;
  userName: string;
  isAdmin: boolean;
  createdAt: Date;
  expiresAt: Date;
}

export async function insertSession(db: Db, row: SessionRow): Promise<void> {
  await db.insert(sessions).values(row);
}

/**
 * One statement, not a read-then-write: the UPDATE's WHERE clause enforces
 * "exists AND not expired" and the RETURNING clause hands back the row it just
 * refreshed. A read followed by a separate update would let a session expire
 * between the two.
 */
export async function selectLiveSession(
  db: Db,
  id: string,
  now: Date,
  nextExpiresAt: Date,
): Promise<Pick<SessionRow, "userId" | "userName" | "isAdmin" | "createdAt"> | null> {
  const rows = await db
    .update(sessions)
    .set({ expiresAt: nextExpiresAt })
    .where(and(eq(sessions.id, id), sql`${sessions.expiresAt} > ${now}`))
    .returning({
      userId: sessions.userId,
      userName: sessions.userName,
      isAdmin: sessions.isAdmin,
      createdAt: sessions.createdAt,
    });

  return rows[0] ?? null;
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

export async function deleteExpiredSessions(db: Db, now: Date): Promise<number> {
  const rows = await db
    .delete(sessions)
    .where(lte(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return rows.length;
}

/**
 * Returns the attempt count inside the current window.
 *
 * The upsert is what makes this atomic under concurrent logins: two requests
 * racing here both hit the same primary key, and Postgres serialises them, so
 * neither can read a stale count and write it back. The DO UPDATE branch resets
 * the counter when the stored window has aged out, and otherwise increments
 * WITHOUT touching window_started_at — that is the fixed-window guarantee.
 */
export async function bumpRateLimit(
  db: Db,
  key: string,
  now: Date,
  windowMs: number,
): Promise<number> {
  const windowStart = new Date(now.getTime() - windowMs);

  const rows = await db
    .insert(rateLimits)
    .values({ key, count: 1, windowStartedAt: now })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`CASE WHEN ${rateLimits.windowStartedAt} <= ${windowStart} THEN 1 ELSE ${rateLimits.count} + 1 END`,
        windowStartedAt: sql`CASE WHEN ${rateLimits.windowStartedAt} <= ${windowStart} THEN ${now} ELSE ${rateLimits.windowStartedAt} END`,
      },
    })
    .returning({ count: rateLimits.count });

  const row = rows[0];
  if (row === undefined) {
    // Unreachable today — INSERT ... ON CONFLICT DO UPDATE ... RETURNING always
    // returns exactly one row — but silently defaulting to "1 attempt used"
    // here would be a fail-OPEN result: it reads as "just started", which is
    // under every real limit. Throwing lets the caller's fail-closed catch
    // (apps/server/src/api/rate-limit.ts) turn this into a rejected attempt
    // instead, keeping the fail-closed guarantee total rather than partial.
    throw new Error("bumpRateLimit: upsert returned no row");
  }
  return row.count;
}
