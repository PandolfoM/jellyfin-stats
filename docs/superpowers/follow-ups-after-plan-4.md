# Follow-ups carried out of Plan 4

Recorded at the end of the single-service deployment branch. Everything here was found by
review or by the end-to-end verification in Task 10, consciously deferred, and judged
non-blocking for merge. Ordered by value.

Plan 1's list is in [`follow-ups-after-plan-1.md`](./follow-ups-after-plan-1.md), Plan 2's in
[`follow-ups-after-plan-2.md`](./follow-ups-after-plan-2.md), and Plan 3's in
[`follow-ups-after-plan-3.md`](./follow-ups-after-plan-3.md); all three are still open except
where a later plan closed an item in passing. Plan 4 closed Plan 3 item 4 in passing —
`REDIS_URL`/`REDIS_PORT` are gone, so there is no longer a Redis connection string for
`/api/settings` to disclose — but the underlying question (an internal `JELLYFIN_URL` reaching
an authenticated admin's browser) is unchanged and still open.

## Worth doing early

1. **`logger.ts`'s redaction covers structured fields, not text embedded in an error message.**
   `redact.paths` (`apiKey`, `JELLYFIN_API_KEY`, `*.apiKey`, `headers.authorization`,
   `headers.Authorization`) matches object paths — fast-redact walks the logged object's shape
   and blanks out fields at those exact paths. It cannot reach into a string value and redact a
   substring, so a connection string that ends up *inside* `Error.message` or `Error.stack`
   prints verbatim. Verified directly: logging a synthetic
   `new Error("connection failed: postgres://user:secretpass@host:5432/db")` through
   `createLogger` prints the password in clear text in both `err.message` and `err.stack`.
   This matters because `main.ts`'s startup-failure handler now routes every unhandled startup
   rejection through the logger specifically to keep it on the redaction path (see the comment
   above `catch (error)` in `main()`) — and a `pg` connection failure is exactly the kind of
   error whose message can echo the connection string back. Practical risk is low: `pg`'s own
   connection errors normally read as `"connection refused"` or `"password authentication failed
   for user \"jfstats\""`, not as the URI itself, so `DATABASE_URL`'s password reaching a log
   line would need `pg` (or a future caller) to construct an error that embeds the URL, which
   isn't what's observed today. Still a real gap: `redact.censor` has no text-scanning
   counterpart in `pino`/`fast-redact`, so closing it needs either a `serializers.err` that
   strips `postgres://…@` patterns from `message`/`stack` before they reach the redactor, or
   accepting the residual risk explicitly. Worth a conscious decision before this pattern gets
   copied to a second startup-failure path.

2. **The vitest `projects` split was attempted and failed twice; recovering the lost wall clock
   is still open.** `vitest.config.ts` runs the whole suite at `fileParallelism: false` because
   the ~10 files that start a real Postgres container (via
   `packages/db/src/testing/harness.ts`, which caches one container per worker *process*) starve
   Docker/Ryuk when vitest's default one-worker-per-CPU parallelism starts several at once —
   reproduced directly as nondeterministic `Test timed out in 15000ms` failures on container
   startup, never a real assertion failure. A `vitest.workspace.ts` split (a "db" project
   serialized, an "unit" project at full parallelism for the ~400 pure tests) was tried first and
   failed for two concrete, non-theoretical reasons: `extends` concatenates array fields like
   `test.include` rather than replacing them, so the first attempt's "db" project silently ran
   the *entire* suite; and after fixing that with an explicit, non-extending `test` block per
   project, the "unit" project's full-CPU parallelism still starved the "db" project's single
   worker of scheduling time while its containers tried to start, reproduced with a real
   `pnpm test` run producing 4 container-start timeouts. The blanket `fileParallelism: false`
   fallback is deterministic — two consecutive full runs green at the current 575/66 — but the
   cost is real: wall clock went from **~25–30s** (the flaky default-parallel run, when it
   happened to pass) to **~119s**. Worker-count tuning (e.g. capping
   `poolOptions.threads.maxThreads` on a would-be "unit" project, or reusing one Postgres
   container across the container-backed files instead of one per worker) would likely recover
   most of that gap without reintroducing the flake, but was not chased — the fix that shipped
   optimized for a suite that never fails randomly, not for the fastest suite that usually
   passes. Whoever picks this up should start from what's already known not to work, documented
   in `vitest.config.ts` itself, rather than re-attempting the same split blind.

3. **The scheduler's daily-job DST fallback is proven correct in only one direction, and its
   month/year-boundary arithmetic is untested in either.** `schedule.test.ts` pins the
   spring-forward transition explicitly (`isDue` must use calendar arithmetic —
   `new Date(y, m, d-1, h, min)` — not fixed-24h subtraction, or the "yesterday's target"
   fallback lands an hour off across the missing hour) but has no equivalent case for
   fall-back, where the local day is 25 hours long instead of 23 and a fixed-offset approach
   would fail in the opposite direction. Separately, `mostRecentDailyTarget`'s fallback
   (`new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, hour, minute, 0, 0)`) relies on
   the `Date` constructor's own day/month/year underflow handling — day 1 minus 1 rolls into the
   last day of the previous month, and month 0 (January) rolls into December of the previous
   year — which is standard, well-defined `Date` behavior but has no test pinning it for this
   codebase specifically. A boundary case (a missed run discovered just after local midnight on
   the 1st of a month, or on January 1st) exercises both underflows at once and is exactly the
   kind of edge this project's own history (the `formatDay`/UTC-4 lesson in Plan 3's follow-ups)
   says is worth pinning rather than trusting by inspection.

4. **A healthy poll cycle is invisible in `docker compose logs app`, by design, and that design
   was not changed in this task.** `runSessionPoll` (`apps/server/src/sync/applier.ts`) has no
   success-path logging, and `runDueJobs` (`apps/server/src/scheduler.ts`) only logs on
   `.catch()` — a job that dispatches and finishes without error writes nothing to the log
   stream at all. Verified directly against the running two-service stack: `docker compose logs
   app` sat at exactly three lines (`migrations applied`, `startup reconciliation complete`,
   `listening`) for the full observation window while `job_runs.last_run_at` for `session-poll`
   advanced every ~5 seconds underneath it. Task 10 chose to document the operator workaround
   (query `job_runs` directly, or watch the Live screen) in the README's new "Confirming the
   scheduler is actually running" section rather than add a log line, to keep this task's diff to
   documentation and the one sanctioned `docker-compose.yml` comment. A quiet, rate-limited
   success line (e.g. `logger.debug` on `session-poll` specifically, or a periodic summary rather
   than one line per 5-second tick) would make `docker compose logs -f app` a usable liveness
   signal on its own, without spamming at the default interval — worth adding if operators find
   `job_runs` polling too indirect in practice.

## From the original task brief

5. **Losing BullMQ's job-failure history is a real regression for anything beyond same-day
   triage.** BullMQ retained a queryable history of failed jobs — error, timestamp, retry count —
   independent of the log stream. The Postgres-backed replacement keeps none of that: a failed
   job logs once, at `error` level, via `deps.logger.error({ err, job: name }, "scheduled job
   failed")` in `runDueJobs`, and `job_runs` is *not* updated on failure (deliberately — so the
   next tick retries), meaning there is no durable record that a failure happened at all once the
   log line scrolls past or the container's log retention rotates it out. In practice this
   matters most for `reference-sync` and `item-sync`, which fail silently to the dashboard (stale
   library data with no user-visible symptom) and would previously have shown up in a BullMQ
   failure count during triage. `session-poll` is lower-risk here: a failure just means the next
   5-second tick tries again, and a sustained outage is visible today via `job_runs.last_run_at`
   falling behind. A `job_failures` table (name, error message, `failed_at`), written from the
   same `.catch()` in `runDueJobs`, would close this without reintroducing a queue.

6. **The scheduler's tick interval is implicitly `SESSION_POLL_INTERVAL_MS`, not its own
   setting.** `startScheduler`'s default `tickMs` (`apps/server/src/scheduler.ts`) is
   `context.env.SESSION_POLL_INTERVAL_MS` — the same env var that controls how often sessions are
   polled. That coupling is harmless at the shipped default (5000ms is a fine granularity for
   checking whether the three daily jobs and `reference-sync` are due) but is not documented as
   deliberate anywhere near `SESSION_POLL_INTERVAL_MS` in `.env.example` or the README, so an
   operator who raises it to reduce Jellyfin polling load (say, to 60000ms on a large library)
   would, as a side effect, also raise the granularity at which `runDueJobs` notices any job has
   become due — up to a full minute of slop on catching up a missed daily job, rather than the
   original 5 seconds. Not a correctness bug (`isDue`'s local-time catch-up logic is unaffected;
   this only delays *noticing*), but worth a dedicated `SCHEDULER_TICK_MS` (defaulting to the
   current 5000ms) so the two knobs can be reasoned about independently once someone actually
   wants to tune `SESSION_POLL_INTERVAL_MS`.

## Smaller cleanups

7. **`docker-compose.yml`'s `postgres` service published no host port at all** as of the commit
   that collapsed the deployment to two services (`a513962`) — a deliberate choice, recorded in
   `.env.example`'s note and the Task 9 brief, to avoid exposing Postgres unnecessarily in
   production. Task 10 found this broke the README's own documented development flow
   (`docker compose up -d postgres` + `pnpm --filter @jfstats/server dev` on the host) with a
   plain `ECONNREFUSED` against `127.0.0.1:5432`, verified directly. Fixed as part of this task
   by publishing to `127.0.0.1:5432` specifically (loopback only, not `0.0.0.0`) so host-side
   tooling works without reopening the LAN exposure Task 9 intentionally closed. Recorded here
   only because the fix landed in this same documentation task rather than a dedicated one, and a
   reviewer should treat `docker-compose.yml`'s diff for Task 10 as more than a comment-only
   change.

8. **`apps/server/src/testing/redis-harness.ts` no longer exists but `vitest.config.ts`'s
   parallelism comment still names it** as one of the container-backed harnesses vitest is
   serializing around. Harmless — the comment's substance (module-level container caching causing
   worker-process contention) is still accurate for the Postgres harness that remains — but it
   references a file removed by this plan's Redis cleanup and should be trimmed to just
   `packages/db/src/testing/harness.ts` next time that comment block is touched.
