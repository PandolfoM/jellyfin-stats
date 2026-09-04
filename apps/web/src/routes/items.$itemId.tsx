import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { ApiError } from "../api/client";
import { historyQuery, itemDetailQuery, settingsQuery } from "../api/queries";
import type { ItemDetailResponse } from "../api/queries";
import { DateRangePicker } from "../components/domain/DateRangePicker";
import { EmptyState } from "../components/domain/EmptyState";
import { PlaybackHistoryTable } from "../components/domain/PlaybackHistoryTable";
import { PosterImage } from "../components/domain/PosterImage";
import { StatCard } from "../components/domain/StatCard";
import { Badge } from "../components/ui/badge";
import { buttonVariants } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import {
  formatCount,
  formatDuration,
  formatEpisodeLabel,
  formatFullDate,
  ticksToMs,
} from "../lib/format";
import { defaultRange, type DateRange } from "../lib/range";
import { PanelError } from "./PanelError";
import { rootRoute } from "./__root";

const PAGE_SIZE = 25;

/**
 * Builds the deep link into Jellyfin's own web UI for an item. Tolerates a
 * trailing slash on the configured server URL so the operator's Settings
 * value works either way.
 */
function jellyfinItemUrl(jellyfinUrl: string, itemId: string): string {
  return `${jellyfinUrl.replace(/\/+$/, "")}/web/#/details?id=${encodeURIComponent(itemId)}`;
}

interface DetailRowProps {
  label: string;
  children: React.ReactNode;
}

function DetailRow({ label, children }: DetailRowProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

/**
 * The descriptive block: what the item *is*, as opposed to how it has been
 * played. Half of it comes from the reference table (year, runtime,
 * library) and half from a live Jellyfin lookup (`metadata`: release date,
 * synopsis, genres, ratings, studio). When Jellyfin could not be reached the
 * API sends `metadata: null` and this renders the database half alone, with
 * a note — the page must not blank out because Jellyfin is restarting.
 */
function ItemDetails({ item }: { item: ItemDetailResponse }) {
  const { metadata } = item;
  const releaseDate =
    metadata?.premiereDate !== null && metadata?.premiereDate !== undefined
      ? formatFullDate(metadata.premiereDate)
      : item.productionYear !== null
        ? String(item.productionYear)
        : null;

  return (
    <div className="flex flex-col gap-4">
      {metadata === null && (
        <p
          data-testid="item-metadata-unavailable"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
        >
          Details from Jellyfin are unavailable right now. Showing what has been synced.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
        {releaseDate !== null && <DetailRow label="Release date">{releaseDate}</DetailRow>}
        {item.runtimeTicks !== null && (
          <DetailRow label="Runtime">{formatDuration(ticksToMs(item.runtimeTicks))}</DetailRow>
        )}
        {metadata !== null && metadata.genres.length > 0 && (
          <DetailRow label="Genres">{metadata.genres.join(", ")}</DetailRow>
        )}
        {metadata?.officialRating != null && (
          <DetailRow label="Content rating">{metadata.officialRating}</DetailRow>
        )}
        {metadata?.communityRating != null && (
          <DetailRow label="Community rating">{metadata.communityRating.toFixed(1)} / 10</DetailRow>
        )}
        {metadata !== null && metadata.studios.length > 0 && (
          <DetailRow label={metadata.studios.length === 1 ? "Studio" : "Studios"}>
            {metadata.studios.join(", ")}
          </DetailRow>
        )}
        {item.libraryName !== null && (
          <DetailRow label="Library">
            {item.libraryId !== null ? (
              <Link
                to="/libraries/$libraryId"
                params={{ libraryId: item.libraryId }}
                className="hover:underline focus-visible:underline"
              >
                {item.libraryName}
              </Link>
            ) : (
              item.libraryName
            )}
          </DetailRow>
        )}
      </dl>

      {metadata?.overview != null && metadata.overview !== "" && (
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {metadata.overview}
        </p>
      )}
    </div>
  );
}

/**
 * A single item's detail page — reached from every place an item name
 * appears (top content, recent activity, playback history, live streams).
 * A container, like every other route file here: it owns the `itemId`
 * route param, the range, the history page number, and three queries, and
 * hands resolved data to props-only components.
 *
 * 404 handling mirrors `users.$userId.tsx`: `/api/items/:itemId` answers
 * 404 only when neither the database nor Jellyfin knows the id, which
 * `unwrap` turns into an `ApiError` with `status === 404`. An item with no
 * plays in the range resolves successfully with zeroed stats and renders the
 * normal page.
 */
function ItemDetailRoute() {
  const { itemId } = itemDetailRoute.useParams();
  const [range, setRangeState] = useState(() => defaultRange());
  const [page, setPage] = useState(1);

  function setRange(next: DateRange) {
    setRangeState(next);
    setPage(1);
  }

  const detail = useQuery(itemDetailQuery(itemId, range));
  const settings = useQuery(settingsQuery());
  const history = useQuery(
    historyQuery({
      from: range.from,
      to: range.to,
      itemId,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
  );

  const notFound = detail.error instanceof ApiError && detail.error.status === 404;

  if (notFound) {
    return (
      <div data-testid="item-detail-not-found" className="flex flex-col gap-6">
        <EmptyState
          title="Item not found"
          description="This item does not exist, or was removed from Jellyfin."
        />
      </div>
    );
  }

  const item = detail.data;
  const episodeLabel = item !== undefined ? formatEpisodeLabel(item) : null;

  return (
    <div data-testid="item-detail-route" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 gap-4">
          {item !== undefined ? (
            <PosterImage
              itemId={item.itemId}
              tag={item.imageTag}
              alt={`Poster for ${item.name}`}
              className="h-36 w-24 shrink-0 sm:h-48 sm:w-32"
            />
          ) : (
            <Skeleton className="h-36 w-24 shrink-0 sm:h-48 sm:w-32" />
          )}
          <div className="flex min-w-0 flex-col gap-2">
            {episodeLabel !== null && (
              <span className="text-sm text-muted-foreground">{episodeLabel}</span>
            )}
            {item !== undefined ? (
              <h1 className="text-xl font-semibold text-foreground">{item.name}</h1>
            ) : (
              <Skeleton className="h-7 w-48" />
            )}
            <div className="flex flex-wrap items-center gap-2">
              {item !== undefined && <Badge variant="secondary">{item.type}</Badge>}
              {item !== undefined && settings.data !== undefined && (
                <a
                  href={jellyfinItemUrl(settings.data.jellyfinUrl, item.itemId)}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Open in Jellyfin
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                </a>
              )}
            </div>
          </div>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {detail.isError ? (
        <PanelError testId="item-detail-error" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              {item !== undefined ? (
                <ItemDetails item={item} />
              ) : (
                <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading details">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <StatCard
              label="Plays"
              value={formatCount(item?.plays ?? 0)}
              loading={detail.isLoading}
            />
            <StatCard
              label="Watch time"
              value={formatDuration(item?.watchMs ?? 0)}
              loading={detail.isLoading}
            />
            <StatCard
              label="Unique viewers"
              value={formatCount(item?.uniqueUsers ?? 0)}
              loading={detail.isLoading}
            />
          </div>
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Playback history</CardTitle>
        </CardHeader>
        <CardContent>
          {history.isError ? (
            <PanelError testId="item-history-error" />
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

export const itemDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/items/$itemId",
  component: ItemDetailRoute,
});
