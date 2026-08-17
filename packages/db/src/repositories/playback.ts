import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { items, playbackRollupDaily, playbackSessions } from "../schema.js";

export interface OpenSessionInput {
  playSessionId: string;
  itemId: string;
  userId: string;
  deviceId: string | null;
  client: string | null;
  playMethod: string | null;
  positionTicks: number;
  remoteEndpoint: string | null;
  at: Date;
}

export interface TouchSessionInput {
  playSessionId: string;
  itemId: string;
  positionTicks: number;
  watchedMs: number;
  isPaused: boolean;
  at: Date;
}

export interface CloseSessionInput {
  playSessionId: string;
  itemId: string;
  positionTicks: number;
  runtimeTicks: number | null;
  watchedMs: number;
  completionThreshold: number;
  at: Date;
}

export interface StaleSession {
  playSessionId: string;
  itemId: string;
  userId: string;
  positionTicks: number;
  lastSeenAt: Date;
}

/**
 * Identity of the row a write affected. The applier needs the user and the start day to
 * write a rollup, and neither is available from the live payload once a stream has ended.
 */
export interface SessionRowRef {
  userId: string;
  itemId: string;
  startedAt: Date;
}

const ROW_REF = {
  userId: playbackSessions.userId,
  itemId: playbackSessions.itemId,
  startedAt: playbackSessions.startedAt,
} as const;

export interface RollupDelta {
  /** ISO date, `YYYY-MM-DD`. */
  day: string;
  userId: string;
  itemId: string;
  libraryId: string | null;
  playCount: number;
  watchMs: number;
}

export async function openSession(db: Db, input: OpenSessionInput): Promise<void> {
  await db
    .insert(playbackSessions)
    .values({
      playSessionId: input.playSessionId,
      itemId: input.itemId,
      userId: input.userId,
      deviceId: input.deviceId,
      client: input.client,
      playMethod: input.playMethod,
      positionTicks: input.positionTicks,
      remoteEndpoint: input.remoteEndpoint,
      startedAt: input.at,
      lastSeenAt: input.at,
    })
    // A replayed poll must not create a second row, and must not reset watch time.
    .onConflictDoUpdate({
      target: [playbackSessions.playSessionId, playbackSessions.itemId],
      set: { lastSeenAt: input.at },
    });
}

export async function touchSession(
  db: Db,
  input: TouchSessionInput,
): Promise<SessionRowRef | null> {
  const [row] = await db
    .update(playbackSessions)
    .set({
      positionTicks: input.positionTicks,
      isPaused: input.isPaused,
      lastSeenAt: input.at,
      watchMs: sql`${playbackSessions.watchMs} + ${input.watchedMs}`,
    })
    .where(
      and(
        eq(playbackSessions.playSessionId, input.playSessionId),
        eq(playbackSessions.itemId, input.itemId),
      ),
    )
    .returning(ROW_REF);

  return row ?? null;
}

export async function closeSession(
  db: Db,
  input: CloseSessionInput,
): Promise<SessionRowRef | null> {
  // An unknown runtime cannot be a completion — never divide by a missing value.
  const completed =
    input.runtimeTicks !== null &&
    input.runtimeTicks > 0 &&
    input.positionTicks / input.runtimeTicks >= input.completionThreshold;

  const [row] = await db
    .update(playbackSessions)
    .set({
      positionTicks: input.positionTicks,
      endedAt: input.at,
      lastSeenAt: input.at,
      isPaused: false,
      completed,
      watchMs: sql`${playbackSessions.watchMs} + ${input.watchedMs}`,
    })
    .where(
      and(
        eq(playbackSessions.playSessionId, input.playSessionId),
        eq(playbackSessions.itemId, input.itemId),
        // Only an open session closes. A replayed close returns null rather than
        // counting the play a second time.
        isNull(playbackSessions.endedAt),
      ),
    )
    .returning(ROW_REF);

  return row ?? null;
}

export async function findStaleOpenSessions(db: Db, olderThan: Date): Promise<StaleSession[]> {
  return db
    .select({
      playSessionId: playbackSessions.playSessionId,
      itemId: playbackSessions.itemId,
      userId: playbackSessions.userId,
      positionTicks: playbackSessions.positionTicks,
      lastSeenAt: playbackSessions.lastSeenAt,
    })
    .from(playbackSessions)
    .where(and(isNull(playbackSessions.endedAt), lt(playbackSessions.lastSeenAt, olderThan)));
}

export async function applyRollupDelta(db: Db, input: RollupDelta): Promise<void> {
  await db
    .insert(playbackRollupDaily)
    .values(input)
    .onConflictDoUpdate({
      target: [playbackRollupDaily.day, playbackRollupDaily.userId, playbackRollupDaily.itemId],
      set: {
        playCount: sql`${playbackRollupDaily.playCount} + ${input.playCount}`,
        watchMs: sql`${playbackRollupDaily.watchMs} + ${input.watchMs}`,
        libraryId: sql`coalesce(excluded.library_id, ${playbackRollupDaily.libraryId})`,
      },
    });
}

/**
 * Rebuilds the rollup for `[from, to)` directly from playback_sessions, correcting any
 * drift from lost or double-applied incremental writes. Deleting the range first is
 * what lets it remove rows whose sessions no longer exist.
 */
export async function recomputeRollupRange(db: Db, from: Date, to: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM ${playbackRollupDaily}
      WHERE ${playbackRollupDaily.day} >= ${from.toISOString().slice(0, 10)}
        AND ${playbackRollupDaily.day} <  ${to.toISOString().slice(0, 10)}
    `);

    await tx.execute(sql`
      INSERT INTO ${playbackRollupDaily} (day, user_id, item_id, library_id, play_count, watch_ms)
      SELECT
        (${playbackSessions.startedAt} AT TIME ZONE 'UTC')::date AS day,
        ${playbackSessions.userId},
        ${playbackSessions.itemId},
        max(${items.libraryId}) AS library_id,
        count(*)::int AS play_count,
        coalesce(sum(${playbackSessions.watchMs}), 0) AS watch_ms
      FROM ${playbackSessions}
      LEFT JOIN ${items} ON ${items.id} = ${playbackSessions.itemId}
      WHERE ${playbackSessions.startedAt} >= ${from}
        AND ${playbackSessions.startedAt} <  ${to}
      GROUP BY 1, 2, 3
    `);
  });
}
