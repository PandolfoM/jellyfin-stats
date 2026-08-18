import type { HistoryResponse } from "../../api/queries";
import { formatCount, formatDay, formatDuration } from "../../lib/format";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { EmptyState } from "./EmptyState";

// There is no standalone `HistoryRow` export from queries.ts — the history
// endpoint's response is `{ rows, total }` — so this is derived from the one
// exported response type rather than re-declared by hand, the same way
// `ActivityFeed`'s `ActivityRow` is. See the note at the top of queries.ts
// for why a hand-written parallel shape is this repo's most expensive
// recurring defect class.
export type PlaybackHistoryRow = HistoryResponse["rows"][number];

export interface PlaybackHistoryTableProps {
  rows: PlaybackHistoryRow[];
  /**
   * Count across the *whole* filtered set, not just this page — the API
   * returns it alongside the page precisely so the "showing X–Y of total"
   * line below needs no second request (see `historyQuery`'s callers).
   */
  total: number;
  /** 1-indexed. */
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  loading: boolean;
}

const SKELETON_ROW_COUNT = 8;

/**
 * Paginated playback-history table. Props only — no fetching, no filter
 * state, no knowledge of what range/userId/libraryId filters produced
 * `rows` or what page `page`/`pageSize` refer to — so `/history` (this
 * task) and, per Task 10, the user- and library-detail routes can each own
 * their own query and hand this component whatever page of `rows`/`total`
 * it resolved to. Pagination itself is fully controlled: this component
 * never tracks a page number of its own, only calls `onPageChange` with the
 * page the caller should switch to.
 *
 * Deleted media is not a special case here. The API substitutes
 * "Unknown item" / "Unknown user" placeholder strings for a session whose
 * item or user row no longer exists (see `packages/db/src/repositories/history.ts`,
 * which falls back with `??` rather than omitting the row) instead of
 * dropping the row. `row.itemName`/`row.userName` are therefore always
 * plain strings, and this component renders them exactly like any other
 * row — no `=== null` branch, no warning icon, nothing that would make a
 * placeholder row look like an error.
 */
export function PlaybackHistoryTable({
  rows,
  total,
  page,
  pageSize,
  onPageChange,
  loading,
}: PlaybackHistoryTableProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading playback history">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return <EmptyState title="No playback history" description="No sessions match the selected filters." />;
  }

  // `total` is the count across the whole filtered set, not just this page
  // (see the prop doc comment above). The upper bound is `total` itself on
  // the last page, not `page * pageSize`: whenever `total` isn't an exact
  // multiple of `pageSize`, the last page holds fewer than `pageSize` rows,
  // and `page * pageSize` would overshoot the real total — "showing
  // 801–850 of 812" instead of the correct "801–812 of 812".
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const hasPrevious = page > 1;
  const hasNext = end < total;

  return (
    <div className="flex flex-col gap-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Started</TableHead>
            <TableHead>Item</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Device</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead>Completed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} data-testid="playback-history-row" data-row-id={row.id}>
              <TableCell className="text-muted-foreground">{formatDay(row.startedAt.slice(0, 10))}</TableCell>
              <TableCell className="max-w-64 truncate font-medium text-foreground">{row.itemName}</TableCell>
              <TableCell>
                <Badge variant="secondary">{row.itemType}</Badge>
              </TableCell>
              <TableCell>{row.userName}</TableCell>
              <TableCell className="text-muted-foreground">{row.deviceName ?? row.client ?? "—"}</TableCell>
              <TableCell className="text-right">{formatDuration(row.watchMs)}</TableCell>
              <TableCell>{row.completed ? "Yes" : "No"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-muted-foreground">
        <span data-testid="playback-history-summary">
          Showing {formatCount(start)}–{formatCount(end)} of {formatCount(total)}
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasPrevious}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!hasNext} onClick={() => onPageChange(page + 1)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
