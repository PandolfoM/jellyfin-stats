import { Navigate, Outlet, createRootRoute, useRouterState } from "@tanstack/react-router";

import { useSession } from "../auth/session";
import { AppShell } from "../components/domain/AppShell";
import { Skeleton } from "../components/ui/skeleton";

const LOGIN_PATH = "/login";

/**
 * Shown only while `SessionProvider` has not yet resolved `/api/auth/me`.
 * No route renders underneath it — the whole point of the gate is that a
 * protected route's content (and any query it would fire) never mounts
 * before we know whether the visitor is signed in.
 */
function ShellSkeleton() {
  return (
    <div data-testid="shell-skeleton" className="flex min-h-svh items-center justify-center gap-3">
      <Skeleton className="size-8 rounded-full" />
      <Skeleton className="h-4 w-32" />
    </div>
  );
}

/**
 * Shown for the "error" session status (the API is unreachable or returned
 * something other than a 2xx/401) on every path, including `/login` — a
 * broken server means a login form that cannot possibly succeed, so it must
 * not render here either.
 */
function SessionErrorState() {
  return (
    <div
      role="alert"
      data-testid="session-error"
      className="flex min-h-svh items-center justify-center p-4 text-center text-destructive"
    >
      Could not reach the server. Try refreshing the page.
    </div>
  );
}

function RootComponent() {
  const session = useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isLoginPath = pathname === LOGIN_PATH;

  if (session.status === "loading") {
    return <ShellSkeleton />;
  }

  if (session.status === "error") {
    return <SessionErrorState />;
  }

  if (session.status === "anonymous") {
    // /login is the one route reachable while anonymous; everything else
    // redirects there instead of rendering its (empty, 401-fetching) content.
    if (isLoginPath) {
      return <Outlet />;
    }
    return <Navigate to={LOGIN_PATH} replace />;
  }

  // status === "authenticated" from here down.
  if (session.user === null) {
    // SessionState's `status` and `user` fields aren't a true discriminated
    // union (nothing type-level ties "authenticated" to a non-null user), so
    // this keeps the branch honest without reaching for a non-null assertion.
    // The real SessionProvider never produces this combination.
    return <SessionErrorState />;
  }

  // The gate runs in both directions: /login is the anonymous-only route,
  // the mirror of every other path being authenticated-only. Without this,
  // `authenticated` renders `AppShell > Outlet` for /login too — so the
  // moment a submitted login resolves, while the URL is still /login, the
  // login card appears wrapped in the sidebar instead of the dashboard.
  if (isLoginPath) {
    return <Navigate to="/" replace />;
  }

  return (
    <AppShell userName={session.user.userName} onLogout={() => void session.logout()}>
      <Outlet />
    </AppShell>
  );
}

export const rootRoute = createRootRoute({ component: RootComponent });
