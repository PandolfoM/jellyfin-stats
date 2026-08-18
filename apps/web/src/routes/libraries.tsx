import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";

import { libraryStatsQuery } from "../api/queries";
import { DateRangePicker } from "../components/domain/DateRangePicker";
import { LibraryStatsTable } from "../components/domain/LibraryStatsTable";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { defaultRange } from "../lib/range";
import { PanelError } from "./PanelError";
import { rootRoute } from "./__root";

/**
 * The libraries list. A container, mirroring `routes/users.tsx` exactly:
 * one query, the range state that feeds it, and a props-only table that
 * has no idea a range exists.
 *
 * A 401 is not handled here, for the same ordering reason it isn't in any
 * other route container — see `routes/index.tsx`'s doc comment.
 */
function LibrariesRoute() {
  const [range, setRange] = useState(() => defaultRange());
  const libraries = useQuery(libraryStatsQuery(range));

  return (
    <div data-testid="libraries-route" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-foreground">Libraries</h1>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All libraries</CardTitle>
        </CardHeader>
        <CardContent>
          {libraries.isError ? (
            <PanelError testId="libraries-error" />
          ) : (
            <LibraryStatsTable libraries={libraries.data ?? []} loading={libraries.isLoading} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export const librariesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/libraries",
  component: LibrariesRoute,
});
