import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

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

const root = document.getElementById("root");

if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <p>Jellyfin Stats</p>
      </QueryClientProvider>
    </StrictMode>,
  );
}
