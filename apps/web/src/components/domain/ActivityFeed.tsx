import type { HistoryResponse } from "../../api/queries";
import { formatDay, formatDuration } from "../../lib/format";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import { EmptyState } from "./EmptyState";

// There is no standalone `HistoryRow` export from queries.ts — the history
// endpoint's response is `{ rows, total }` — so this is derived from the one
// exported response type rather than re-declared by hand. See the note at
// the top of queries.ts for why a hand-written parallel shape is this repo's
// most expensive recurring defect class.
export type ActivityRow = HistoryResponse["rows"][number];

export interface ActivityFeedProps {
  rows: ActivityRow[];
  loading: boolean;
}

const SKELETON_ROW_COUNT = 5;

/**
 * Compact recent-activity list for the overview route: who played what and
 * for how long, most recent first (the order `historyQuery` already returns
 * rows in). Props only — no fetching, no knowledge of what range or filters
 * produced `rows` — so a future route (a per-user or per-library activity
 * panel) can reuse it exactly like `TopContentList`.
 *
 * `row.startedAt` arrives as a full ISO timestamp (JSON has no `Date` type),
 * not the plain `YYYY-MM-DD` day `formatDay` expects — sliced to the first
 * 10 characters before formatting, which is a UTC calendar day regardless of
 * the time-of-day portion that follows it.
 */
export function ActivityFeed({ rows, loading }: ActivityFeedProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading recent activity">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No recent activity"
        description="Nothing has played in the selected range."
      />
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.id} className="flex items-center justify-between gap-3 text-sm">
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-foreground">{row.itemName}</span>
            <span className="truncate text-xs text-muted-foreground">
              {row.userName} · {formatDay(row.startedAt.slice(0, 10))}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="secondary">{row.itemType}</Badge>
            <span className="text-muted-foreground">{formatDuration(row.watchMs)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
