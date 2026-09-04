import { Link } from "@tanstack/react-router";

import type { TopItemsResponse } from "../../api/queries";
import { formatCount, formatDuration } from "../../lib/format";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { EmptyState } from "./EmptyState";
import { PosterImage } from "./PosterImage";

export interface TopContentListProps {
  items: TopItemsResponse;
  loading: boolean;
  emptyMessage?: string;
}

const SKELETON_ROW_COUNT = 5;

/**
 * Ranked list of top-played items — used by the overview route (top items
 * overall) and, filtered through `topItemsQuery`'s options one layer up, the
 * library and user detail routes (top items for that library/user). Props
 * only: this component has no idea which of those callers it's rendered
 * for, only the list it was handed.
 *
 * Each row's poster goes through `PosterImage`, which is what keeps a
 * missing/failed poster from showing a broken-image icon in this list — the
 * exact case the brief calls out.
 */
export function TopContentList({ items, loading, emptyMessage }: TopContentListProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading top content">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return <EmptyState title={emptyMessage ?? "No plays in this range"} />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-14">
            <span className="sr-only">Poster</span>
          </TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Type</TableHead>
          <TableHead className="text-right">Plays</TableHead>
          <TableHead className="text-right">Watch time</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.itemId}>
            <TableCell>
              <PosterImage
                itemId={item.itemId}
                tag={item.imageTag}
                alt={`Poster for ${item.name}`}
                className="h-14 w-10"
              />
            </TableCell>
            <TableCell className="font-medium text-foreground">
              <Link
                to="/items/$itemId"
                params={{ itemId: item.itemId }}
                className="hover:underline focus-visible:underline"
              >
                {item.name}
              </Link>
            </TableCell>
            <TableCell>
              <Badge variant="secondary">{item.type}</Badge>
            </TableCell>
            <TableCell className="text-right">{formatCount(item.plays)}</TableCell>
            <TableCell className="text-right">{formatDuration(item.watchMs)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
