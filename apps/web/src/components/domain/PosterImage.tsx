import { ImageOff } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/cn";

export interface PosterImageProps {
  itemId: string;
  /**
   * A cache-busting hint, not a prerequisite. `apps/server/src/api/routes/images.ts`
   * reads this as an *optional* query parameter and proxies to Jellyfin's
   * primary-image endpoint either way — a missing tag does not mean a
   * missing image. Kept as `string | null` (not made optional) because both
   * real callers already carry it that way: `TopContentList` passes
   * `TopItemsResponse[number].imageTag`, and the reference-items table
   * (`packages/db/src/repositories/stats.ts`) types that column
   * `string | null` end to end, straight from Postgres's nullable column.
   * Making this prop `tag?: string` would just push a `?? undefined`
   * conversion into every call site for no behavioral difference — there is
   * only one "no tag" value in practice (`null`), never `undefined`, so the
   * ambiguity that distinction would exist to prevent doesn't arise here.
   */
  tag: string | null;
  alt: string;
  className?: string;
}

/**
 * Poster art for a library item. Props only — it builds a request to *our
 * own* `/api/images/items/:itemId` proxy and nothing else; it never touches
 * Jellyfin directly and never sees (or needs) the Jellyfin API key. That
 * proxy validates `itemId` server-side (apps/server/src/api/routes/images.ts)
 * — this component's only job is to never construct a URL pointing anywhere
 * but that one endpoint.
 *
 * A missing `tag` still issues a request — omitting the `tag` query
 * parameter entirely rather than sending it as `null`. This used to
 * short-circuit straight to the placeholder on a null tag, which was wrong:
 * the proxy (and Jellyfin underneath it) serves an item's current primary
 * image with no tag at all, since the tag is only ever a cache-busting hint,
 * not a prerequisite. `LiveSession`-backed callers (no image tag exists on
 * that type at all — see `ActiveStreamCard`) were rendering a permanent grey
 * placeholder for every stream even when real artwork was one request away.
 *
 * Degrades to a placeholder — never a browser broken-image icon — only via
 * `onError`, when the request actually fails (item genuinely has no
 * artwork, item deleted upstream, proxy 404, network failure). `failed`
 * resets whenever `itemId`/`tag` change so a component instance reused
 * across re-renders (rather than remounted, which a list `key` normally
 * ensures) doesn't get stuck showing a placeholder for a poster that would
 * now succeed.
 */
export function PosterImage({ itemId, tag, alt, className }: PosterImageProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [itemId, tag]);

  if (failed) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={cn(
          "flex items-center justify-center rounded-md border border-border bg-muted text-muted-foreground",
          className,
        )}
      >
        <ImageOff aria-hidden="true" className="size-6" />
      </div>
    );
  }

  // The tag query parameter is appended only when a real tag exists — never
  // as the literal string "null"/"undefined", which would reach the proxy
  // as a nonsense cache-busting value and could produce a confusing upstream
  // 404 instead of a clean, tagless primary-image request.
  const src =
    tag !== null
      ? `/api/images/items/${encodeURIComponent(itemId)}?tag=${encodeURIComponent(tag)}`
      : `/api/images/items/${encodeURIComponent(itemId)}`;

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className={cn("rounded-md border border-border object-cover", className)}
      onError={() => setFailed(true)}
    />
  );
}
