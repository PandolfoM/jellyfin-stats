import type { SettingsResponse } from "../../api/queries";
import { formatDuration, formatPercent } from "../../lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Skeleton } from "../ui/skeleton";

export interface SettingsConfigCardProps {
  /** `null` while the settings query hasn't resolved yet. `routes/settings.tsx`
   * renders `PanelError` in this card's place entirely once the query errors
   * — see that file — so `null` here only ever means "still loading", never
   * "failed". */
  config: SettingsResponse | null;
  loading: boolean;
}

interface ConfigRowProps {
  label: string;
  value: string;
  loading: boolean;
}

function ConfigRow({ label, value, loading }: ConfigRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      {loading ? (
        <Skeleton className="h-4 w-40" />
      ) : (
        <span className="break-all text-right font-mono text-sm text-foreground">{value}</span>
      )}
    </div>
  );
}

/**
 * The effective server configuration this deployment is running with. Props
 * only — no query of its own; `routes/settings.tsx` owns `useQuery(settingsQuery())`
 * and passes the result straight through.
 *
 * Read-only by design, and still read-only now that `/api/settings` does have
 * a mutation endpoint beside it: everything this card shows comes from
 * environment variables fixed when the server was deployed, so no amount of
 * clicking here could change them. That endpoint writes exactly one runtime
 * setting, the custom stylesheet, which has its own editable card
 * (`SettingsCustomCssCard`). A control that looks editable but cannot save
 * would be worse than no control at all, which is why the description below
 * says outright where these values come from.
 */
export function SettingsConfigCard({ config, loading }: SettingsConfigCardProps) {
  return (
    <Card data-testid="settings-config-card">
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
        <CardDescription>
          These values are set through environment variables on the server when it is deployed, and
          cannot be changed here.
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border">
        <ConfigRow
          label="Live session poll interval"
          value={config !== null ? formatDuration(config.sessionPollIntervalMs) : ""}
          loading={loading}
        />
        <ConfigRow
          label="Reference sync interval"
          value={config !== null ? formatDuration(config.referenceSyncIntervalMs) : ""}
          loading={loading}
        />
        <ConfigRow
          label="Completion threshold"
          value={config !== null ? formatPercent(config.completionThreshold) : ""}
          loading={loading}
        />
        <ConfigRow
          label="Jellyfin server URL"
          value={config !== null ? config.jellyfinUrl : ""}
          loading={loading}
        />
      </CardContent>
    </Card>
  );
}
