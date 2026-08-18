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
import { PanelError } from "./PanelError";
import { rootRoute } from "./__root";

// How many rows the overview's compact activity feed and top-content table
// show. Smaller than the full history/library screens' page sizes on
// purpose — this is a glance-at-the-dashboard summary, not a paginated view.
const TOP_ITEMS_LIMIT = 5;
const RECENT_ACTIVITY_LIMIT = 8;

/**
 * The dashboard landing screen. A container: it owns the four queries this
 * page needs and the range state that drives all of them, and passes plain
 * resolved data down to props-only domain components — no formatting beyond
 * deciding, per panel, whether to render that panel's error state (its
 * loading state is already owned by the domain component itself via
 * `loading`).
 *
 * Errors are handled per panel, not for the whole route: a 500 on one query
 * (say, `/api/history`) must not blank the stat cards, chart, and
 * top-content list that loaded fine — those three already have real data to
 * show. Each of the four sections below checks only its own query's
 * `isError`, independently of the other three.
 *
 * A 401 from any of the four queries is deliberately *not* handled here.
 * `unwrap` (api/client.ts) calls the shared `notifyUnauthorized()` listener
 * synchronously, immediately before it throws, for every 401 it sees;
 * `SessionProvider` (auth/session.tsx) is the one subscriber, and flips the
 * session to "anonymous" the moment that fires. That ordering is *why* a
 * panel error that survives long enough to actually render here is never a
 * 401 — by the time a 401 would reach this component as a query error, the
 * session has already flipped and `routes/__root.tsx`'s gate is already
 * redirecting away (a rendering-order guarantee, not a status-code check
 * performed in this file). Handling 401 per-route instead would mean
 * repeating the same `error.status === 401` check in this route and the
 * four that follow it; centralizing it once in the session layer means none
 * of them have to.
 */
function Overview() {
  const [range, setRange] = useState(() => defaultRange());

  const overview = useQuery(overviewQuery(range));
  const series = useQuery(seriesQuery(range));
  const topItems = useQuery(topItemsQuery(range, { limit: TOP_ITEMS_LIMIT }));
  const history = useQuery(
    historyQuery({ from: range.from, to: range.to, limit: RECENT_ACTIVITY_LIMIT }),
  );

  return (
    <div data-testid="overview-route" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-foreground">Overview</h1>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {overview.isError ? (
        <PanelError testId="overview-error" />
      ) : (
        <StatCardRow stats={overview.data ?? null} loading={overview.isLoading} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Watch time</CardTitle>
        </CardHeader>
        <CardContent>
          {series.isError ? (
            <PanelError testId="series-error" />
          ) : (
            <WatchTimeChart points={series.data ?? []} loading={series.isLoading} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top content</CardTitle>
          </CardHeader>
          <CardContent>
            {topItems.isError ? (
              <PanelError testId="top-items-error" />
            ) : (
              <TopContentList items={topItems.data ?? []} loading={topItems.isLoading} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            {history.isError ? (
              <PanelError testId="history-error" />
            ) : (
              <ActivityFeed rows={history.data?.rows ?? []} loading={history.isLoading} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Overview,
});
