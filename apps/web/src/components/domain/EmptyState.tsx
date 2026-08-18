import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  className?: string;
}

/**
 * The shared "nothing here yet" placeholder used by every list that can be
 * empty (no active streams, no history rows, no users, no libraries). Props
 * only — no data fetching, no domain knowledge of what produced the empty
 * result.
 */
export function EmptyState({ title, description, icon, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-10 text-center",
        className,
      )}
    >
      {icon !== undefined && (
        <div aria-hidden="true" className="text-muted-foreground">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}
