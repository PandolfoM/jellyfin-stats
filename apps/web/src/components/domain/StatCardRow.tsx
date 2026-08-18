import type { OverviewResponse } from "../../api/queries";
import { formatCount, formatDuration } from "../../lib/format";
import { StatCard } from "./StatCard";

/**
 * The two shapes this row can actually be handed — nothing looser. The
 * overview route always has the full four-field `OverviewResponse`; the
 * user- and library-detail routes only ever have `plays`/`watchMs` (neither
 * `getUserDetail` nor `getLibraryStats`, packages/db/src/repositories/stats.ts,
 * returns anything resembling "active users"/"active items" for a single
 * user or library — "active users" is meaningless on a page about one user,
 * and neither detail query computes a real distinct-item count: the
 * top-items list is capped at a handful of rows, so its length is a
 * different number and must not be dressed up as this one).
 *
 * This was originally `Partial<OverviewResponse>`, which technically
 * covered both real shapes but also covered every other subset of the four
 * fields — nothing stopped a caller from passing `{ activeItems: 3 }` alone,
 * or an `OverviewResponse` missing `watchMs`. A `Pick`-based union admits
 * exactly the two shapes that exist and rejects everything else, so if
 * `routes/index.tsx` ever hand-built its `stats` object instead of passing
 * `overview.data` straight through and dropped a field, `pnpm typecheck`
 * would fail at that call site instead of silently rendering three tiles.
 */
export type StatCardRowStats = OverviewResponse | Pick<OverviewResponse, "plays" | "watchMs">;

export interface StatCardRowProps {
  stats: StatCardRowStats | null;
  loading: boolean;
}

// Used once a query has resolved with nothing to show (rather than while it
// is still loading, which `loading` already covers) — `stats` is only ever
// null there because the caller has not fetched yet or hasn't wired a value
// through. Falling back to zeros keeps the row showing "0", never a blank or
// "undefined", which is what the brief's test for this component pins down.
const ZERO_STATS: OverviewResponse = { plays: 0, watchMs: 0, activeUsers: 0, activeItems: 0 };

/**
 * Headline tiles shared by the overview, user detail, and library detail
 * routes. Props only: which numbers to show and whether they're still
 * loading come in from the caller, so this component has no idea which of
 * those three pages it's rendered on — the one piece of variation it needs
 * (fewer tiles on the two detail pages) goes through `stats` itself,
 * per-field, rather than a "which page" flag. If a future variant ever
 * needs more than that, it belongs in a new component, not a branch added
 * here.
 */
export function StatCardRow({ stats, loading }: StatCardRowProps) {
  const data = stats ?? ZERO_STATS;
  // `"activeUsers" in data` (not `!== undefined`) is what lets TypeScript
  // narrow `data` from the `StatCardRowStats` union down to the
  // `OverviewResponse` member specifically — the `Pick<..., "plays" |
  // "watchMs">` member doesn't have this property at all, so an `in` check
  // is both the runtime test and the type-level one, unlike an `!==
  // undefined` check, which would need the property to exist on every
  // member of the union in the first place.
  const hasActiveCounts = "activeUsers" in data;

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <StatCard label="Plays" value={formatCount(data.plays)} loading={loading} />
      <StatCard label="Watch time" value={formatDuration(data.watchMs)} loading={loading} />
      {hasActiveCounts && (
        <>
          <StatCard label="Active users" value={formatCount(data.activeUsers)} loading={loading} />
          <StatCard label="Active items" value={formatCount(data.activeItems)} loading={loading} />
        </>
      )}
    </div>
  );
}
