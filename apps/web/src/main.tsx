import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ApiError } from "./api/client";
import { SessionProvider } from "./auth/session";
import { createAppRouter } from "./router";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 means "log in", not "try again" — retrying it just delays the redirect.
      retry: (failureCount, error) => (error instanceof ApiError && error.status === 401 ? false : failureCount < 2),
      staleTime: 30_000,
    },
  },
});

// `declare module "@tanstack/react-router" { interface Register { router:
// AppRouter } }` lives in router.ts, registered once every route this app
// has — including /settings — was added to both the route tree and the
// `AppRoutePath` union; see router.ts for how that union is built.
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
