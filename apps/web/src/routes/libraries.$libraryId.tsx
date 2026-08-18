import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";

import { historyQuery, libraryStatsQuery, topItemsQuery } from "../api/queries";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { DateRangePicker } from "../components/domain/DateRangePicker";
import { EmptyState } from "../components/domain/EmptyState";
import { PlaybackHistoryTable } from "../components/domain/PlaybackHistoryTable";
import { StatCardRow } from "../components/domain/StatCardRow";
import { TopContentList } from "../components/domain/TopContentList";
import { defaultRange, type DateRange } from "../lib/range";
import { PanelError } from "./PanelError";
import { rootRoute } from "./__root";

const PAGE_SIZE = 25;
const TOP_ITEMS_LIMIT = 5;

/**
 * A single library's detail page. A container, structured like
 * `routes/users.$userId.tsx`, with one real difference driven by the
 * server's actual routes (checked against `apps/server/src/api/routes/stats.ts`
 * before writing this, per this task's brief): there is no
 * `/api/stats/libraries/:libraryId` endpoint — only `/api/stats/users/:userId`
 * gets a dedicated per-id route. `queries.ts` has no `libraryDetailQuery` to
 * match, only `libraryStatsQuery` (the full roster).
 *
 * So this page finds its one library inside that full roster instead of
 * fetching it directly. `getLibraryStats`'s `LEFT JOIN` starts from
 * `libraries`, not the rollup (packages/db/src/repositories/stats.ts), so a
 * library with zero activity in the selected range is still present in the
 * roster with zeroed plays/watchMs and is found exactly the same way an
 * active one is — this route's "not found" state is reserved for a
 * `libraryId` genuinely absent from (or archived out of) that list, not for
 * a real, quiet library.
 *
 * `TopContentList` and `PlaybackHistoryTable` are reused unchanged, the
 * same as on the user-detail route — this route just threads `libraryId`
 * into their existing `topItemsQuery`/`historyQuery` filter options.
 * `StatCardRow` again takes only `plays`/`watchMs` (see its doc comment):
 * `LibraryStat` has no per-library "active users"/"active items" either.
 *
 * `libraryId` is read through this route's own `useParams()`, driven by the
 * router's `/libraries/$libraryId` path match rather than hardcoded.
 *
 * A 401 is not handled here, for the same ordering reason it isn't in any
 * other route container — see `routes/index.tsx`'s doc comment.
 */
function LibraryDetailRoute() {
  const { libraryId } = libraryDetailRoute.useParams();
  const [range, setRangeState] = useState(() => defaultRange());
  const [page, setPage] = useState(1);

  function setRange(next: DateRange) {
    setRangeState(next);
    setPage(1);
  }

  const libraries = useQuery(libraryStatsQuery(range));
  const library = libraries.data?.find((entry) => entry.libraryId === libraryId);
  const notFound = libraries.isSuccess && library === undefined;

  const topItems = useQuery(topItemsQuery(range, { libraryId, limit: TOP_ITEMS_LIMIT }));
  const history = useQuery(
    historyQuery({
      from: range.from,
      to: range.to,
      libraryId,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
  );

  if (notFound) {
    return (
      <div data-testid="library-detail-not-found" className="flex flex-col gap-6">
        <EmptyState
          title="Library not found"
          description="This library does not exist, or was removed from Jellyfin."
        />
      </div>
    );
  }

  return (
    <div data-testid="library-detail-route" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-foreground">{library?.name ?? "Library"}</h1>
          {library?.collectionType !== undefined && library.collectionType !== null && (
            <Badge variant="secondary">{library.collectionType}</Badge>
          )}
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {libraries.isError ? (
        <PanelError testId="library-detail-error" />
      ) : (
        <StatCardRow
          stats={{ plays: library?.plays ?? 0, watchMs: library?.watchMs ?? 0 }}
          loading={libraries.isLoading}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Top content</CardTitle>
        </CardHeader>
        <CardContent>
          {topItems.isError ? (
            <PanelError testId="library-top-items-error" />
          ) : (
            <TopContentList
              items={topItems.data ?? []}
              loading={topItems.isLoading}
              emptyMessage="No plays for this library in this range"
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Playback history</CardTitle>
        </CardHeader>
        <CardContent>
          {history.isError ? (
            <PanelError testId="library-history-error" />
          ) : (
            <PlaybackHistoryTable
              rows={history.data?.rows ?? []}
              total={history.data?.total ?? 0}
              page={page}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
              loading={history.isLoading}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export const libraryDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/libraries/$libraryId",
  component: LibraryDetailRoute,
});
