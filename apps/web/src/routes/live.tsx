import { createRoute } from "@tanstack/react-router";

import { useLiveSessions } from "../api/useLiveSessions";
import { ActiveStreamCard } from "../components/domain/ActiveStreamCard";
import { EmptyState } from "../components/domain/EmptyState";
import { cn } from "../lib/cn";
import { rootRoute } from "./__root";

/**
 * Small status pill showing whether the SSE feed is actually connected right
 * now — the visible half of the fix for the "stale data that looks current"
 * failure mode `useLiveSessions`'s doc comment describes. A dropped
 * connection must never look identical to a healthy one just because the
 * last-known session list is still sitting in state.
 */
function ConnectionStatus({ connected }: { connected: boolean }) {
  return (
    <span
      data-testid="live-connection-status"
      data-connected={connected}
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium",
        connected ? "bg-emerald-500/10 text-emerald-600" : "bg-destructive/10 text-destructive",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 rounded-full", connected ? "bg-emerald-500" : "bg-destructive")}
      />
      {connected ? "Live" : "Disconnected — reconnecting…"}
    </span>
  );
}

/**
 * The dedicated live-streams screen. A container, like `routes/index.tsx`:
 * it owns the one thing this route needs (`useLiveSessions`) and passes
 * plain data down to props-only domain components.
 *
 * Unlike every other route, this one does not use TanStack Query — SSE is a
 * push stream, not a request the query layer's cache-and-refetch model fits
 * — so there is no `isLoading`/`isError` here, only `connected`.
 *
 * When the feed drops, this deliberately does **not** clear the grid: the
 * last-known sessions stay visible (an admin glancing at the screen still
 * sees *something*, rather than a jarring flash to empty on every brief
 * blip), but the whole grid is visually marked stale — dimmed and grayed
 * out — and the status pill switches to "Disconnected" so nothing here can
 * be mistaken for a live view. That combination is the actual fix for the
 * failure mode this task's brief warns about most: a frozen "now playing"
 * list that still *looks* live is worse than one that visibly says it isn't.
 */
function LiveRoute() {
  const { sessions, connected } = useLiveSessions();

  return (
    <div data-testid="live-route" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-foreground">Live</h1>
        <ConnectionStatus connected={connected} />
      </div>

      {sessions.length === 0 ? (
        <EmptyState title="Nothing playing" description="No active streams right now." />
      ) : (
        <div
          data-testid="live-sessions-grid"
          data-connected={connected}
          className={cn(
            "grid gap-4 transition-opacity sm:grid-cols-2 lg:grid-cols-3",
            !connected && "opacity-50 grayscale",
          )}
        >
          {sessions.map((session) => (
            <ActiveStreamCard key={session.sessionId} session={session} variant="full" />
          ))}
        </div>
      )}
    </div>
  );
}

export const liveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/live",
  component: LiveRoute,
});
