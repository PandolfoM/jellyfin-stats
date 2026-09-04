import { useEffect, useState } from "react";

import { cn } from "../../lib/cn";
import { initialsFor } from "../../lib/format";

export interface UserAvatarProps {
  userId: string;
  /** Used for the alt text and, when Jellyfin has no avatar, the initials. */
  name: string;
  className?: string;
}

/** Requested width in CSS pixels. Rendered at 24–40px, so 64 covers 2x displays. */
const AVATAR_WIDTH = 64;

/**
 * A user's Jellyfin avatar as a small circle. Like `PosterImage`, it only
 * ever requests our own `/api/images/users/:userId` proxy — never Jellyfin
 * directly — and degrades on `onError` rather than showing a broken image.
 *
 * The fallback is the user's initials, not an icon: most Jellyfin users
 * never upload an avatar, so a 404 here is the common case, and a row of
 * identical grey icons would carry less than the name it sits beside.
 * `failed` resets when `userId` changes so a reused instance does not stay
 * stuck on initials for a user whose avatar would load.
 */
export function UserAvatar({ userId, name, className }: UserAvatarProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [userId]);

  const label = name === "" ? "Avatar" : `Avatar for ${name}`;
  const sizing = cn("size-6 shrink-0 rounded-full", className);

  if (failed) {
    return (
      <span
        role="img"
        aria-label={label}
        className={cn(
          sizing,
          "inline-flex select-none items-center justify-center bg-muted text-[0.6rem] font-semibold uppercase leading-none text-muted-foreground",
        )}
      >
        {initialsFor(name)}
      </span>
    );
  }

  return (
    <img
      src={`/api/images/users/${encodeURIComponent(userId)}?maxWidth=${AVATAR_WIDTH}`}
      alt={label}
      loading="lazy"
      className={cn(sizing, "border border-border object-cover")}
      onError={() => setFailed(true)}
    />
  );
}
