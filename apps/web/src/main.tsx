import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { SessionProvider } from "./auth/session";
import { createAppRouter } from "./router";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 means "log in", not "try again" — retrying it just delays the redirect.
      retry: (failureCount, error) =>
        error instanceof Error && "status" in error && error.status === 401 ? false : failureCount < 2,
      staleTime: 30_000,
    },
  },
});

// `declare module "@tanstack/react-router" { interface Register { router:
// AppRouter } }` now lives in router.ts, registered once Task 10 added the
// last routes (/users, /users/$userId, /libraries, /libraries/$libraryId)
// this app has today. /settings (Task 11) is still missing, so it is not
// part of the registered path union — see AppShell.tsx's `NavItem.to` for
// how that one remaining gap is carried forward explicitly.
const router = createAppRouter();

const root = document.getElementById("root");

if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
