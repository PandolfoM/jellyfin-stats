import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";

import { ApiError } from "../api/client";
import { historyQuery, topItemsQuery, userDetailQuery } from "../api/queries";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { DateRangePicker } from "../components/domain/DateRangePicker";
import { DeviceBreakdown } from "../components/domain/DeviceBreakdown";
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
 * A single user's detail page. A container, like every other route file
 * here: it owns the `userId` route param, the range, the playback-history
 * page number, and the three queries this page needs, and hands plain
 * resolved data down to `StatCardRow`, `TopContentList`, and
 * `PlaybackHistoryTable` — the same three props-only components the
 * overview and history routes already use. None of the three needed to
 * learn "which page is this" to work here:
 *
 *   - `TopContentList` and `PlaybackHistoryTable` were already fully
 *     generic — this route just threads `userId` into `topItemsQuery`'s and
 *     `historyQuery`'s existing filter options, which both already support.
 *   - `StatCardRow` needed its `stats` prop relaxed from `OverviewResponse`
 *     to `Partial<OverviewResponse>` (see that file's doc comment) because
 *     `getUserDetail` has no equivalent of "active users"/"active items"
 *     for a single user. That is a new capability on an existing prop, not
 *     a "which page am I on" branch.
 *
 * `userId` is read through this route's own `useParams()` — driven by the
 * router's `/users/$userId` path match, not hardcoded — so a real
 * navigation (not just a component call with a hand-picked id) exercises
 * the same param-parsing path a real user's browser would.
 *
 * 404 handling: `/api/stats/users/:userId` answers 404 for an id that does
 * not exist (apps/server/src/api/routes/stats.ts), which `unwrap` turns
 * into an `ApiError` with `status === 404` on `userDetailQuery`'s query
 * error. That is distinct from — and must render differently than — a real
 * user who simply has no activity in the selected range: the zero-activity
 * case still resolves successfully with real zeroed data (getUserDetail's
 * `LEFT JOIN` guarantees a row for any id that exists), so `detail.isError`
 * is false and the normal panels render with zeros. Only an actual 404
 * takes the early "not found" branch below.
 *
 * A 401 is not handled here, for the same ordering reason it isn't in any
 * other route container — see `routes/index.tsx`'s doc comment.
 */
function UserDetailRoute() {
  const { userId } = userDetailRoute.useParams();
  const [range, setRangeState] = useState(() => defaultRange());
  const [page, setPage] = useState(1);

  function setRange(next: DateRange) {
    setRangeState(next);
    setPage(1);
  }

  const detail = useQuery(userDetailQuery(userId, range));
  const topItems = useQuery(topItemsQuery(range, { userId, limit: TOP_ITEMS_LIMIT }));
  const history = useQuery(
    historyQuery({
      from: range.from,
      to: range.to,
      userId,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
  );

  const notFound = detail.error instanceof ApiError && detail.error.status === 404;

  if (notFound) {
    return (
      <div data-testid="user-detail-not-found" className="flex flex-col gap-6">
        <EmptyState title="User not found" description="This user does not exist, or was removed from Jellyfin." />
      </div>
    );
  }

  return (
    <div data-testid="user-detail-route" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-foreground">{detail.data?.name ?? "User"}</h1>
          {detail.data?.isAdmin === true && <Badge variant="secondary">Admin</Badge>}
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {detail.isError ? (
        <PanelError testId="user-detail-error" />
      ) : (
        <StatCardRow
          stats={{ plays: detail.data?.plays ?? 0, watchMs: detail.data?.watchMs ?? 0 }}
          loading={detail.isLoading}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top content</CardTitle>
          </CardHeader>
          <CardContent>
            {topItems.isError ? (
              <PanelError testId="user-top-items-error" />
            ) : (
              <TopContentList
                items={topItems.data ?? []}
                loading={topItems.isLoading}
                emptyMessage="No plays for this user in this range"
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Devices</CardTitle>
          </CardHeader>
          <CardContent>
            {detail.isError ? (
              <PanelError testId="user-devices-error" />
            ) : (
              <DeviceBreakdown devices={detail.data?.devices ?? []} loading={detail.isLoading} />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Playback history</CardTitle>
        </CardHeader>
        <CardContent>
          {history.isError ? (
            <PanelError testId="user-history-error" />
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

export const userDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/users/$userId",
  component: UserDetailRoute,
});
