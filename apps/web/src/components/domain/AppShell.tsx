import { Link } from "@tanstack/react-router";
import { Clock, LayoutDashboard, Library, LogOut, Radio, Settings, Users } from "lucide-react";
import type { ReactNode } from "react";

import type { AppRoutePath } from "../../router";
import { Button, buttonVariants } from "../ui/button";
import { cn } from "../../lib/cn";

export interface AppShellProps {
  userName: string;
  onLogout: () => void;
  children: ReactNode;
}

interface NavItem {
  label: string;
  /**
   * `AppRoutePath` (router.ts) rather than `string` — this is what makes
   * `Register` (also router.ts) actually catch something: a `Link to={item.to}`
   * fed a bare `string` type-checks against any `to` prop, registered router
   * or not, because a non-literal `string` can't be validated against a
   * literal union at all. Narrowing this to the real registered paths is
   * what makes a typo'd `to` here (or a route renamed in router.ts without
   * updating this list) fail `pnpm typecheck` instead of silently 404ing at
   * runtime — the entire reason `Register` was deferred until routes with
   * real path literals existed to register against.
   *
   * Until Task 11, this field carried a hand-unioned `| "/settings"` member
   * and the `Link` below carried an `as AppRoutePath` cast, because
   * `/settings` had no route file yet and so could not appear in
   * `router.ts`'s route tree or `AppRoutePath`. Task 11 added the real
   * `/settings` route, so both are gone: `to` narrows to the actual
   * registered paths alone, with no exceptions.
   */
  to: AppRoutePath;
  icon: typeof LayoutDashboard;
}

// Six destinations, matching the plan's explicit path list exactly. ("seven
// navigation links" in the plan's Task 4 test description is a documented
// slip that leaked from an unrelated route count elsewhere in the same
// document — the six paths listed right next to it are authoritative.)
const NAV_ITEMS: readonly NavItem[] = [
  { label: "Overview", to: "/", icon: LayoutDashboard },
  { label: "Live", to: "/live", icon: Radio },
  { label: "History", to: "/history", icon: Clock },
  { label: "Users", to: "/users", icon: Users },
  { label: "Libraries", to: "/libraries", icon: Library },
  { label: "Settings", to: "/settings", icon: Settings },
];

const navLinkClassName = cn(buttonVariants({ variant: "ghost" }), "w-full justify-start gap-2");

/**
 * Sidebar navigation + content area. Props only: it does not call
 * `useSession` or fetch anything itself, so it renders with just `userName`,
 * `onLogout`, and `children` and no providers wired up around it. The root
 * route (`routes/__root.tsx`) is the only caller, and it is the one that
 * reads the session and decides whether this component renders at all.
 */
export function AppShell({ userName, onLogout, children }: AppShellProps) {
  return (
    <div className="flex min-h-svh">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card p-4">
        <div className="mb-6 px-2 text-sm font-semibold text-foreground">Jellyfin Stats</div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={navLinkClassName}
                activeOptions={{ exact: item.to === "/" }}
                activeProps={{ className: cn(navLinkClassName, "bg-secondary text-secondary-foreground") }}
              >
                <Icon aria-hidden="true" className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-6 flex flex-col gap-2 border-t border-border pt-4">
          <p className="truncate px-2 text-sm text-muted-foreground" title={userName}>
            {userName}
          </p>
          <Button variant="outline" size="sm" className="justify-start gap-2" onClick={onLogout}>
            <LogOut aria-hidden="true" className="size-4" />
            Log out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-x-auto p-6">{children}</main>
    </div>
  );
}
