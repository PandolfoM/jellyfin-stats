# Follow-ups carried out of Plan 2

Recorded at the end of the API and authentication branch. Everything here was found by
review, consciously deferred, and judged non-blocking for merge. Ordered by value.

Plan 1's own list is in [`follow-ups-after-plan-1.md`](./follow-ups-after-plan-1.md) and is
still open except where Plan 2 closed an item in passing.

## Worth doing early in Plan 3

1. **Per-user session revocation.** Every login mints a fresh session id and overwrites the
   cookie, but the previous record stays valid in Redis for its full sliding TTL (default 7
   days), and `destroy` only ever takes the id in the caller's own cookie. "Log in again" is
   the intuitive response to a suspected stolen cookie and currently accomplishes nothing.
   A `jfstats:usersessions:<userId>` set indexed on login would fix it, and the UI will want
   a "sign out everywhere" affordance anyway.

2. **Move the image fetch into `packages/jellyfin`.** `createImageFetcher` in
   `apps/server/src/api/app.ts` builds a Jellyfin URL path and the
   `MediaBrowser Token="..."` header directly in the app layer, duplicating conventions that
   live in `packages/jellyfin/src/client.ts` and bypassing its injectable `fetch` seam. The
   code is correct and well defended — this is boundary erosion, not a bug — but it should be
   restored before Plan 3 adds more Jellyfin-shaped calls. A `getItemImage(itemId, { tag,
   maxWidth })` method on `JellyfinClient` closes it.

3. **`LiveDeps.subscribe` depends on an unenforced contract.** `live.ts` calls its cleanup
   without a local `.catch()`, which is safe only because the single production `subscribe`
   implementation swallows `quit()` rejections internally. That is deliberate — a local catch
   would make the regression test unable to fail — and the contract is documented on the
   interface and pinned by a test composing the real closure. But a second implementation
   (Plan 3 fixtures, an in-memory bus) that rejects would silently reintroduce a process kill.
   The type system does not prevent it.

4. **Give the history route its own test file.** The repository is thoroughly covered; the
   route's own clamp and query-parameter passthrough are not. Batch the other deferred
   coverage gaps into the same commit: the `getLibraryStats` archived filter, and the
   `name ASC` tiebreaks in `getUserStats` / `getLibraryStats`.

## Smaller cleanups

5. **`rate-limit.ts` would throw on a `[null]` reply.** `incr === undefined` does not catch a
   `null` element, so `incr[0]` would raise a `TypeError` that surfaces as a 500. Outside
   ioredis's declared `exec()` type and still fail-closed (the login is refused), so it is a
   robustness nit rather than a bypass. `incr == null` closes it.

6. **`sessions.get()` wraps both `JSON.parse` and the subsequent `redis.expire` in one
   try/catch**, so a transient expire failure silently presents as logged-out. Marginally
   worse than it first appears: the resulting 401 does not clear the cookie, so the browser
   keeps presenting a still-live id. It self-heals on the next request.

7. **`getUserDetail` does not filter archived users** while `getUserStats` does. Defensible
   for a lookup by explicit id, but the asymmetry is undocumented.

8. **The fallback admin compares credentials with `===`**, which is not constant-time.
   Practically negligible over HTTP behind a 10-per-15-minute limiter on a single-admin
   self-hosted tool, but `timingSafeEqual` costs nothing if that block is touched.

9. **Test-harness sensitivities worth knowing when triaging a flake.** `live.test.ts`
   installs a process-wide `unhandledRejection` listener and asserts it stays empty — an
   unrelated rejection from a co-located test file in the same worker would land there.
   `api.test.ts` uses wall-clock bounds (750 ms) that are not a large margin under
   testcontainer contention, and its `afterEach` can hang on a still-attached stream, masking
   the real assertion error behind a hook timeout. One unexplained single-test flake was
   observed once during the final fix wave and did not recur across fourteen subsequent runs.

10. **BullMQ's internally-duplicated connections** still rely on `queue.on("error")` /
    `worker.on("error")` rather than the shared `attachRedisErrorLogger`. Covered in practice,
    just not by the same mechanism.

11. **A narrow shutdown race the timeout correctly covers.** A keep-alive socket accepted
    before `server.close()` could open a new SSE stream after `closeAll()` has run;
    `closeApiServer` does not re-check, so that request holds the close open until the
    5-second backstop fires and exits non-zero. Very unlikely, and the backstop behaves as
    designed — but it is the one case where the timeout is not merely decorative.

## What Plan 2 confirmed about this codebase's failure modes

Plan 1's lesson was that **assumptions about a real system, encoded into a hand-written
fixture, confirm themselves forever.** Plan 2 reproduced that pattern once — `db.execute()`
returns timestamp columns as strings, not `Date` objects, unlike `db.select()`, which would
have made `HistoryRow.startedAt` a string wearing a `Date` type — and added a second, sharper
one:

**A test that would pass with the behavior removed is worse than no test, because it
advertises protection that does not exist.** This was the single most common finding class
across the plan. Instances caught:

- A history limit clamp asserted against a 5-row fixture while requesting 100,000.
- A library filter test whose fixture contained only one library, so nothing could be excluded.
- A pagination test that detected overlap but not skips.
- A `revokeToken` failure test using a resolved 500 response, when `fetch` does not throw on
  non-2xx — it would have passed with the `try/catch` deleted entirely.
- A "survives a Redis hiccup" test asserting a status that `streamSSE` returns before the
  callback even runs.
- An assertion reading `mock.calls[0][2]` on a two-argument function — always `undefined`.
- A `getTopItems` tiebreak test that passed because Postgres happened to return name order
  anyway. **This one was caught by the implementer in its own work, during a deliberate red
  probe.**

The habit that catches these: after writing an assertion, ask what you would have to break for
it to go red. If the answer is "nothing," the test is not finished. Where a fix rests on a
guarantee, prove it — delete the guarantee, watch the test fail, restore it.

Two security defects were also found, both of which looked fine and were not:

- The login rate limiter keyed on `X-Forwarded-For`, which any client can set, so an attacker
  got a fresh bucket per request; and with no proxy, every legitimate admin shared one bucket.
- The image proxy interpolated an unencoded item id into the upstream URL, so
  `..%2F..%2FUsers%23` redirected a request **carrying the Jellyfin admin API key** to an
  arbitrary endpoint. The implementer flagged the unencoded id and rated it harmless; the
  independent assessment is what established it was not.

**For Plan 3:** verify against the real thing before code depends on its shape; when two paths
must agree, write the test that compares them rather than testing each alone; and when a value
crosses into a URL, a query, or a shell, the safety property is not "same host" — it is what
the credential attached to the request can do at the destination.
