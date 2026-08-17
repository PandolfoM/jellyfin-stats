import {
  createDb,
  playbackRollupDaily,
  playbackSessions,
  recomputeRollupRange,
  upsertItems,
  upsertLibraries,
  upsertUsers,
} from "@jfstats/db";
import { loadEnv } from "@jfstats/shared";
import { like } from "drizzle-orm";

export interface SeedOptions {
  days: number;
  users: number;
  items: number;
  seed: number;
  /**
   * Injected clock so generateSeedData is a pure function of its options, not of
   * wall-clock time — matching the `now?: () => number` pattern used by
   * reconcileOpenSessions and diffSessions. Defaults to Date.now. Tests pass a
   * fixed clock so two calls with the same seed produce byte-identical output;
   * without this, reading Date.now() fresh inside the day loop meant two
   * invocations that straddled a millisecond boundary could disagree.
   */
  now?: () => number;
}

export interface SeedData {
  users: { id: string; name: string; isAdmin: boolean }[];
  libraries: { id: string; name: string; collectionType: string }[];
  items: { id: string; name: string; type: string; libraryId: string; runtimeTicks: number }[];
  sessions: {
    sessionId: string;
    itemId: string;
    userId: string;
    deviceId: string;
    client: string;
    playMethod: string;
    startedAt: Date;
    endedAt: Date;
    lastSeenAt: Date;
    watchMs: number;
    positionTicks: number;
    completed: boolean;
  }[];
}

/** Deterministic PRNG so a given seed always produces the same dataset. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLIENTS = ["Jellyfin Web", "Jellyfin Android", "Jellyfin Roku", "Infuse"];
const PLAY_METHODS = ["DirectPlay", "DirectStream", "Transcode"];

export function generateSeedData(options: SeedOptions): SeedData {
  const random = mulberry32(options.seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  // Read once, up front, so every day in the loop below is computed relative to the
  // same instant. Reading it fresh per iteration was what made two calls with the
  // same seed occasionally disagree.
  const now = (options.now ?? Date.now)();

  const libraries = [
    { id: "seed-lib-movies", name: "Movies", collectionType: "movies" },
    { id: "seed-lib-shows", name: "TV Shows", collectionType: "tvshows" },
  ];

  const users = Array.from({ length: options.users }, (_, index) => ({
    id: `seed-user-${index}`,
    name: `demo-user-${index}`,
    isAdmin: index === 0,
  }));

  const items = Array.from({ length: options.items }, (_, index) => {
    const library = libraries[index % libraries.length] as (typeof libraries)[number];
    return {
      id: `seed-item-${index}`,
      name: `${library.collectionType === "movies" ? "Demo Movie" : "Demo Episode"} ${index + 1}`,
      type: library.collectionType === "movies" ? "Movie" : "Episode",
      libraryId: library.id,
      // 20 to 140 minutes, in ticks (10,000 ticks per millisecond).
      runtimeTicks: Math.floor((20 + random() * 120) * 60 * 1000 * 10_000),
    };
  });

  const sessions: SeedData["sessions"] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  let counter = 0;

  for (let dayOffset = options.days; dayOffset > 0; dayOffset -= 1) {
    // Weekends get more viewing, so the trend charts have visible shape.
    const dayStart = now - dayOffset * dayMs;
    const isWeekend = [0, 6].includes(new Date(dayStart).getUTCDay());
    const playsToday = Math.floor(random() * (isWeekend ? 12 : 6));

    for (let play = 0; play < playsToday; play += 1) {
      const user = pick(users);
      const item = pick(items);
      const startedAt = new Date(dayStart + Math.floor(random() * dayMs));
      const runtimeMs = item.runtimeTicks / 10_000;
      // Most plays finish; some are abandoned early.
      const fraction = random() < 0.7 ? 0.9 + random() * 0.1 : random() * 0.6;
      const watchMs = Math.floor(runtimeMs * fraction);

      counter += 1;
      sessions.push({
        // A fake per-play identifier. Every generated session is closed (endedAt is
        // always set below), so these fall outside the schema's partial unique index
        // (session_id, item_id) WHERE ended_at IS NULL — that index only constrains
        // open sessions. Using a fresh id per play (rather than reusing one id per
        // user, the way a real Jellyfin client connection would) is what guarantees
        // the uniqueness the "unique play session and item pair" test checks for.
        sessionId: `seed-ps-${counter}`,
        itemId: item.id,
        userId: user.id,
        deviceId: `seed-device-${user.id}`,
        client: pick(CLIENTS),
        playMethod: pick(PLAY_METHODS),
        startedAt,
        endedAt: new Date(startedAt.getTime() + watchMs),
        lastSeenAt: new Date(startedAt.getTime() + watchMs),
        watchMs,
        positionTicks: Math.floor(item.runtimeTicks * fraction),
        completed: fraction >= 0.9,
      });
    }
  }

  return { users, libraries, items, sessions };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);
  const data = generateSeedData({ days: 90, users: 4, items: 60, seed: 42 });

  try {
    // Every generated session is closed, so re-running this script would never hit
    // the schema's partial identity index (open rows only) and onConflictDoNothing
    // would never fire — a second run would just double every row. Deleting this
    // script's own prior output first, scoped strictly to seed-prefixed
    // identifiers, is what makes re-running safe. This must never touch the real
    // data synced from a live Jellyfin server, so the WHERE clauses match only the
    // "seed-" / "seed-user-" prefixes this script itself writes.
    const removedSessions = await db
      .delete(playbackSessions)
      .where(like(playbackSessions.sessionId, "seed-%"))
      .returning({ id: playbackSessions.id });
    const removedRollup = await db
      .delete(playbackRollupDaily)
      .where(like(playbackRollupDaily.userId, "seed-user-%"))
      .returning({ day: playbackRollupDaily.day });
    console.log(
      `Removed ${removedSessions.length} previously seeded sessions and ${removedRollup.length} previously seeded rollup rows.`,
    );

    // Users, libraries, and items are upserted (keyed on id), so re-running is
    // already safe for them without any delete.
    await upsertUsers(db, data.users);
    await upsertLibraries(db, data.libraries);
    await upsertItems(db, data.items);
    // The delete above already cleared every seed-prefixed session, so this insert
    // never actually collides — onConflictDoNothing is kept only as a harmless
    // backstop, not something the idempotency guarantee relies on.
    await db.insert(playbackSessions).values(data.sessions).onConflictDoNothing();

    // Build the rollup from the sessions we just wrote, using the same code path
    // the nightly job uses — so seeded data exercises the real aggregation.
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const from = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    await recomputeRollupRange(db, from, to);

    console.log(`Seeded ${data.sessions.length} sessions across ${data.users.length} users.`);
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly, so importing this module in tests is side-effect free.
if (process.argv[1]?.endsWith("seed.ts")) {
  await main();
}
