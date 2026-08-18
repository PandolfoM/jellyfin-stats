import type { OverviewResponse } from "../../api/queries";
import { formatCount, formatDuration } from "../../lib/format";
import { StatCard } from "./StatCard";

export interface StatCardRowProps {
  stats: OverviewResponse | null;
  loading: boolean;
}

// Used once a query has resolved with nothing to show (rather than while it
// is still loading, which `loading` already covers) — `stats` is only ever
// null there because the caller has not fetched yet or hasn't wired a value
// through. Falling back to zeros keeps the row showing "0", never a blank or
// "undefined", which is what the brief's test for this component pins down.
const ZERO_STATS: OverviewResponse = { plays: 0, watchMs: 0, activeUsers: 0, activeItems: 0 };

/**
 * The four headline tiles (plays, watch time, active users, active items)
 * shared by the overview, user detail, and library detail routes. Props
 * only: which numbers to show and whether they're still loading come in
 * from the caller, so this component has no idea which of those three pages
 * it's rendered on. If a future variant ever needs that knowledge, it
 * belongs in a new component, not a branch added here.
 */
export function StatCardRow({ stats, loading }: StatCardRowProps) {
  const data = stats ?? ZERO_STATS;

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <StatCard label="Plays" value={formatCount(data.plays)} loading={loading} />
      <StatCard label="Watch time" value={formatDuration(data.watchMs)} loading={loading} />
      <StatCard label="Active users" value={formatCount(data.activeUsers)} loading={loading} />
      <StatCard label="Active items" value={formatCount(data.activeItems)} loading={loading} />
    </div>
  );
}
