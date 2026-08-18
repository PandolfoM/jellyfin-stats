import { createRoute, createRouter, type RouterHistory } from "@tanstack/react-router";

import { rootRoute } from "./routes/__root";
import { indexRoute } from "./routes/index";
import { liveRoute } from "./routes/live";
import { LoginRoute } from "./routes/login";

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginRoute,
});

const routeTree = rootRoute.addChildren([indexRoute, liveRoute, loginRoute]);

/**
 * Builds a router from the app's one route tree. `main.tsx` and the guard
 * tests both call this, rather than each assembling their own tree, so a
 * route added or renamed in one place cannot silently drift from what the
 * gate tests actually exercise.
 *
 * `history` defaults to a real browser history when omitted (what `main.tsx`
 * wants); tests pass `createMemoryHistory({ initialEntries: [...] })` so each
 * one can start at a specific path without touching `window.location`.
 */
export function createAppRouter(history?: RouterHistory) {
  return createRouter(history !== undefined ? { routeTree, history } : { routeTree });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
