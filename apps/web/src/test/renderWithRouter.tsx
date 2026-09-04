import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * Renders a props-only component that contains a `<Link>` inside the minimal
 * router context `Link` needs to resolve `to`/`params` into an `href` — a
 * bespoke single-route tree, not the application's route tree or providers
 * (those belong to `renderApp`, for route containers).
 *
 * Extracted once `TopContentList`, `ActivityFeed`, `PlaybackHistoryTable`
 * and `ActiveStreamCard` all gained an item link and each needed the same
 * wrapper `UserStatsTable.test.tsx` had already written inline.
 *
 * Async because the router resolves its initial matches asynchronously —
 * without the preload, a sync `getBy*` right after `render` sees an empty
 * tree. `rerender` unmounts and mounts a fresh tree rather than updating in place:
 * the root route's component is fixed at router creation, so there is no
 * cheaper way to swap the element out, and the callers only ever assert on
 * the result of the second render, not on state carried across it.
 */
export interface RouterRenderResult {
  unmount: () => void;
  rerender: (next: ReactNode) => Promise<RouterRenderResult>;
}

export async function renderWithRouter(ui: ReactNode): Promise<RouterRenderResult> {
  const rootRoute = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // Loading first means the provider mounts with its matches already
  // resolved, so callers can query the DOM synchronously after awaiting.
  await router.load();
  const result = render(<RouterProvider router={router} />);

  return {
    unmount: result.unmount,
    rerender: async (next: ReactNode) => {
      result.unmount();
      return renderWithRouter(next);
    },
  };
}
