import { sessions as sessionsTable, type Db } from "@jfstats/db";
import { stopTestDatabase, withTestDatabase } from "@jfstats/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createSessionStore } from "./sessions.js";

// Wraps the real randomBytes rather than replacing it, so every test still
// gets genuine entropy — this only adds the ability to assert it was called
// and to pin its output for one test below. Declared file-wide (via
// vi.hoisted, since vi.mock itself is hoisted above imports) because a
// per-test vi.spyOn is not an option here: node:crypto's own exports are not
// configurable/writable in this runtime ("Cannot redefine property:
// randomBytes"). Typed explicitly to the single-argument, Buffer-returning
// overload actually used in sessions.ts — node:crypto's randomBytes is
// overloaded with a callback form that returns void, and letting inference
// pick that up here would make mockReturnValueOnce(Buffer) a type error.
const { randomBytesMock } = vi.hoisted(() => ({
  randomBytesMock: vi.fn<(size: number) => Buffer>(),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  randomBytesMock.mockImplementation(actual.randomBytes);
  return { ...actual, randomBytes: randomBytesMock };
});

afterAll(stopTestDatabase);

const RECORD = { userId: "u-1", userName: "admin", isAdmin: true, createdAt: 1_777_000_000_000 };

async function readExpiresAt(db: Db, id: string): Promise<Date | null> {
  const rows = await db
    .select({ expiresAt: sessionsTable.expiresAt })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, id));
  return rows[0]?.expiresAt ?? null;
}

describe("session store", () => {
  it("round-trips a session by its id", async () => {
    await withTestDatabase(async (db) => {
      const store = createSessionStore(db);

      const id = await store.create(RECORD);

      expect(await store.get(id)).toEqual(RECORD);
    });
  });

  it("issues unguessable ids", async () => {
    await withTestDatabase(async (db) => {
      const store = createSessionStore(db);

      const a = await store.create(RECORD);
      const b = await store.create(RECORD);

      expect(a).not.toBe(b);
      // 32 random bytes, base64url encoded.
      expect(a.length).toBeGreaterThanOrEqual(43);
      expect(a).not.toContain(RECORD.userId);
      expect(Buffer.from(a, "base64url")).toHaveLength(32);

      // No two of a larger batch share a leading prefix. This catches a
      // *sequential* or *directly concatenated* derivation (e.g. userId plus a
      // literal counter or timestamp).
      //
      // It does NOT catch every predictable scheme, and should not be read as
      // proof of unguessability on its own: a cryptographic hash of guessable
      // inputs — e.g. sha256(userId + counter) — is also 32 bytes decoded, also
      // passes every check above, and (verified directly against this exact
      // scheme while proving this test) also clears the no-shared-prefix check
      // below, because a secure hash's output is designed to be
      // indistinguishable from random for distinct inputs. No black-box
      // statistical test on the output alone can close that gap — see the
      // "actually calls a CSPRNG" test below, which pins the real guarantee.
      const ids = await Promise.all(Array.from({ length: 20 }, () => store.create(RECORD)));
      const prefixes = ids.map((id) => id.slice(0, 8));
      expect(new Set(prefixes).size).toBe(prefixes.length);
    });
  });

  it("derives ids from crypto.randomBytes(32), not from anything computable from the record", async () => {
    await withTestDatabase(async (db) => {
      const store = createSessionStore(db);
      const fixedEntropy = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
      randomBytesMock.mockReturnValueOnce(fixedEntropy);

      const id = await store.create(RECORD);

      // Structural, not statistical: the id must be the CSPRNG's own output,
      // not a further transform of it (which could reintroduce a dependency on
      // the record). This is what actually rules out a scheme like
      // sha256(userId + counter) — that scheme never calls randomBytes(32) to
      // produce the id at all, so this assertion fails under it even though
      // every black-box statistical check above passes.
      expect(randomBytesMock).toHaveBeenLastCalledWith(32);
      expect(id).toBe(fixedEntropy.toString("base64url"));
    });
  });

  it("returns null for an unknown id", async () => {
    await withTestDatabase(async (db) => {
      const store = createSessionStore(db);

      expect(await store.get("not-a-real-session-id")).toBeNull();
    });
  });

  it("returns null after destroy, so logout actually revokes", async () => {
    await withTestDatabase(async (db) => {
      const store = createSessionStore(db);
      const id = await store.create(RECORD);

      await store.destroy(id);

      expect(await store.get(id)).toBeNull();
    });
  });

  it("slides the expiry on read so an active admin is not logged out", async () => {
    await withTestDatabase(async (db) => {
      const store = createSessionStore(db, 100);
      const id = await store.create(RECORD);
      // Force the row to look like it is about to expire, the same way the old
      // Redis version of this test forced a short TTL with `redis.expire`.
      await db
        .update(sessionsTable)
        .set({ expiresAt: new Date(Date.now() + 5_000) })
        .where(eq(sessionsTable.id, id));

      await store.get(id);

      const expiresAt = await readExpiresAt(db, id);
      expect(expiresAt).not.toBeNull();
      expect(expiresAt?.getTime()).toBeGreaterThan(Date.now() + 50_000);
    });
  });
});
