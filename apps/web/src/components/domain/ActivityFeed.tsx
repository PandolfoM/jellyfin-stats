import type { HistoryResponse } from "../../api/queries";
import { formatDateTime, formatDuration, formatEpisodeLabel } from "../../lib/format";
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
 * `row.startedAt` arrives as a full ISO timestamp (JSON has no `Date` type)
 * and is rendered whole, date and time, by `formatDateTime` — in the reader's
 * local timezone, since the only useful answer to "when did this play" is a
 * wall-clock one. See that function for why it is the mirror image of
 * `formatDay`, which must *not* convert.
 *
 * An episode's series and S/E numbering join the muted meta line rather than
 * getting a line of their own the way `PlaybackHistoryTable` gives them one.
 * This is a compact feed in a dashboard card, and a third line per row would
 * cost more than it returns; the series leads that line so it survives the
 * truncation the long ones get.
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
        <li key={row.id} className="grid grid-cols-3 gap-3 text-sm">
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-foreground">{row.itemName}</span>
            <span className="truncate text-xs text-muted-foreground">
              {[formatEpisodeLabel(row), formatDateTime(row.startedAt)]
                .filter((part) => part !== null)
                .join(" · ")}
            </span>
          </div>
          <div className="flex items-center gap-2 justify-self-center">
            <span className="text-muted-foreground">{row.userName}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2 justify-self-end">
            <Badge variant="secondary">{row.itemType}</Badge>
            <span className="text-muted-foreground">{formatDuration(row.watchMs)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
