import type { OverviewResponse } from "../../api/queries";
import { formatCount, formatDuration } from "../../lib/format";
import { StatCard } from "./StatCard";

export interface StatCardRowProps {
  /**
   * `Partial<OverviewResponse>`, not `OverviewResponse` — relaxed for Task
   * 10's user- and library-detail routes, which have no equivalent of
   * `activeUsers`/`activeItems` to show. `getUserDetail` and `getLibraryStat`
   * (packages/db/src/repositories/stats.ts) only ever return `plays` and
   * `watchMs` for a single user/library; "active users" is meaningless on a
   * page about one user, and neither detail query computes a real distinct-
   * item count (the top-items list is capped at a handful of rows, so its
   * length is not that number and must not be dressed up as one). Omitting
   * a field is how a caller opts out of that tile entirely — see the
   * `!== undefined` checks below — rather than this component inventing a
   * number the underlying data doesn't have.
   */
  stats: Partial<OverviewResponse> | null;
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

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <StatCard label="Plays" value={formatCount(data.plays ?? 0)} loading={loading} />
      <StatCard label="Watch time" value={formatDuration(data.watchMs ?? 0)} loading={loading} />
      {data.activeUsers !== undefined && (
        <StatCard label="Active users" value={formatCount(data.activeUsers)} loading={loading} />
      )}
      {data.activeItems !== undefined && (
        <StatCard label="Active items" value={formatCount(data.activeItems)} loading={loading} />
      )}
    </div>
  );
}
