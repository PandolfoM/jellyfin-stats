import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";

import { historyQuery, overviewQuery, seriesQuery, topItemsQuery } from "../api/queries";
import { ActivityFeed } from "../components/domain/ActivityFeed";
import { DateRangePicker } from "../components/domain/DateRangePicker";
import { StatCardRow } from "../components/domain/StatCardRow";
import { TopContentList } from "../components/domain/TopContentList";
import { WatchTimeChart } from "../components/domain/WatchTimeChart";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { defaultRange } from "../lib/range";
import { rootRoute } from "./__root";

// How many rows the overview's compact activity feed and top-content table
// show. Smaller than the full history/library screens' page sizes on
// purpose — this is a glance-at-the-dashboard summary, not a paginated view.
const TOP_ITEMS_LIMIT = 5;
const RECENT_ACTIVITY_LIMIT = 8;

/**
 * The dashboard landing screen. A container: it owns the four queries this
 * page needs and the range state that drives all of them, and passes plain
 * resolved data down to props-only domain components — no formatting, no
 * empty/loading branching beyond picking which component to render, lives
 * here.
 *
 * A 401 from any of the four queries is deliberately *not* handled here.
 * `unwrap` (api/client.ts) notifies a shared listener on every 401 it sees,
 * and `SessionProvider` (auth/session.tsx) is the one subscriber — it flips
 * to "anonymous", and the protected-route gate in `routes/__root.tsx`
 * redirects to `/login` on its own. Handling it per-route would mean
 * repeating the same `error.status === 401` check in this route and the four
 * that follow it; centralizing it once in the session layer means none of
 * them have to.
 */
function Overview() {
  const [range, setRange] = useState(() => defaultRange());

  const overview = useQuery(overviewQuery(range));
  const series = useQuery(seriesQuery(range));
  const topItems = useQuery(topItemsQuery(range, { limit: TOP_ITEMS_LIMIT }));
  const history = useQuery(
    historyQuery({ from: range.from, to: range.to, limit: RECENT_ACTIVITY_LIMIT }),
  );

  // Any error still active here is, by construction, not a 401 — a 401
  // already redirected the whole app to /login before this could render an
  // error card for it (see the note above). What's left is a genuine server
  // fault (500, network failure, etc.), which the previous task's
  // SessionErrorState pattern this mirrors treats as "something is actually
  // broken," not "log in again."
  const hasError = [overview, series, topItems, history].some((query) => query.isError);

  return (
    <div data-testid="overview-route" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-foreground">Overview</h1>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {hasError ? (
        <div
          role="alert"
          data-testid="overview-error"
          className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive"
        >
          Could not load dashboard data. Try again.
        </div>
      ) : (
        <>
          <StatCardRow stats={overview.data ?? null} loading={overview.isLoading} />

          <Card>
            <CardHeader>
              <CardTitle>Watch time</CardTitle>
            </CardHeader>
            <CardContent>
              <WatchTimeChart points={series.data ?? []} loading={series.isLoading} />
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Top content</CardTitle>
              </CardHeader>
              <CardContent>
                <TopContentList items={topItems.data ?? []} loading={topItems.isLoading} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent activity</CardTitle>
              </CardHeader>
              <CardContent>
                <ActivityFeed rows={history.data?.rows ?? []} loading={history.isLoading} />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Overview,
});
