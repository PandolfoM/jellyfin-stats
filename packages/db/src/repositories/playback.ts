import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { items, playbackRollupDaily, playbackSessions } from "../schema.js";

export interface OpenSessionInput {
  sessionId: string;
  itemId: string;
  userId: string;
  deviceId: string | null;
  client: string | null;
  playMethod: string | null;
  positionTicks: number;
  isPaused: boolean;
  remoteEndpoint: string | null;
  at: Date;
}

export interface TouchSessionInput {
  sessionId: string;
  itemId: string;
  positionTicks: number;
  watchedMs: number;
  isPaused: boolean;
  at: Date;
}

export interface CloseSessionInput {
  sessionId: string;
  itemId: string;
  positionTicks: number;
  runtimeTicks: number | null;
  watchedMs: number;
  completionThreshold: number;
  at: Date;
}

export interface StaleSession {
  sessionId: string;
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
  /**
   * Optional override for the rollup row's library_id. Callers normally omit this (or
   * pass `null`, which is treated the same): applyRollupDelta resolves it itself from
   * the items table via a subquery, which is the only place that reliably knows an
   * item's library. Pass a string explicitly only when the caller has better
   * information than items.libraryId currently holds (there is no such caller today).
   * Either way, the onConflictDoUpdate coalesce below keeps whatever library id an
   * earlier delta for the same row already established, so a delta that resolves to
   * null never blanks out a value a previous delta found.
   */
  libraryId?: string | null;
  playCount: number;
  watchMs: number;
}

export async function openSession(db: Db, input: OpenSessionInput): Promise<void> {
  await db
    .insert(playbackSessions)
    .values({
      sessionId: input.sessionId,
      itemId: input.itemId,
      userId: input.userId,
      deviceId: input.deviceId,
      client: input.client,
      playMethod: input.playMethod,
      positionTicks: input.positionTicks,
      isPaused: input.isPaused,
      remoteEndpoint: input.remoteEndpoint,
      startedAt: input.at,
      lastSeenAt: input.at,
    })
    // A replayed poll must not create a second row, and must not reset watch time.
    // The conflict target matches the partial unique index (open rows only), so a
    // re-watch of the same (sessionId, itemId) after the earlier row closed misses
    // this conflict entirely and inserts a fresh open row instead.
    .onConflictDoUpdate({
      target: [playbackSessions.sessionId, playbackSessions.itemId],
      targetWhere: sql`${playbackSessions.endedAt} is null`,
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
        eq(playbackSessions.sessionId, input.sessionId),
        eq(playbackSessions.itemId, input.itemId),
        // Only the OPEN row for this identity may be touched. Without this, a
        // re-watch of the same (sessionId, itemId) would add its watch time onto the
        // earlier, already-closed historical row instead of the new open one.
        isNull(playbackSessions.endedAt),
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
        eq(playbackSessions.sessionId, input.sessionId),
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
      sessionId: playbackSessions.sessionId,
      itemId: playbackSessions.itemId,
      userId: playbackSessions.userId,
      positionTicks: playbackSessions.positionTicks,
      lastSeenAt: playbackSessions.lastSeenAt,
    })
    .from(playbackSessions)
    .where(and(isNull(playbackSessions.endedAt), lt(playbackSessions.lastSeenAt, olderThan)));
}

export async function applyRollupDelta(db: Db, input: RollupDelta): Promise<void> {
  // The applier has no reliable way to know an item's library at write time — items
  // may not have synced yet, or the write is driven only by the session row. Resolving
  // it here, from the items table, is what lets the incremental path agree with
  // recomputeRollupRange (which derives it the same way, via `max(items.library_id)`)
  // instead of always writing NULL and waiting on the nightly recompute to fill it in.
  const libraryId =
    input.libraryId ??
    sql`(select ${items.libraryId} from ${items} where ${items.id} = ${input.itemId})`;

  await db
    .insert(playbackRollupDaily)
    .values({
      day: input.day,
      userId: input.userId,
      itemId: input.itemId,
      libraryId,
      playCount: input.playCount,
      watchMs: input.watchMs,
    })
    .onConflictDoUpdate({
      target: [playbackRollupDaily.day, playbackRollupDaily.userId, playbackRollupDaily.itemId],
      set: {
        playCount: sql`${playbackRollupDaily.playCount} + ${input.playCount}`,
        watchMs: sql`${playbackRollupDaily.watchMs} + ${input.watchMs}`,
        // A known library id from an earlier delta must never be overwritten by NULL
        // from a later one that couldn't resolve it.
        libraryId: sql`coalesce(excluded.library_id, ${playbackRollupDaily.libraryId})`,
      },
    });
}

function toUtcDayString(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function utcDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function isUtcDayStart(at: Date): boolean {
  return at.getTime() === utcDayStart(toUtcDayString(at)).getTime();
}

/** The UTC day string one day after `day`. */
function nextUtcDayString(day: string): string {
  const next = utcDayStart(day);
  next.setUTCDate(next.getUTCDate() + 1);
  return toUtcDayString(next);
}

/**
 * Rebuilds the rollup for `[from, to)` directly from playback_sessions, correcting any
 * drift from lost or double-applied incremental writes. Deleting the range first is
 * what lets it remove rows whose sessions no longer exist.
 *
 * The range is half-open on whole UTC days, not on the raw instants passed in: any
 * `from`/`to` that falls inside a day pulls that entire day into the recompute. `from`
 * is floored to the start of its day (the WHERE clause already covers the rest of that
 * day). `to` is ceiled to the start of the *next* day unless it already lands exactly
 * on a day boundary, so that a `to` of, say, 05:00 still pulls its whole day in rather
 * than rebuilding it from a partial slice. Both the DELETE and the INSERT are derived
 * from these same normalized day boundaries, so they always cover an identical set of
 * days — otherwise the INSERT can try to write a day the DELETE never cleared, which
 * throws a primary-key violation (or, if no prior row existed, silently writes a
 * partial day).
 */
export async function recomputeRollupRange(db: Db, from: Date, to: Date): Promise<void> {
  const fromDay = toUtcDayString(from);
  const toDay = isUtcDayStart(to) ? toUtcDayString(to) : nextUtcDayString(toUtcDayString(to));
  const fromDayStart = utcDayStart(fromDay);
  const toDayStart = utcDayStart(toDay);

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM ${playbackRollupDaily}
      WHERE ${playbackRollupDaily.day} >= ${fromDay}
        AND ${playbackRollupDaily.day} <  ${toDay}
    `);

    // A bare timestamp comparison (rather than casting started_at to a date) lets this
    // use the user/item + started_at indexes instead of forcing a scan. The normalized
    // fromDayStart/toDayStart bounds make it cover exactly the same days as the DELETE.
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
      WHERE ${playbackSessions.startedAt} >= ${fromDayStart}
        AND ${playbackSessions.startedAt} <  ${toDayStart}
      GROUP BY
        (${playbackSessions.startedAt} AT TIME ZONE 'UTC')::date,
        ${playbackSessions.userId},
        ${playbackSessions.itemId}
    `);
  });
}
