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

export interface EpisodeContext {
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

/**
 * Renders the series/season/episode line that sits above an episode's own name,
 * e.g. `"The Bear · S2E5"`. Returns `null` when there is nothing to show, so a
 * caller can drop the line entirely rather than render an empty element.
 *
 * Every part is optional and rendered independently: Jellyfin leaves the
 * numbering off specials and extras, and episodes ingested before the
 * `series_name`/`season_number`/`episode_number` columns existed carry none of
 * the three until the next full item sync backfills them. Season 0 is a real
 * value (Jellyfin's specials season), so the checks are `!== null`, never
 * truthiness — `S0E3` must not collapse to `E3`.
 */
export function formatEpisodeLabel({
  seriesName,
  seasonNumber,
  episodeNumber,
}: EpisodeContext): string | null {
  const parts: string[] = [];
  if (seriesName !== null && seriesName !== "") parts.push(seriesName);

  const season = seasonNumber !== null ? `S${seasonNumber}` : "";
  const episode = episodeNumber !== null ? `E${episodeNumber}` : "";
  if (season !== "" || episode !== "") parts.push(`${season}${episode}`);

  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * A full ISO timestamp as a date and a 12-hour clock time, e.g.
 * `"1 Jan, 8:15 PM"`. Used by the history table's Started column and the
 * dashboard's activity feed, where the day alone left two sessions hours apart
 * looking identical.
 *
 * Rendered in the **viewer's local timezone**, which is the opposite of what
 * `formatDay` above does — and deliberately so. `formatDay` takes a
 * `YYYY-MM-DD` bucket label that is already a UTC calendar day and must not be
 * shifted by an hour of local offset; this takes an instant, and the only
 * useful answer to "when did this play" is the wall-clock time where the
 * person reading it lives.
 *
 * One consequence worth knowing: the history range filter selects by UTC day,
 * so a session near midnight UTC can render with a local date just outside the
 * range that fetched it. That is correct on both counts rather than a bug — the
 * row really did fall in the requested UTC day, and it really did play at the
 * local time shown.
 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  const hours24 = date.getHours();
  // Midnight and noon are the two the modulo alone gets wrong: 0 % 12 and
  // 12 % 12 are both 0, which would print "0:30 AM" rather than "12:30 AM".
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const meridiem = hours24 < 12 ? "AM" : "PM";
  const minutes = String(date.getMinutes()).padStart(2, "0");

  // The hour is not zero-padded — "8:15 PM", not "08:15 PM" — which is the
  // convention for a 12-hour clock. Minutes still are, since "8:5 PM" is not.
  return `${date.getDate()} ${MONTHS[date.getMonth()] ?? "?"}, ${hours12}:${minutes} ${meridiem}`;
}

/**
 * A calendar day (`YYYY-MM-DD`) with its year — "17 May 2019" — for dates
 * where the year is the point, like a release date. Like `formatDay`, this
 * is string slicing rather than `Date` construction: the input is a
 * calendar date, not an instant, and must never shift across a timezone.
 */
export function formatFullDate(day: string): string {
  const [year, month, date] = day.split("-");
  const monthIndex = Number(month) - 1;
  return `${Number(date)} ${MONTHS[monthIndex] ?? "?"} ${year}`;
}

const TICKS_PER_MS = 10_000;

/** Jellyfin reports positions and runtimes in 100-nanosecond ticks. */
export function ticksToMs(ticks: number): number {
  return ticks / TICKS_PER_MS;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * "12 min ago" / "3 h ago" / "2 days ago" for a past instant, relative to
 * `now` — for "last synced" style status lines where the reader wants
 * staleness at a glance, not a wall-clock time. Under a minute is "just
 * now"; the input is a full ISO timestamp, so unlike `formatDay` this one
 * does go through `Date`.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";

  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;

  const days = Math.floor(elapsed / DAY_MS);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
