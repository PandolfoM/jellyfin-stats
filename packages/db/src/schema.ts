import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Jellyfin-issued identifiers are 32-character dashless hex. They are stored as
// text verbatim; converting to uuid on every read and write buys nothing.

export const jellyfinUsers = pgTable("jellyfin_users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  archived: boolean("archived").notNull().default(false),
});

export const libraries = pgTable("libraries", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  collectionType: text("collection_type"),
  itemCount: integer("item_count").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
});

export const items = pgTable(
  "items",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id"),
    type: text("type").notNull(),
    name: text("name").notNull(),
    seriesId: text("series_id"),
    seasonId: text("season_id"),
    productionYear: integer("production_year"),
    runtimeTicks: bigint("runtime_ticks", { mode: "number" }),
    imageTag: text("image_tag"),
    archived: boolean("archived").notNull().default(false),
  },
  (table) => [
    index("items_library_idx").on(table.libraryId),
    index("items_series_idx").on(table.seriesId),
  ],
);

export const devices = pgTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  client: text("client"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});

export const playbackSessions = pgTable(
  "playback_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Jellyfin's session Id: the identifier for the client connection, stable across
    // items played on it for the connection's lifetime. Not a "play session id" —
    // Jellyfin 10.11.11's /Sessions response has no such field.
    sessionId: text("session_id").notNull(),
    userId: text("user_id").notNull(),
    itemId: text("item_id").notNull(),
    deviceId: text("device_id"),
    client: text("client"),
    playMethod: text("play_method"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    positionTicks: bigint("position_ticks", { mode: "number" }).notNull().default(0),
    watchMs: bigint("watch_ms", { mode: "number" }).notNull().default(0),
    // Every write path in the applier (openSession, touchSession, closeSession) sets
    // this explicitly now — the default is a backstop for inserts outside that path
    // (e.g. tests seeding rows directly for unrelated recompute scenarios), not a
    // value anything in the live pipeline relies on.
    isPaused: boolean("is_paused").notNull().default(false),
    completed: boolean("completed").notNull().default(false),
    remoteEndpoint: text("remote_endpoint"),
  },
  (table) => [
    // The idempotency guarantee: a replayed poll updates this row instead of
    // inserting a phantom second stream. Scoped to OPEN rows only (partial index) —
    // a Jellyfin session id is stable across items for the life of a client
    // connection, so re-watching the same item later in the same browser session
    // reuses (session_id, item_id). A plain unique index would collide with the
    // earlier, now-completed row and the replay would never open a new one. Once a
    // row is ended it drops out of this index and stops constraining anything.
    uniqueIndex("playback_sessions_identity_uniq")
      .on(table.sessionId, table.itemId)
      .where(sql`${table.endedAt} is null`),
    index("playback_sessions_open_idx").on(table.endedAt),
    index("playback_sessions_user_started_idx").on(table.userId, table.startedAt),
    index("playback_sessions_item_started_idx").on(table.itemId, table.startedAt),
  ],
);

export const playbackRollupDaily = pgTable(
  "playback_rollup_daily",
  {
    day: date("day").notNull(),
    userId: text("user_id").notNull(),
    itemId: text("item_id").notNull(),
    libraryId: text("library_id"),
    playCount: integer("play_count").notNull().default(0),
    watchMs: bigint("watch_ms", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.userId, table.itemId] }),
    index("rollup_day_idx").on(table.day),
    index("rollup_user_day_idx").on(table.userId, table.day),
    index("rollup_item_day_idx").on(table.itemId, table.day),
    index("rollup_library_day_idx").on(table.libraryId, table.day),
  ],
);
