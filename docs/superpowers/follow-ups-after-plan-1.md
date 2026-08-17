# Follow-ups carried out of Plan 1

Recorded at the end of the foundation and data pipeline branch. Everything here was found by
review, consciously deferred, and judged non-blocking for merge. Ordered by value.

## Worth doing early in Plan 2

1. **Give `sessionSchema` some required fields.** `packages/jellyfin/src/schemas.ts` currently
   makes every field optional, so a wholesale Jellyfin field rename degrades to "0 active
   sessions" with no error rather than failing loudly. `Id` and `NowPlayingItem.Id` at minimum.
   This is the highest-value deferred item: it is the same silent-failure shape as the
   `PlaySessionId` defect, and a Jellyfin upgrade is exactly when it bites.

2. **Periodic reconciliation, not just at boot.** `reconcileOpenSessions` runs once in the
   worker's `main()`. A session orphaned while the process stays up — a Redis snapshot expiring
   past its 3600s TTL during a long pause, for instance — is never repaired until restart. A
   daily reconcile job closes that.

3. **Decide `libraries.item_count`'s fate.** `runReferenceSync` never populates it, so
   `excluded.item_count` is 0 on every upsert and the column is permanently zero. Populate it
   during `item-sync` (per-library counts are already in hand) or drop the column — before a UI
   is built on top of a number that is structurally always 0.

4. **Harden partial-library archival.** `getItems` concatenates per-library results, so if one
   library returns zero items while others succeed, the combined list is non-empty, the
   empty-list guard passes, and every item in that library gets archived. Contained today
   (`archived` isn't read yet, and the next successful sync un-archives), but must be fixed
   before anything filters on `archived`.

5. **Document the production runtime honestly.** `dev:worker` is a foreground `tsx` process
   with no supervision or restart policy, and there is no Dockerfile for the worker yet. Plan 3
   adds the production image; until then the README should say plainly that the worker dies
   with the terminal.

## Smaller cleanups

6. **Dead code.** `PACKAGE_NAME` in `packages/shared/src/index.ts` (a scaffold constant still in
   the public API, with a test asserting it equals itself) and `findItemsByIds` in
   `packages/db/src/repositories/reference.ts` (zero callers, untested). Delete both.

7. **`packages/db` declares `@jfstats/shared`** but imports nothing from it. Drop the dependency
   and the project reference.

8. **`archiveMissingItems` returns a count** of all rows matching the `WHERE`, including
   already-archived ones, so it over-reports "newly archived" every cycle. No caller reads it
   today.

9. **`JellyfinItem.libraryId` is typed `string | null`** though it can no longer be null in
   practice — `getItems` always assigns the queried library's id.

10. **`main()` has no `closeContext` on setup failure**, and `shutdown()` has no error handling,
    so a rejected `worker.close()` skips `process.exit` and can hang past the signal until
    Docker's SIGKILL.

11. **`worker.ts`'s entrypoint guard** is `process.argv[1]?.endsWith("worker.ts")`, so the
    compiled `dist/worker.js` exits 0 without starting anything. Harmless today (every
    documented path is `tsx src/worker.ts`) but a trap for Plan 3's production image.
    `backfill.ts` inherits the same shape.

12. **Test ergonomics.** No direct test for the `resumed` event variant — the only `SessionEvent`
    variant with zero coverage. No fixture covers `PlayState` itself being null mid-transition.
    No test for the env formatter's multi-error path. `pipeline.test.ts` casts a stub `as never`
    where a `Pick<JellyfinClient, "getSessions">` shape would avoid it.

13. **Testcontainers harness** opens and closes a fresh `pg.Pool` per `withTestDatabase` call.
    Test-only cost, but it grows with the suite.

## Accepted, not deferred

**The `diffSessions` reducer has no TDD RED/GREEN evidence.** Its implementer was terminated by
a session limit immediately after committing. The substantive risk — a test weakened to make a
broken implementation pass — was closed by confirming all 15 committed tests are byte-identical
to the plan's originals. Not reconstructable without reverting the implementation, and judged
not worth doing for a pure function whose tests were independently read and found substantive.

## The lesson worth carrying forward

Every functional defect in Plan 1 came from the same place: **an assumption about a real system,
encoded into a hand-written fixture, which then confirmed that assumption forever.** The pure
logic — the diff reducer, the config parser — was clean from the first commit.

- `/Sessions` returns no `PlaySessionId` → the pipeline would have recorded nothing, ever.
- An item's `ParentId` is its season, not its library → per-library stats silently empty.
- A stream stays paused across polls while reporting the transition once → paused streams shown
  as playing.
- Rollup day attribution differed between the two write paths → cross-midnight streams counted
  on different days.
- `recomputeRollupRange` counted open sessions as plays; reconciliation counted none.

None of these were caught by unit tests. All were caught by running against a real Jellyfin
server and a real database, or by a review tracing two code paths against each other.

**For Plan 2 and Plan 3: verify against the real thing before code depends on its shape, and
when two paths must agree, write the test that compares them rather than testing each alone.**
See the spec's "Verified behavior of the real Jellyfin API" section for what 10.11.11 actually
returns.
