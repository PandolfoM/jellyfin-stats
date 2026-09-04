import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";

import { SessionProvider } from "../auth/session";
import { createAppRouter, type AppRouter } from "../router";
import { installFakeEventSource } from "./fakeEventSource";

/**
 * Renders the real route tree (via `createAppRouter`, the same assembly
 * `main.tsx` uses) at `initialPath`, wrapped in the same provider stack
 * `main.tsx` mounts: a fresh `QueryClient` (retries off, so a mocked error
 * response fails a test fast instead of retrying into a timeout) and
 * `SessionProvider`.
 *
 * Extracted from `routes/guard.test.tsx`'s `renderAt` and
 * `routes/index.test.tsx`'s `renderOverview`, which were the same six lines
 * twice over. `routes/live.test.tsx` would have been a third copy — the
 * point at which this repo's convention (see Task 7's report) says to
 * extract instead of duplicate again.
 */
export function renderApp(initialPath: string): AppRouter {
  // The root opens the live feed for every signed-in render (the sidebar's
  // indicator reads it), and jsdom has no EventSource. Tests that drive the
  // feed install the fake themselves first; this only fills the gap for the
  // ones that don't care.
  if (typeof EventSource === "undefined") installFakeEventSource();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [initialPath] }));
  render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return router;
}
