import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState, type ChangeEvent } from "react";

import { historyQuery } from "../api/queries";
import { DateRangePicker } from "../components/domain/DateRangePicker";
import { PlaybackHistoryTable } from "../components/domain/PlaybackHistoryTable";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { defaultRange, type DateRange } from "../lib/range";
import { PanelError } from "./PanelError";
import { rootRoute } from "./__root";

// How many rows one page of history holds. Passed to `historyQuery` as
// `limit`, and to `PlaybackHistoryTable` as `pageSize` so its "showing X–Y
// of total" line can compute the right bounds without a second request.
const PAGE_SIZE = 50;

interface HistoryFilters {
  userId: string;
  libraryId: string;
}

const EMPTY_FILTERS: HistoryFilters = { userId: "", libraryId: "" };

const filterFieldClassName =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * Empty string (the input's untouched state) means "no filter" — trimmed
 * and converted to `undefined` before it reaches `historyQuery`, so an
 * empty or all-whitespace field can't smuggle a bogus `userId=`/`libraryId=`
 * into the request or the query key.
 */
function normalizeFilter(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The paginated playback-history screen. A container, like `routes/index.tsx`:
 * it owns the one query this route needs and all of the state that feeds
 * it — the date range, the user/library filters, and the current page —
 * and passes plain resolved data down to `PlaybackHistoryTable`, a
 * props-only domain component that also has no idea any of this state
 * exists.
 *
 * Every filter or range change resets `page` back to 1. Without that, e.g.
 * narrowing the range while sitting on page 5 could ask for an offset past
 * the end of the new, smaller filtered set — the API would still answer
 * with 200 and an empty `rows` array (the offset is simply clamped away
 * from any matching row), which would render as an empty page even though
 * matching history exists on an earlier one.
 *
 * A 401 is not handled here for the same reason `routes/index.tsx` doesn't
 * handle it either — see that file's doc comment. `unwrap` fires the shared
 * `notifyUnauthorized()` listener before a 401 ever reaches this component
 * as a query error, so the session has already flipped to "anonymous" and
 * `routes/__root.tsx`'s gate is already redirecting away by the time one
 * would show up here.
 */
function HistoryRoute() {
  const [range, setRangeState] = useState(() => defaultRange());
  const [filters, setFiltersState] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

  function setRange(next: DateRange) {
    setRangeState(next);
    setPage(1);
  }

  function setFilters(next: HistoryFilters) {
    setFiltersState(next);
    setPage(1);
  }

  const history = useQuery(
    historyQuery({
      from: range.from,
      to: range.to,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      userId: normalizeFilter(filters.userId),
      libraryId: normalizeFilter(filters.libraryId),
    }),
  );

  return (
    <div data-testid="history-route" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-foreground">History</h1>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          User ID
          <input
            type="text"
            placeholder="All users"
            value={filters.userId}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setFilters({ ...filters, userId: event.target.value })
            }
            className={filterFieldClassName}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          Library ID
          <input
            type="text"
            placeholder="All libraries"
            value={filters.libraryId}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setFilters({ ...filters, libraryId: event.target.value })
            }
            className={filterFieldClassName}
          />
        </label>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Playback history</CardTitle>
        </CardHeader>
        <CardContent>
          {history.isError ? (
            <PanelError testId="history-error" />
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

export const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  component: HistoryRoute,
});
