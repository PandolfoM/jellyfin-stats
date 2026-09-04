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

// One class for both layouts. The nav is a single element that changes
// direction at the breakpoint rather than two navs toggled by `hidden` —
// rendering it twice would duplicate every link in the accessibility tree, and
// jsdom applies no CSS, so this component's tests would then see each link
// twice and could not tell which one a user could actually reach.
const navLinkClassName = cn(
  buttonVariants({ variant: "ghost" }),
  "shrink-0 gap-2 md:w-full md:justify-start",
);

/**
 * Navigation + content area, side-by-side on a wide screen and stacked on a
 * narrow one.
 *
 * The sidebar is `w-56` — nearly two thirds of a 375px phone — so below `md`
 * the whole aside becomes a header strip instead: the brand on one line, the
 * nav scrolling horizontally beneath it, and the account row alongside. Every
 * element appears exactly once and is reflowed by CSS, never duplicated and
 * hidden per breakpoint, so there is one of each in the accessibility tree.
 *
 * Props only: it does not call
 * `useSession` or fetch anything itself, so it renders with just `userName`,
 * `onLogout`, and `children` and no providers wired up around it. The root
 * route (`routes/__root.tsx`) is the only caller, and it is the one that
 * reads the session and decides whether this component renders at all.
 */
export function AppShell({ userName, onLogout, children }: AppShellProps) {
  return (
    // Desktop: the shell is exactly the viewport and clips, so the sidebar
    // never moves and <main> below is the single scroll container. Phone: the
    // sidebar is a top bar and the page scrolls as one — pinning ~110px of nav
    // to the top of a 375px-wide screen would cost more than it gives.
    <div className="flex min-h-svh flex-col md:h-svh md:flex-row md:overflow-hidden">
      <aside className="flex flex-col gap-3 border-b border-border bg-card p-3 md:w-56 md:shrink-0 md:gap-0 md:border-r md:border-b-0 md:p-4">
        <div className="px-2 text-sm font-semibold text-foreground md:mb-6">Jellyfin Stats</div>
        {/* Horizontally scrollable on a phone: six destinations do not fit
            across 375px, and scrolling them keeps every one reachable without
            a drawer to open. `-mx-1 px-1` lets the first and last pill sit
            flush with the padding while still having room for a focus ring. */}
        <nav
          aria-label="Main"
          className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:mx-0 md:flex-1 md:flex-col md:overflow-x-visible md:px-0 md:pb-0"
        >
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={navLinkClassName}
                activeOptions={{ exact: item.to === "/" }}
                activeProps={{
                  className: cn(navLinkClassName, "bg-secondary text-secondary-foreground"),
                }}
              >
                <Icon aria-hidden="true" className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        {/* Side by side on a phone so the account row costs one line rather
            than two; stacked in the sidebar as before. */}
        <div className="flex items-center justify-between gap-2 border-t border-border pt-3 md:mt-6 md:flex-col md:items-stretch md:gap-2 md:pt-4">
          <p className="truncate px-2 text-sm text-muted-foreground" title={userName}>
            {userName}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-2 md:justify-start"
            onClick={onLogout}
          >
            <LogOut aria-hidden="true" className="size-4" />
            Log out
          </Button>
        </div>
      </aside>
      {/* `min-w-0` is what actually lets the tables inside scroll: without it a
          flex child refuses to shrink below its content's intrinsic width, so a
          wide table would stretch the page instead of scrolling within it. */}
      <main className="min-w-0 flex-1 overflow-x-auto p-4 md:overflow-y-auto md:p-6">
        {children}
      </main>
    </div>
  );
}
