import { ImageOff } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/cn";

export interface PosterImageProps {
  itemId: string;
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
 * Degrades to a placeholder — never a browser broken-image icon — in the two
 * ways a poster can be unavailable: no `tag` at all (nothing to ask for), or
 * an `onError` after the request fails (item deleted upstream, proxy 404,
 * network failure). `failed` resets whenever `itemId`/`tag` change so a
 * component instance reused across re-renders (rather than remounted, which
 * a list `key` normally ensures) doesn't get stuck showing a placeholder for
 * a poster that would now succeed.
 */
export function PosterImage({ itemId, tag, alt, className }: PosterImageProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [itemId, tag]);

  if (tag === null || failed) {
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

  return (
    <img
      src={`/api/images/items/${encodeURIComponent(itemId)}?tag=${encodeURIComponent(tag)}`}
      alt={alt}
      loading="lazy"
      className={cn("rounded-md border border-border object-cover", className)}
      onError={() => setFailed(true)}
    />
  );
}
