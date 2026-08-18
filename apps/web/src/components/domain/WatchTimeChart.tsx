import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";

import type { SeriesResponse } from "../../api/queries";
import { formatCount, formatDay, formatDuration } from "../../lib/format";
import { Skeleton } from "../ui/skeleton";
import { EmptyState } from "./EmptyState";

export interface WatchTimeChartProps {
  points: SeriesResponse;
  loading: boolean;
}

const CHART_HEIGHT = 280;

interface DayPoint {
  day: string;
  plays: number;
  watchMs: number;
}

function isDayPoint(value: unknown): value is DayPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "day" in value &&
    "plays" in value &&
    "watchMs" in value
  );
}

function ChartTooltip({ active, payload }: TooltipContentProps) {
  if (active !== true || payload === undefined || payload.length === 0) return null;

  const point: unknown = payload[0]?.payload;
  if (!isDayPoint(point)) return null;

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-sm shadow-lg">
      <p className="text-muted-foreground">{formatDay(point.day)}</p>
      {/* Value leads, label follows — the reader already has the day from the
          axis/crosshair and wants the number. */}
      <p className="font-semibold text-foreground">{formatDuration(point.watchMs)}</p>
      <p className="text-xs text-muted-foreground">{formatCount(point.plays)} plays</p>
    </div>
  );
}

/**
 * Watch time per day. Props only — `points` and `loading` come from the
 * caller's query; this component neither fetches nor knows what range it is
 * showing.
 *
 * A single line/area readout — chosen over a bar-per-day because the series
 * is one continuous magnitude (watch time) over a contiguous day spine, and
 * a bar per day would be indistinguishable from an area at typical range
 * lengths (30–90 days) while adding more ink. Only one measure is encoded on
 * the y-axis (watch time); play count rides along in the tooltip rather than
 * a second axis — dual-axis charts read as two different scales sharing one
 * baseline, which is the #1 chart-misread the dataviz skill calls out. One
 * series, so no legend box: the card title around this component names what
 * is plotted, per the skill's "a single series needs no legend" rule.
 *
 * Renders exactly one point per entry in `points`, zero-valued days
 * included: the API's `getWatchTimeSeries` deliberately zero-fills quiet
 * days with `generate_series` so a chart doesn't connect across a gap and
 * make a quiet week look busy. Dropping zero entries here would silently
 * reintroduce that gap-connecting distortion one layer up, so this component
 * must never filter `points` before handing them to the chart.
 */
export function WatchTimeChart({ points, loading }: WatchTimeChartProps) {
  if (loading) {
    return <Skeleton className="w-full" style={{ height: CHART_HEIGHT }} />;
  }

  if (points.length === 0) {
    return (
      <EmptyState
        title="No watch time yet"
        description="Nothing was played in the selected range."
        className="h-full"
      />
    );
  }

  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="watchTimeFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.18} />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="day"
          tickFormatter={formatDay}
          stroke="var(--border)"
          tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
          tickLine={false}
          minTickGap={24}
        />
        <YAxis
          tickFormatter={(value: number) => formatDuration(value)}
          stroke="var(--border)"
          tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <Tooltip
          content={(props) => <ChartTooltip {...props} />}
          cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
        />
        <Area
          type="monotone"
          dataKey="watchMs"
          stroke="var(--primary)"
          strokeWidth={2}
          fill="url(#watchTimeFill)"
          dot={{ r: 3, strokeWidth: 0, fill: "var(--primary)" }}
          activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--card)" }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
