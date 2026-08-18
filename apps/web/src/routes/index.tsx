import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "./__root";

/**
 * Placeholder for the Overview screen. Task 7 replaces this body with the
 * real stat cards and activity feed; this task only needs a route that
 * renders (and is provably absent while loading/anonymous/error) so the
 * protected-route gate has something concrete to gate.
 */
function Overview() {
  return (
    <div data-testid="overview-route">
      <h1 className="text-lg font-semibold text-foreground">Overview</h1>
      <p className="text-sm text-muted-foreground">Dashboard content lands in a later task.</p>
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Overview,
});
