import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";

import { historyQuery, libraryStatsQuery, userStatsQuery } from "../api/queries";
import { DateRangePicker } from "../components/domain/DateRangePicker";
import { PlaybackHistoryTable } from "../components/domain/PlaybackHistoryTable";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
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

// Radix's Select reserves the empty string: a `SelectItem` may not use it as a
// value, because that is how the primitive represents "nothing selected" and
// clears the field. The unfiltered choice therefore needs a real value, mapped
// back to "" at the boundary so `HistoryFilters` keeps meaning what it always
// meant — empty is no filter. Filter state is deliberately not changed to hold
// this sentinel: `normalizeFilter` below, the query keys, and every existing
// test all treat "" as the unfiltered case.
const ALL_VALUE = "all";

const toFilter = (value: string) => (value === ALL_VALUE ? "" : value);
const toSelectValue = (filter: string) => (filter === "" ? ALL_VALUE : filter);

/**
 * Empty string (a select's "All users"/"All libraries" option, and the
 * untouched state) means "no filter" — trimmed and converted to `undefined`
 * before it reaches `historyQuery`, so an empty value can't smuggle a bogus
 * `userId=`/`libraryId=` into the request or the query key.
 */
function normalizeFilter(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The paginated playback-history screen. A container, like `routes/index.tsx`:
 * it owns the queries this route needs and all of the state that feeds
 * them — the date range, the user/library filters, and the current page —
 * and passes plain resolved data down to `PlaybackHistoryTable`, a
 * props-only domain component that also has no idea any of this state
 * exists.
 *
 * The user/library filters are name-backed `<Select>`s, not raw-GUID text
 * inputs — no operator recognizes a Jellyfin GUID by sight, so a free-text
 * field was unusable in practice. `userStatsQuery`/`libraryStatsQuery`
 * (already fetched by the users/libraries list routes, Task 10) supply the
 * id→name pairs these selects list; `getUserStats`/`getLibraryStats`
 * (packages/db/src/repositories/stats.ts) `LEFT JOIN` from the reference
 * tables, so every non-archived user/library is always a selectable option
 * regardless of range — a user or library with zero plays in the current
 * range never disappears from its own filter dropdown. Loading these two
 * lists is independent of the main `history` query; a slow or failed name
 * fetch degrades to "All users"/"All libraries" being the only option
 * rather than blocking the page (see the `disabled` prop on each select).
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
  const users = useQuery(userStatsQuery(range));
  const libraries = useQuery(libraryStatsQuery(range));

  return (
    <div data-testid="history-route" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-foreground">History</h1>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {/* Not `<label>` wrapping the control any more. Radix renders the
            trigger as a `<button>`, which a label cannot be associated with
            the way it can with a native `<select>` — so the visible text is a
            `<span>` and the trigger points at it with `aria-labelledby`. The
            ids are page-unique rather than component-generated because this
            route renders exactly one of each. */}
        <div className="flex flex-col gap-1.5">
          <span id="history-user-label" className="text-sm text-muted-foreground">
            User
          </span>
          <Select
            value={toSelectValue(filters.userId)}
            disabled={users.isLoading}
            onValueChange={(value) => setFilters({ ...filters, userId: toFilter(value) })}
          >
            <SelectTrigger className="w-56" aria-labelledby="history-user-label">
              <SelectValue placeholder="All users" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_VALUE}>All users</SelectItem>
              {(users.data ?? []).map((user) => (
                <SelectItem key={user.userId} value={user.userId}>
                  {user.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <span id="history-library-label" className="text-sm text-muted-foreground">
            Library
          </span>
          <Select
            value={toSelectValue(filters.libraryId)}
            disabled={libraries.isLoading}
            onValueChange={(value) => setFilters({ ...filters, libraryId: toFilter(value) })}
          >
            <SelectTrigger className="w-56" aria-labelledby="history-library-label">
              <SelectValue placeholder="All libraries" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_VALUE}>All libraries</SelectItem>
              {(libraries.data ?? []).map((library) => (
                <SelectItem key={library.libraryId} value={library.libraryId}>
                  {library.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
