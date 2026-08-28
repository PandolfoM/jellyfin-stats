import * as React from "react";

import { cn } from "../../lib/cn";

/**
 * `min-w-0` is a deviation from the upstream shadcn card, and it is load-bearing.
 *
 * A grid or flex item defaults to `min-width: auto`, which means it refuses to
 * shrink below its content's intrinsic width. A card holding a wide table
 * therefore grows the track it sits in, that grows the page, and the whole
 * window scrolls sideways — while the table's own `overflow-x-auto` wrapper
 * never engages, because it was never the thing being squeezed. Adding it here
 * rather than at each call site fixes every card that is or later becomes a
 * flex/grid child; in normal flow it does nothing at all.
 */
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex min-w-0 flex-col gap-6 rounded-xl border border-border bg-card py-6 text-card-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex flex-col gap-1.5 px-6", className)}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-6", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-footer" className={cn("flex items-center px-6", className)} {...props} />
  );
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
