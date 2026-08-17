import { createDb, recomputeRollupRange } from "@jfstats/db";
import { loadEnv } from "@jfstats/shared";

export interface BackfillRange {
  from: Date;
  to: Date;
}

const USAGE =
  "Usage: pnpm --filter @jfstats/server backfill --from <YYYY-MM-DD> --to <YYYY-MM-DD>";

/**
 * Reads `--from` / `--to` out of raw argv. Both forms are accepted (`--from X` and
 * `--from=X`) because both are what people actually type.
 */
function readFlag(argv: readonly string[], name: string): string | undefined {
  const flag = `--${name}`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === flag) return argv[index + 1];
    if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * Parses a `YYYY-MM-DD` argument into the UTC start of that day.
 *
 * Two checks, because Date is permissive in two different directions. The shape regex
 * rejects `2026-8-1`, which parses fine but in *local* time, shifting the window by the
 * operator's UTC offset with no error. The round-trip comparison rejects `2026-02-30`,
 * which V8 does not treat as invalid — it rolls the overflow forward to 2 March, so a
 * typo would quietly rebuild a different range than the one asked for.
 */
function parseUtcDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString().slice(0, 10) === value ? at : null;
}

/**
 * Validates the arguments and returns the range, or an error message explaining what
 * is wrong. Separated from main() so it is a pure function of argv.
 */
export function parseBackfillArgs(argv: readonly string[]): BackfillRange | { error: string } {
  const rawFrom = readFlag(argv, "from");
  const rawTo = readFlag(argv, "to");

  if (rawFrom === undefined || rawTo === undefined) {
    const missing = [
      rawFrom === undefined ? "--from" : null,
      rawTo === undefined ? "--to" : null,
    ].filter((name): name is string => name !== null);

    return { error: `Missing required argument(s): ${missing.join(", ")}.\n${USAGE}` };
  }

  const from = parseUtcDay(rawFrom);
  const to = parseUtcDay(rawTo);

  if (from === null) return { error: `Could not parse --from "${rawFrom}" as YYYY-MM-DD.\n${USAGE}` };
  if (to === null) return { error: `Could not parse --to "${rawTo}" as YYYY-MM-DD.\n${USAGE}` };

  // recomputeRollupRange ceils a `to` that is not already on a day boundary up to the
  // next day, so a same-day --from/--to rebuilds exactly that one day. An inverted
  // range would silently rebuild nothing, which is worse than refusing.
  if (to.getTime() < from.getTime()) {
    return { error: `--to (${rawTo}) is before --from (${rawFrom}).\n${USAGE}` };
  }

  return { from, to };
}

/** Whole UTC days the range covers, for reporting what was rebuilt. */
export function dayCount(range: BackfillRange): number {
  const dayMs = 24 * 60 * 60 * 1000;
  // `to` on a day boundary is exclusive; a same-day range still covers one day.
  return Math.max(1, (range.to.getTime() - range.from.getTime()) / dayMs);
}

/**
 * Rebuilds playback_rollup_daily over an arbitrary range from playback_sessions.
 *
 * The nightly job only ever repairs the trailing 7 days. When rollups drift further
 * back than that — a worker down for over a week, a restore from an older dump — this
 * is the recovery path, so that the alternative is not hand-written SQL or running the
 * seed script (which would inject 90 days of fake history into a real database).
 */
async function main(): Promise<void> {
  const parsed = parseBackfillArgs(process.argv.slice(2));

  if ("error" in parsed) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }

  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);
  const fromDay = parsed.from.toISOString().slice(0, 10);
  const toDay = parsed.to.toISOString().slice(0, 10);

  try {
    console.log(`Rebuilding daily rollups from ${fromDay} through ${toDay}...`);
    await recomputeRollupRange(db, parsed.from, parsed.to);
    console.log(
      `Rebuilt ${dayCount(parsed)} day(s) of playback_rollup_daily from playback_sessions.`,
    );
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly, so importing this module in tests is side-effect free.
if (process.argv[1]?.endsWith("backfill.ts")) {
  await main();
}
