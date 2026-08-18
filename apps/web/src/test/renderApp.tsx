import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";

import { SessionProvider } from "../auth/session";
import { createAppRouter, type AppRouter } from "../router";

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
