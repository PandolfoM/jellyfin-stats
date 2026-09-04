import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  formatCount,
  formatDateTime,
  formatDay,
  formatDuration,
  formatEpisodeLabel,
  formatPercent,
  formatFullDate,
  formatRelativeTime,
  ticksToMs,
} from "./format";

describe("formatDuration", () => {
  it("renders hours and minutes above an hour", () => {
    expect(formatDuration(8_040_000)).toBe("2h 14m");
  });

  it("renders minutes only below an hour", () => {
    expect(formatDuration(2_820_000)).toBe("47m");
  });

  it("renders seconds below a minute, so a short sample is not just '0m'", () => {
    expect(formatDuration(38_000)).toBe("38s");
  });

  it("renders zero as 0m rather than an empty string", () => {
    expect(formatDuration(0)).toBe("0m");
  });

  it("omits a zero minute component", () => {
    expect(formatDuration(7_200_000)).toBe("2h");
  });

  it("does not produce a negative duration from a negative input", () => {
    expect(formatDuration(-5_000)).toBe("0m");
  });
});

describe("formatDay", () => {
  // Pinned to a negative-UTC-offset zone so this suite's timezone-boundary
  // guard is deterministic. Without a pinned TZ, a regression to
  // `new Date(day)` + local-time reads would pass silently on any
  // UTC-or-positive-offset machine — which is what most CI runners default
  // to — even though it fails on machines west of Greenwich.
  beforeAll(() => {
    vi.stubEnv("TZ", "America/Los_Angeles");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("renders an ISO day as a short human date", () => {
    expect(formatDay("2026-08-16")).toBe("16 Aug");
  });

  it("does not shift the day across a timezone boundary", () => {
    // Parsing "2026-01-01" as local time in a negative-offset zone yields
    // 31 Dec. The formatter must treat the string as a calendar date.
    expect(formatDay("2026-01-01")).toBe("1 Jan");
  });
});

describe("formatCount", () => {
  it("separates thousands", () => {
    expect(formatCount(12_345)).toBe("12,345");
  });

  it("leaves small numbers alone", () => {
    expect(formatCount(7)).toBe("7");
  });
});

describe("formatPercent", () => {
  it("renders a 0-1 fraction as a rounded whole-number percentage", () => {
    expect(formatPercent(0.9)).toBe("90%");
  });

  it("rounds rather than truncates", () => {
    // 0.905 * 100 = 90.5 — truncation would give "90%"; rounding gives "91%".
    expect(formatPercent(0.905)).toBe("91%");
  });

  it("renders the 0 and 1 boundaries", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(1)).toBe("100%");
  });
});

describe("formatEpisodeLabel", () => {
  it("joins the series name with the season and episode numbers", () => {
    expect(formatEpisodeLabel({ seriesName: "The Bear", seasonNumber: 2, episodeNumber: 5 })).toBe(
      "The Bear · S2E5",
    );
  });

  it("keeps season 0 rather than dropping it, since specials really are season 0", () => {
    // A truthiness check on seasonNumber would render this as "E3" and imply
    // it belongs to whatever season the rows around it are from.
    expect(formatEpisodeLabel({ seriesName: "The Bear", seasonNumber: 0, episodeNumber: 3 })).toBe(
      "The Bear · S0E3",
    );
  });

  it("renders the series alone when Jellyfin sent no numbering", () => {
    expect(
      formatEpisodeLabel({ seriesName: "The Bear", seasonNumber: null, episodeNumber: null }),
    ).toBe("The Bear");
  });

  it("renders the numbering alone when the series name is missing", () => {
    expect(formatEpisodeLabel({ seriesName: null, seasonNumber: 2, episodeNumber: 5 })).toBe(
      "S2E5",
    );
  });

  it("renders a half-numbered episode without a stray separator", () => {
    expect(formatEpisodeLabel({ seriesName: null, seasonNumber: null, episodeNumber: 5 })).toBe(
      "E5",
    );
    expect(formatEpisodeLabel({ seriesName: null, seasonNumber: 2, episodeNumber: null })).toBe(
      "S2",
    );
  });

  it("returns null when there is no episode context at all, so callers can omit the line", () => {
    expect(
      formatEpisodeLabel({ seriesName: null, seasonNumber: null, episodeNumber: null }),
    ).toBeNull();
    // An empty string is not a name worth a line of its own either.
    expect(
      formatEpisodeLabel({ seriesName: "", seasonNumber: null, episodeNumber: null }),
    ).toBeNull();
  });
});

describe("formatDateTime", () => {
  // Pinned so the assertions below are about the formatter, not about wherever
  // the suite happens to run. UTC+0 keeps the expected strings readable; the
  // local-offset behaviour gets its own test underneath.
  beforeAll(() => {
    vi.stubEnv("TZ", "UTC");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("renders the date and a 12-hour clock time", () => {
    expect(formatDateTime("2026-01-01T20:15:00.000Z")).toBe("1 Jan, 8:15 PM");
  });

  it("zero-pads the minutes but not the hour, as a 12-hour clock does", () => {
    expect(formatDateTime("2026-03-09T04:05:00.000Z")).toBe("9 Mar, 4:05 AM");
  });

  it("renders midnight as 12 AM, not 0 AM", () => {
    // `hours % 12` is 0 at midnight, so a naive conversion prints "0:30 AM".
    expect(formatDateTime("2026-01-01T00:30:00.000Z")).toBe("1 Jan, 12:30 AM");
  });

  it("renders noon as 12 PM, not 0 PM", () => {
    // The same modulo trap at the other end, and the boundary where the
    // meridiem flips: 12:00 is PM, 11:59 is AM.
    expect(formatDateTime("2026-01-01T12:00:00.000Z")).toBe("1 Jan, 12:00 PM");
    expect(formatDateTime("2026-01-01T11:59:00.000Z")).toBe("1 Jan, 11:59 AM");
  });

  it("distinguishes two sessions on the same day", () => {
    // The whole point of the change: the previous formatter rendered both of
    // these as "1 Jan" and made a busy day look like one long session.
    expect(formatDateTime("2026-01-01T09:00:00.000Z")).not.toBe(
      formatDateTime("2026-01-01T21:30:00.000Z"),
    );
  });

  it("returns a placeholder rather than 'Invalid Date' for an unparseable value", () => {
    expect(formatDateTime("not-a-timestamp")).toBe("—");
  });
});

describe("formatDateTime in a non-UTC timezone", () => {
  // The behaviour that distinguishes this from `formatDay`: an instant is
  // converted to the reader's wall clock, not printed in UTC. Pinned to a
  // negative offset because that is the direction that also rolls the *date*
  // back a day, which is the case most likely to be got wrong.
  beforeAll(() => {
    vi.stubEnv("TZ", "America/New_York");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("renders the local wall-clock time, not the UTC time", () => {
    // 20:15 UTC is 15:15 EST on this date.
    expect(formatDateTime("2026-01-01T20:15:00.000Z")).toBe("1 Jan, 3:15 PM");
  });

  it("rolls the date back when the local offset crosses midnight", () => {
    // 02:30 UTC on 2 Jan is still 21:30 on 1 Jan in New York. Printing the UTC
    // date beside a local time would show "2 Jan, 21:30" — a timestamp that
    // never existed.
    expect(formatDateTime("2026-01-02T02:30:00.000Z")).toBe("1 Jan, 9:30 PM");
  });
});

describe("formatFullDate", () => {
  it("renders a YYYY-MM-DD day with its year, for release dates", () => {
    expect(formatFullDate("2019-05-17")).toBe("17 May 2019");
  });

  it("does not shift the day across a timezone — the input is a calendar date", () => {
    expect(formatFullDate("2023-01-01")).toBe("1 Jan 2023");
  });
});

describe("ticksToMs", () => {
  it("converts Jellyfin's 100ns ticks to milliseconds", () => {
    expect(ticksToMs(72_000_000_000)).toBe(7_200_000);
  });
});

describe("formatRelativeTime", () => {
  const NOW = Date.parse("2026-09-04T12:00:00Z");

  it("renders seconds-old instants as 'just now'", () => {
    expect(formatRelativeTime("2026-09-04T11:59:40Z", NOW)).toBe("just now");
  });

  it("renders minutes, hours, and days ago", () => {
    expect(formatRelativeTime("2026-09-04T11:48:00Z", NOW)).toBe("12 min ago");
    expect(formatRelativeTime("2026-09-04T09:00:00Z", NOW)).toBe("3 h ago");
    expect(formatRelativeTime("2026-09-02T12:00:00Z", NOW)).toBe("2 days ago");
  });

  it("uses the singular for exactly one day", () => {
    expect(formatRelativeTime("2026-09-03T12:00:00Z", NOW)).toBe("1 day ago");
  });

  it("returns a dash for an unparseable instant", () => {
    expect(formatRelativeTime("not a date", NOW)).toBe("—");
  });
});
