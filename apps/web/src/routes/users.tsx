import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";

import { userStatsQuery } from "../api/queries";
import { DateRangePicker } from "../components/domain/DateRangePicker";
import { UserStatsTable } from "../components/domain/UserStatsTable";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { defaultRange } from "../lib/range";
import { PanelError } from "./PanelError";
import { rootRoute } from "./__root";

/**
 * The users list. A container, like `routes/index.tsx` and
 * `routes/history.tsx`: it owns the one query this route needs and the
 * range state that feeds it, and passes plain resolved data down to
 * `UserStatsTable`, a props-only domain component with no idea a range
 * exists.
 *
 * A 401 is not handled here, for the same reason it isn't in the other
 * route containers — see `routes/index.tsx`'s doc comment for the full
 * ordering argument.
 */
function UsersRoute() {
  const [range, setRange] = useState(() => defaultRange());
  const users = useQuery(userStatsQuery(range));

  return (
    <div data-testid="users-route" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-foreground">Users</h1>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All users</CardTitle>
        </CardHeader>
        <CardContent>
          {users.isError ? (
            <PanelError testId="users-error" />
          ) : (
            <UserStatsTable users={users.data ?? []} loading={users.isLoading} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/users",
  component: UsersRoute,
});
