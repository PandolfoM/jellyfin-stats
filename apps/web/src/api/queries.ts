import { queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";

import type { DateRange } from "../lib/range";
import { api, unwrap } from "./client";

// Response shapes are derived from `api` (and therefore from `AppType`,
// therefore from the server's actual handlers) rather than re-declared here —
// see the note at the top of client.ts. If a server route's response shape
// changes, these types change with it instead of silently drifting.
type OverviewResponse = InferResponseType<typeof api.api.stats.overview.$get>;
type SeriesResponse = InferResponseType<typeof api.api.stats.series.$get>;
type TopItemsResponse = InferResponseType<(typeof api.api.stats)["top-items"]["$get"]>;
type UserStatsResponse = InferResponseType<typeof api.api.stats.users.$get>;
type UserDetailResponse = InferResponseType<(typeof api.api.stats.users)[":userId"]["$get"]>;
type LibraryStatsResponse = InferResponseType<typeof api.api.stats.libraries.$get>;
type HistoryResponse = InferResponseType<typeof api.api.history.$get>;

export interface TopItemsOptions {
  limit?: number;
  libraryId?: string;
  userId?: string;
}

export interface HistoryQueryOptions {
  /** Inclusive `YYYY-MM-DD`. Omitting both defaults to the server's own 30-day window. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  userId?: string;
  libraryId?: string;
}

/**
 * `overview`/`series`/`users`/`libraries` take only a range, but `top-items`
 * and `history` fold their extra filters into the same `[group, name, ...]`
 * key shape — every branch below still starts with a literal tuple prefix
 * that no other factory shares, so no two factories can collide no matter
 * what they append after it.
 */
const queryKeys = {
  overview: (range: DateRange) => ["stats", "overview", range] as const,
  series: (range: DateRange) => ["stats", "series", range] as const,
  topItems: (range: DateRange, opts: TopItemsOptions) => ["stats", "top-items", range, opts] as const,
  users: (range: DateRange) => ["stats", "users", range] as const,
  userDetail: (userId: string, range: DateRange) => ["stats", "users", userId, range] as const,
  libraries: (range: DateRange) => ["stats", "libraries", range] as const,
  history: (opts: HistoryQueryOptions) => ["history", opts] as const,
};

export function overviewQuery(range: DateRange) {
  return queryOptions({
    queryKey: queryKeys.overview(range),
    queryFn: async () => unwrap<OverviewResponse>(await api.api.stats.overview.$get({ query: range })),
  });
}

export function seriesQuery(range: DateRange) {
  return queryOptions({
    queryKey: queryKeys.series(range),
    queryFn: async () => unwrap<SeriesResponse>(await api.api.stats.series.$get({ query: range })),
  });
}

export function topItemsQuery(range: DateRange, opts: TopItemsOptions) {
  return queryOptions({
    queryKey: queryKeys.topItems(range, opts),
    queryFn: async () =>
      unwrap<TopItemsResponse>(
        await api.api.stats["top-items"].$get({
          query: {
            from: range.from,
            to: range.to,
            limit: opts.limit !== undefined ? String(opts.limit) : undefined,
            libraryId: opts.libraryId,
            userId: opts.userId,
          },
        }),
      ),
  });
}

export function userStatsQuery(range: DateRange) {
  return queryOptions({
    queryKey: queryKeys.users(range),
    queryFn: async () => unwrap<UserStatsResponse>(await api.api.stats.users.$get({ query: range })),
  });
}

// `/api/stats/users/:userId` has no query-string validator on the server (see
// stats.ts), so the RPC client only infers `{ param: { userId } }` as its
// input — unlike the range-only routes above, whose entirely-empty inferred
// input happens to accept an extra `query` object without a type error.
// Widening the declared param-only type with an intersection (rather than
// `as`/`any`) keeps this derived from the real route type instead of
// hand-declaring a shape that could drift from it.
type UserDetailArgs = Parameters<(typeof api.api.stats.users)[":userId"]["$get"]>[0] & {
  query: DateRange;
};

export function userDetailQuery(userId: string, range: DateRange) {
  return queryOptions({
    queryKey: queryKeys.userDetail(userId, range),
    queryFn: async () => {
      const args: UserDetailArgs = { param: { userId }, query: range };
      return unwrap<UserDetailResponse>(await api.api.stats.users[":userId"].$get(args));
    },
  });
}

export function libraryStatsQuery(range: DateRange) {
  return queryOptions({
    queryKey: queryKeys.libraries(range),
    queryFn: async () => unwrap<LibraryStatsResponse>(await api.api.stats.libraries.$get({ query: range })),
  });
}

export function historyQuery(opts: HistoryQueryOptions) {
  return queryOptions({
    queryKey: queryKeys.history(opts),
    queryFn: async () =>
      unwrap<HistoryResponse>(
        await api.api.history.$get({
          query: {
            from: opts.from,
            to: opts.to,
            limit: opts.limit !== undefined ? String(opts.limit) : undefined,
            offset: opts.offset !== undefined ? String(opts.offset) : undefined,
            userId: opts.userId,
            libraryId: opts.libraryId,
          },
        }),
      ),
  });
}
