import { createRoute, createRouter, type RouterHistory } from "@tanstack/react-router";

import { rootRoute } from "./routes/__root";
import { historyRoute } from "./routes/history";
import { indexRoute } from "./routes/index";
import { librariesRoute } from "./routes/libraries";
import { libraryDetailRoute } from "./routes/libraries.$libraryId";
import { liveRoute } from "./routes/live";
import { LoginRoute } from "./routes/login";
import { settingsRoute } from "./routes/settings";
import { usersRoute } from "./routes/users";
import { userDetailRoute } from "./routes/users.$userId";

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  liveRoute,
  historyRoute,
  usersRoute,
  userDetailRoute,
  librariesRoute,
  libraryDetailRoute,
  settingsRoute,
  loginRoute,
]);

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

/**
 * `RoutePaths<TRouteTree>` — the utility TanStack Router itself uses to
 * type a `<Link to="...">` — is only exported from `@tanstack/router-core`,
 * not re-exported from `@tanstack/react-router`'s public entry point, and
 * `router-core` is not a direct dependency of this package (pnpm's isolated
 * node_modules means it is not even resolvable from here — see this task's
 * report for how that was confirmed). So the registered-path union below is
 * built from each route object's own `fullPath`, which *is* public: every
 * `createRoute({ path: "..." })` call infers a literal string type for that
 * route's `fullPath` the same way it would for `RoutePaths`, since every
 * route in this tree is a direct child of the root with no explicit `id`
 * override.
 *
 * `/settings` (Task 11) is now a real route and included below like every
 * other one — `AppShell.tsx`'s `NavItem.to` no longer needs the manual
 * `| "/settings"` union member or the `as AppRoutePath` cast it carried
 * while this route didn't exist yet.
 */
export type AppRoutePath =
  | typeof indexRoute.fullPath
  | typeof liveRoute.fullPath
  | typeof historyRoute.fullPath
  | typeof usersRoute.fullPath
  | typeof userDetailRoute.fullPath
  | typeof librariesRoute.fullPath
  | typeof libraryDetailRoute.fullPath
  | typeof settingsRoute.fullPath
  | typeof loginRoute.fullPath;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
