import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { SessionProvider, useSession } from "./auth/session";
import { LoginRoute } from "./routes/login";
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

/**
 * Stands in for the real router and protected-route gate that a later task
 * adds. It only needs to make `SessionProvider`'s four states visible: the
 * loading flash before `/api/auth/me` resolves, an anonymous visitor sent to
 * the login screen, a broken server surfaced instead of a login form that
 * cannot possibly succeed, and an authenticated session reaching the app.
 */
function AppShell() {
  const { status } = useSession();

  if (status === "loading") {
    return (
      <div className="flex min-h-svh items-center justify-center text-muted-foreground">Loading…</div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex min-h-svh items-center justify-center text-destructive">
        Could not reach the server. Try refreshing the page.
      </div>
    );
  }

  if (status === "anonymous") {
    return <LoginRoute />;
  }

  return <p>Jellyfin Stats</p>;
}

const root = document.getElementById("root");

if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <AppShell />
        </SessionProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
