import { Link } from "@tanstack/react-router";

import type { LibraryStatsResponse } from "../../api/queries";
import { formatCount, formatDuration } from "../../lib/format";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { EmptyState } from "./EmptyState";

export interface LibraryStatsTableProps {
  libraries: LibraryStatsResponse;
  loading: boolean;
}

const SKELETON_ROW_COUNT = 6;

/**
 * The `/libraries` list: every non-archived Jellyfin library, ranked by
 * watch time. Props only, mirroring `UserStatsTable` exactly.
 *
 * `getLibraryStats` (packages/db/src/repositories/stats.ts) `LEFT JOIN`s
 * from `libraries`, not from the rollup, so a library with no plays in the
 * selected range still appears here with zeros instead of disappearing.
 * This component renders every row it is handed — it must not re-filter
 * what the API deliberately did not filter.
 *
 * Each name links to `/libraries/$libraryId` (this task's other new
 * route).
 */
export function LibraryStatsTable({ libraries, loading }: LibraryStatsTableProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading libraries">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (libraries.length === 0) {
    return <EmptyState title="No libraries" description="No Jellyfin libraries were found." />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead className="text-right">Plays</TableHead>
          <TableHead className="text-right">Watch time</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {libraries.map((library) => (
          <TableRow key={library.libraryId} data-testid="library-stats-row">
            <TableCell className="font-medium text-foreground">
              <Link
                to="/libraries/$libraryId"
                params={{ libraryId: library.libraryId }}
                className="hover:underline focus-visible:underline"
              >
                {library.name}
              </Link>
            </TableCell>
            <TableCell>
              {library.collectionType !== null && (
                <Badge variant="secondary">{library.collectionType}</Badge>
              )}
            </TableCell>
            <TableCell className="text-right">{formatCount(library.plays)}</TableCell>
            <TableCell className="text-right">{formatDuration(library.watchMs)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
