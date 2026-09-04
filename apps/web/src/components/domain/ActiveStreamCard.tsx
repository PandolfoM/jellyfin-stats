import type { LiveSession } from "@jfstats/shared";
import { Link } from "@tanstack/react-router";

import { cn } from "../../lib/cn";
import { formatDuration, ticksToMs } from "../../lib/format";
import { Badge } from "../ui/badge";
import { Card, CardContent } from "../ui/card";
import { PosterImage } from "./PosterImage";
import { UserAvatar } from "./UserAvatar";

export interface ActiveStreamCardProps {
  session: LiveSession;
  variant: "compact" | "full";
}

// Jellyfin reports playback position and runtime in 100-nanosecond ticks —
// 10,000 ticks per millisecond is Jellyfin's own conversion factor (the same
// one apps/server/src/seed.ts uses for runtimeTicks). No shared helper for
// this exists yet; it's a numeric constant, not a type, so defining it
// locally doesn't create the kind of hand-declared-shape drift risk the
// LiveSession type import is meant to avoid.
/**
 * One active playback session, reused at two sizes: `compact` for a glance
 * on the overview route, `full` for the dedicated /live grid. Props only —
 * no fetching, no `useLiveSessions` call, no knowledge of which route
 * rendered it or whether the feed behind it is even still connected. That
 * last part — turning a dropped connection into something visible — is
 * `routes/live.tsx`'s job, layered on top of a grid of these cards via
 * `useLiveSessions`'s `connected` flag, not something this component can or
 * should infer on its own.
 *
 * `LiveSession` (packages/shared/src/session.ts) carries no image tag — the
 * server's `/Sessions` snapshot never has one, only `itemId`/`itemName` — so
 * `PosterImage` is always given `tag={null}` here. That still requests the
 * item's real primary image through our own proxy: a tag is only ever a
 * cache-busting hint to Jellyfin, not a prerequisite, so `PosterImage`
 * requests `/api/images/items/:itemId` with no `tag` query parameter rather
 * than skipping the request outright (see `PosterImage`'s own doc comment).
 * A future task that enriches `LiveSession` with a real image tag (joining
 * against the reference `items` table by `itemId`) would let the *browser's*
 * cache treat a changed poster as a new URL — a nice-to-have, not a
 * prerequisite for showing real art here, which already works today.
 */
export function ActiveStreamCard({ session, variant }: ActiveStreamCardProps) {
  const isCompact = variant === "compact";

  const positionMs = ticksToMs(session.positionTicks);
  const runtimeMs = session.runtimeTicks !== null ? ticksToMs(session.runtimeTicks) : null;
  const percent =
    runtimeMs !== null && runtimeMs > 0
      ? Math.min(100, Math.max(0, (positionMs / runtimeMs) * 100))
      : null;

  return (
    <Card data-testid="active-stream-card">
      <CardContent className={cn("flex gap-3", isCompact ? "items-center p-3" : "flex-col p-4")}>
        <div
          className={cn("flex min-w-0 gap-3", isCompact ? "flex-1 items-center" : "items-start")}
        >
          <PosterImage
            itemId={session.itemId}
            tag={null}
            alt={`Poster for ${session.itemName}`}
            className={isCompact ? "h-12 w-9 shrink-0" : "h-24 w-16 shrink-0"}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Link
              to="/items/$itemId"
              params={{ itemId: session.itemId }}
              className="truncate font-medium text-foreground hover:underline focus-visible:underline"
            >
              {session.itemName}
            </Link>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <UserAvatar userId={session.userId} name={session.userName} className="size-5" />
              <span className="truncate">
                {session.userName} · {session.deviceName}
              </span>
            </span>
            {!isCompact && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <Badge variant="secondary">{session.client}</Badge>
                <Badge variant="outline">{session.playMethod}</Badge>
                {session.isPaused && <Badge variant="outline">Paused</Badge>}
              </div>
            )}
          </div>
        </div>

        <div className={cn("flex flex-col gap-1", isCompact ? "w-28 shrink-0" : "w-full")}>
          {percent !== null && (
            <div
              role="progressbar"
              aria-valuenow={Math.round(percent)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Playback progress for ${session.itemName}`}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
            </div>
          )}
          <span className="truncate text-xs text-muted-foreground">
            {formatDuration(positionMs)}
            {runtimeMs !== null ? ` / ${formatDuration(runtimeMs)}` : ""}
            {isCompact && session.isPaused ? " · Paused" : ""}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
