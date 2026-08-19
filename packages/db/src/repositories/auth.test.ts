import { afterAll, describe, expect, it } from "vitest";
import { stopTestDatabase, withTestDatabase } from "../testing/harness.js";
import {
  bumpRateLimit,
  deleteExpiredRateLimits,
  deleteExpiredSessions,
  deleteSession,
  insertSession,
  selectLiveSession,
} from "./auth.js";

afterAll(stopTestDatabase);

const HOUR = 60 * 60 * 1000;

describe("session repository", () => {
  it("round-trips a live session", async () => {
    await withTestDatabase(async (db) => {
      const now = new Date("2026-08-18T12:00:00Z");
      await insertSession(db, {
        id: "sess-alpha",
        userId: "user-1",
        userName: "ada",
        isAdmin: true,
        createdAt: now,
        expiresAt: new Date(now.getTime() + HOUR),
      });

      const found = await selectLiveSession(db, "sess-alpha", now, new Date(now.getTime() + HOUR));
      expect(found).toEqual({ userId: "user-1", userName: "ada", isAdmin: true, createdAt: now });
    });
  });

  // isAdmin: true is the only value every other fixture in this file uses. Without
  // this case, a projection bug (wrong column) or a hard-coded `true` in the
  // RETURNING clause would pass the whole file.
  it("round-trips a non-admin session with isAdmin false", async () => {
    await withTestDatabase(async (db) => {
      const now = new Date("2026-08-18T12:00:00Z");
      await insertSession(db, {
        id: "sess-nonadmin",
        userId: "user-5",
        userName: "hopper",
        isAdmin: false,
        createdAt: now,
        expiresAt: new Date(now.getTime() + HOUR),
      });

      const found = await selectLiveSession(db, "sess-nonadmin", now, new Date(now.getTime() + HOUR));
      expect(found).toEqual({ userId: "user-5", userName: "hopper", isAdmin: false, createdAt: now });
    });
  });

  it("returns null for an unknown id", async () => {
    await withTestDatabase(async (db) => {
      const now = new Date("2026-08-18T12:00:00Z");
      expect(await selectLiveSession(db, "sess-nope", now, new Date(now.getTime() + HOUR))).toBeNull();
    });
  });

  // The row EXISTS and is expired. A fixture that never expires would let an
  // implementation that ignores expiresAt entirely pass this whole file.
  it("returns null for a row that exists but has expired", async () => {
    await withTestDatabase(async (db) => {
      const issued = new Date("2026-08-18T12:00:00Z");
      await insertSession(db, {
        id: "sess-stale",
        userId: "user-2",
        userName: "grace",
        isAdmin: true,
        createdAt: issued,
        expiresAt: new Date(issued.getTime() + HOUR),
      });

      const later = new Date(issued.getTime() + 2 * HOUR);
      expect(
        await selectLiveSession(db, "sess-stale", later, new Date(later.getTime() + HOUR)),
      ).toBeNull();
    });
  });

  // Sliding expiry: reading at T pushes the deadline out, so a read at
  // T + 89min still succeeds even though the original 1h deadline has passed.
  // (89, not 90: the new deadline is exactly midway + HOUR = issued + 90min, and
  // expiry is exclusive at the boundary — see the pinning test below for that edge.)
  it("pushes expiry forward on read, so an active session outlives its original deadline", async () => {
    await withTestDatabase(async (db) => {
      const issued = new Date("2026-08-18T12:00:00Z");
      await insertSession(db, {
        id: "sess-active",
        userId: "user-3",
        userName: "linus",
        isAdmin: true,
        createdAt: issued,
        expiresAt: new Date(issued.getTime() + HOUR),
      });

      const midway = new Date(issued.getTime() + 30 * 60 * 1000);
      await selectLiveSession(db, "sess-active", midway, new Date(midway.getTime() + HOUR));

      const past = new Date(issued.getTime() + 89 * 60 * 1000);
      expect(
        await selectLiveSession(db, "sess-active", past, new Date(past.getTime() + HOUR)),
      ).not.toBeNull();
    });
  });

  // Pins the written expiresAt to nextExpiresAt exactly, not to "something later
  // than before". An implementation that ignored nextExpiresAt and instead wrote a
  // far-future value (now + 10 years, or 'infinity') would still pass every other
  // test in this file, including the one above.
  it("writes exactly nextExpiresAt, not merely some later value", async () => {
    await withTestDatabase(async (db) => {
      const issued = new Date("2026-08-18T12:00:00Z");
      await insertSession(db, {
        id: "sess-pinned",
        userId: "user-6",
        userName: "ritchie",
        isAdmin: true,
        createdAt: issued,
        expiresAt: new Date(issued.getTime() + HOUR),
      });

      const midway = new Date(issued.getTime() + 30 * 60 * 1000);
      const nextExpiresAt = new Date(midway.getTime() + HOUR);
      await selectLiveSession(db, "sess-pinned", midway, nextExpiresAt);

      // One millisecond past the deadline just written must already be expired.
      const justAfter = new Date(nextExpiresAt.getTime() + 1);
      expect(
        await selectLiveSession(db, "sess-pinned", justAfter, new Date(justAfter.getTime() + HOUR)),
      ).toBeNull();
    });
  });

  it("destroys a session", async () => {
    await withTestDatabase(async (db) => {
      const now = new Date("2026-08-18T12:00:00Z");
      await insertSession(db, {
        id: "sess-bye",
        userId: "user-4",
        userName: "edsger",
        isAdmin: true,
        createdAt: now,
        expiresAt: new Date(now.getTime() + HOUR),
      });
      await deleteSession(db, "sess-bye");
      expect(await selectLiveSession(db, "sess-bye", now, new Date(now.getTime() + HOUR))).toBeNull();
    });
  });

  it("sweeps only expired rows", async () => {
    await withTestDatabase(async (db) => {
      const now = new Date("2026-08-18T12:00:00Z");
      await insertSession(db, {
        id: "keep",
        userId: "u",
        userName: "n",
        isAdmin: true,
        createdAt: now,
        expiresAt: new Date(now.getTime() + HOUR),
      });
      await insertSession(db, {
        id: "sweep",
        userId: "u",
        userName: "n",
        isAdmin: true,
        createdAt: now,
        expiresAt: new Date(now.getTime() - HOUR),
      });

      expect(await deleteExpiredSessions(db, now)).toBe(1);
      expect(await selectLiveSession(db, "keep", now, new Date(now.getTime() + HOUR))).not.toBeNull();
    });
  });
});

describe("rate limit repository", () => {
  it("counts attempts within one window", async () => {
    await withTestDatabase(async (db) => {
      const now = new Date("2026-08-18T12:00:00Z");
      expect(await bumpRateLimit(db, "ip-a", now, HOUR)).toBe(1);
      expect(await bumpRateLimit(db, "ip-a", now, HOUR)).toBe(2);
      expect(await bumpRateLimit(db, "ip-a", now, HOUR)).toBe(3);
    });
  });

  it("keeps separate keys separate", async () => {
    await withTestDatabase(async (db) => {
      const now = new Date("2026-08-18T12:00:00Z");
      await bumpRateLimit(db, "ip-b", now, HOUR);
      await bumpRateLimit(db, "ip-b", now, HOUR);
      expect(await bumpRateLimit(db, "ip-c", now, HOUR)).toBe(1);
    });
  });

  // The window is FIXED, not sliding: later attempts inside the window must not
  // push the window's start forward. If they did, a steady stream of attempts
  // would never trip the limit.
  it("does not slide the window when attempts continue inside it", async () => {
    await withTestDatabase(async (db) => {
      const start = new Date("2026-08-18T12:00:00Z");
      await bumpRateLimit(db, "ip-d", start, HOUR);
      const later = new Date(start.getTime() + 50 * 60 * 1000);
      expect(await bumpRateLimit(db, "ip-d", later, HOUR)).toBe(2);

      // 61 minutes after the ORIGINAL start — past the window even though an
      // attempt happened 11 minutes ago.
      const afterWindow = new Date(start.getTime() + 61 * 60 * 1000);
      expect(await bumpRateLimit(db, "ip-d", afterWindow, HOUR)).toBe(1);
    });
  });

  it("sweeps only rows whose window started before the cutoff", async () => {
    await withTestDatabase(async (db) => {
      const old = new Date("2026-08-16T12:00:00Z");
      const recent = new Date("2026-08-18T11:00:00Z");
      await bumpRateLimit(db, "ip-old", old, HOUR);
      await bumpRateLimit(db, "ip-recent", recent, HOUR);

      const cutoff = new Date("2026-08-18T00:00:00Z");
      expect(await deleteExpiredRateLimits(db, cutoff)).toBe(1);

      // The swept key is gone: a fresh bump starts back at 1 rather than
      // continuing the old row's count.
      expect(await bumpRateLimit(db, "ip-old", recent, HOUR)).toBe(1);
      // The untouched key kept accumulating from where it left off.
      expect(await bumpRateLimit(db, "ip-recent", recent, HOUR)).toBe(2);
    });
  });

  // A row exactly AT the cutoff must survive — "older than", not
  // "at or older than". A `lte` instead of `lt` would delete it and this
  // test would see a fresh count of 1 instead of 2.
  it("keeps a row whose window started exactly at the cutoff", async () => {
    await withTestDatabase(async (db) => {
      const cutoff = new Date("2026-08-18T00:00:00Z");
      await bumpRateLimit(db, "ip-boundary", cutoff, HOUR);

      expect(await deleteExpiredRateLimits(db, cutoff)).toBe(0);
      expect(await bumpRateLimit(db, "ip-boundary", cutoff, HOUR)).toBe(2);
    });
  });
});
