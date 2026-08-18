import { Link } from "@tanstack/react-router";

import type { UserStatsResponse } from "../../api/queries";
import { formatCount, formatDuration } from "../../lib/format";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { EmptyState } from "./EmptyState";

export interface UserStatsTableProps {
  users: UserStatsResponse;
  loading: boolean;
}

const SKELETON_ROW_COUNT = 6;

/**
 * The `/users` list: every non-archived Jellyfin user, ranked by watch time.
 * Props only — no fetching, no range/filter state — the same convention
 * every other domain table in this directory follows.
 *
 * `getUserStats` (packages/db/src/repositories/stats.ts) `LEFT JOIN`s from
 * `jellyfin_users`, not from the rollup, specifically so a user who took the
 * selected range off still appears here with zero plays/watch time instead
 * of vanishing from the roster. This component must not undo that by
 * filtering `users` itself — it renders every row it is handed, in the
 * order the API already sorted them.
 *
 * Each name links to that user's detail route (`/users/$userId`, this
 * task's other new route) — the one piece of routing knowledge this
 * component carries, matching `AppShell`'s own nav links.
 */
export function UserStatsTable({ users, loading }: UserStatsTableProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading users">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (users.length === 0) {
    return <EmptyState title="No users" description="No Jellyfin users were found." />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Role</TableHead>
          <TableHead className="text-right">Plays</TableHead>
          <TableHead className="text-right">Watch time</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => (
          <TableRow key={user.userId} data-testid="user-stats-row">
            <TableCell className="font-medium text-foreground">
              <Link
                to="/users/$userId"
                params={{ userId: user.userId }}
                className="hover:underline focus-visible:underline"
              >
                {user.name}
              </Link>
            </TableCell>
            <TableCell>{user.isAdmin && <Badge variant="secondary">Admin</Badge>}</TableCell>
            <TableCell className="text-right">{formatCount(user.plays)}</TableCell>
            <TableCell className="text-right">{formatDuration(user.watchMs)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
