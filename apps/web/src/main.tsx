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

// Not registered with `declare module "@tanstack/react-router" { interface
// Register { router: typeof router } }` yet: AppShell also links to
// /history, /users, /libraries, and /settings, none of which have a route
// definition until Tasks 9–11 add them (/live, Task 8, now does). Registering
// now would make every one of those still-missing `Link to="..."` props a
// type error. Whoever adds the last of those routes should add the
// registration then, for full type-safety on navigation.
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
