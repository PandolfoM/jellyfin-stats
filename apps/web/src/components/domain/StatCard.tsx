import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Skeleton } from "../ui/skeleton";

export interface StatCardProps {
  label: string;
  value: string | number;
  hint?: string;
  loading?: boolean;
}

/**
 * A single metric tile. Props only — no fetching, no knowledge of what the
 * number means. The caller decides the label, formats the value (see
 * lib/format.ts), and tells this component whether to show a skeleton.
 *
 * Owning its own loading state here (rather than the caller conditionally
 * rendering a `<Skeleton>` beside it) is what lets four different routes
 * reuse this component without each reimplementing the placeholder.
 */
export function StatCard({ label, value, hint, loading = false }: StatCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-9 w-24" />
        ) : (
          <p className="text-3xl font-semibold text-foreground">{value}</p>
        )}
        {hint !== undefined && !loading && (
          <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
        )}
      </CardContent>
    </Card>
  );
}
