import type { UserDetailResponse } from "../../api/queries";
import { formatCount } from "../../lib/format";
import { Skeleton } from "../ui/skeleton";
import { EmptyState } from "./EmptyState";

// No standalone `Device` export from queries.ts — `devices` is a field on
// `UserDetailResponse`, not its own endpoint — so this is derived from the
// one exported response type rather than re-declared by hand, the same way
// `ActivityFeed`'s `ActivityRow` and `PlaybackHistoryTable`'s
// `PlaybackHistoryRow` are.
export type DeviceStat = UserDetailResponse["devices"][number];

export interface DeviceBreakdownProps {
  devices: DeviceStat[];
  loading: boolean;
}

const SKELETON_ROW_COUNT = 4;

/**
 * Per-device play counts for the user-detail route — `getUserDetail`
 * (packages/db/src/repositories/stats.ts) sources this from
 * `playback_sessions`, already sorted by play count descending, with
 * `deviceName` substituted with "Unknown device" for a session whose device
 * row no longer exists rather than the row being dropped. Props only: no
 * fetching, no knowledge of which user or range produced this list.
 *
 * Each row's bar is scaled against the list's own max, not some fixed
 * constant — the longest bar is always full width regardless of whether
 * this user has 3 plays on their busiest device or 3,000.
 */
export function DeviceBreakdown({ devices, loading }: DeviceBreakdownProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading device breakdown">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  if (devices.length === 0) {
    return <EmptyState title="No devices" description="No sessions recorded in the selected range." />;
  }

  const maxPlays = Math.max(...devices.map((device) => device.plays));

  return (
    <ul className="flex flex-col gap-3">
      {devices.map((device) => (
        <li key={device.deviceId} data-testid="device-breakdown-row" className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-foreground">{device.name}</span>
            <span className="text-muted-foreground">{formatCount(device.plays)} plays</span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted">
            <div
              className="h-2 rounded-full bg-primary"
              style={{ width: `${(device.plays / maxPlays) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
