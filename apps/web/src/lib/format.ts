export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Takes an inclusive `YYYY-MM-DD` calendar day. Deliberately does not go through
 * `new Date(day)` and local-time formatting — that shifts the day backwards in
 * any negative UTC offset, so a chart's first column would silently be labelled
 * with the previous date.
 */
export function formatDay(day: string): string {
  const [, month, date] = day.split("-");
  const monthIndex = Number(month) - 1;
  return `${Number(date)} ${MONTHS[monthIndex] ?? "?"}`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-GB").format(n);
}

/** Takes a 0-1 fraction (e.g. `COMPLETION_THRESHOLD`) and renders it as a
 * rounded whole-number percentage, so a settings screen never has to show a
 * raw fraction like "0.9" to a human. */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
