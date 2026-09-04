import { RefreshCw } from "lucide-react";
import { useState } from "react";

import type { SettingsResponse } from "../../api/queries";
import { formatRelativeTime } from "../../lib/format";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Skeleton } from "../ui/skeleton";

export type SyncStatus = SettingsResponse["sync"];

export interface SettingsSyncCardProps {
  /** `null` while the settings query hasn't resolved yet. */
  status: SyncStatus | null;
  loading: boolean;
  /**
   * Resolves once the server has accepted the request — a sync *started*
   * (or was already running), not finished. Rejects when the request itself
   * failed, which this card surfaces inline.
   */
  onSync: () => Promise<void>;
}

/**
 * The one control on the Settings page that talks to Jellyfin: "Sync now"
 * re-reads users, libraries, and the item catalogue on demand instead of
 * waiting for the nightly item sync. Props only — `routes/settings.tsx` owns
 * the mutation and the polling that flips `status.running` back to false;
 * this card just renders whatever status it is handed and reports clicks.
 *
 * Deliberately its own card, not a row in `SettingsConfigCard`: that card
 * is pinned as read-only ("no editable control") by its tests and its own
 * description, and a button that kicks off a job is the opposite of that.
 */
export function SettingsSyncCard({ status, loading, onSync }: SettingsSyncCardProps) {
  const [failed, setFailed] = useState(false);

  async function handleClick() {
    setFailed(false);
    try {
      await onSync();
    } catch {
      setFailed(true);
    }
  }

  const running = status?.running === true;
  const available = status?.available !== false;

  return (
    <Card data-testid="settings-sync-card">
      <CardHeader>
        <CardTitle>Library sync</CardTitle>
        <CardDescription>
          Re-reads users, libraries, and every movie, episode, and track from Jellyfin. This happens
          automatically on the reference sync interval, with a full item sync nightly. Run it now
          after adding media so it shows up in stats straight away.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4">
        {loading || status === null ? (
          <Skeleton className="h-9 w-28" />
        ) : (
          <>
            <Button
              type="button"
              disabled={running || !available}
              onClick={() => void handleClick()}
            >
              <RefreshCw aria-hidden="true" className={running ? "animate-spin" : undefined} />
              {running ? "Syncing…" : "Sync now"}
            </Button>
            <span className="text-sm text-muted-foreground">
              {!available
                ? "Manual sync is not available on this server."
                : status.lastRunAt !== null
                  ? `Last synced ${formatRelativeTime(status.lastRunAt)}`
                  : "Never synced"}
            </span>
          </>
        )}
        {failed && (
          <p role="alert" className="w-full text-sm text-destructive">
            Could not start the sync. Check that the server can reach Jellyfin and try again.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
