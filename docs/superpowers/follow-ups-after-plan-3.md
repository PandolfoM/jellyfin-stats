# Follow-ups carried out of Plan 3

Recorded at the end of the web UI and packaging branch. Everything here was found by review,
consciously deferred, and judged non-blocking for merge. Ordered by value.

Plan 1's list is in [`follow-ups-after-plan-1.md`](./follow-ups-after-plan-1.md) and Plan 2's in
[`follow-ups-after-plan-2.md`](./follow-ups-after-plan-2.md); both are still open except where a
later plan closed an item in passing.

## Worth doing early

1. **Request query parameters are not typed, only responses.** This is the one place the
   "typed end-to-end, no codegen" claim is narrower than it sounds. `hc<AppType>` carries response
   types to the browser, but the server hand-parses query strings — there is no `zValidator`
   anywhere in `apps/server/src/api/routes/stats.ts` or `history.ts` — so Hono's RPC has nothing to
   infer request shapes from. A typo like `limt` for `limit` in `apps/web/src/api/queries.ts` is
   caught by nothing on either side. Adding validators to the stats and history routes would close
   it and is a contained server-side change.

2. **`unwrap<T>` takes its type argument by hand at eight call sites.** Nothing ties the `T` to the
   response being unwrapped, so `unwrap<SeriesResponse>(await api.api.stats.overview.$get(...))`
   would compile silently and hand consumers wrong-shaped data. The compile-time guards in
   `queries.test.ts` catch a dropped `, 200` pin, not a mismatched pairing. Inferring `T` from
   `ClientResponse<T>` was attempted twice and honestly reported as a dead end — one approach
   hard-errors on the union argument, the other collapses to `never` — so this needs a different
   idea rather than another attempt at the same one. It is the softest joint in an otherwise tight
   chain.

3. **Duplicated test harnesses across eight route test files.** `jsonResponse` is defined
   identically in 8 files, `mockFetch` in 8, `paramsFor` in 6, and there are three copies of the
   bare-router harness for domain components (`AppShell.test.tsx`, `UserStatsTable.test.tsx`,
   `LibraryStatsTable.test.tsx`). The branch established the rule explicitly in
   `apps/web/src/test/renderApp.tsx` — extract at the third call site — applied it to the six-line
   provider stack, then copied the larger and more failure-prone half verbatim through three
   subsequent tasks. Deliberately left alone immediately before merge because it is an eight-file
   refactor with regression risk; it should be the first cleanup after.

4. **`/api/settings` discloses `JELLYFIN_URL` to an authenticated admin's browser.** Correct as
   specified and admin-gated, and no real value sits in any tracked file. But if the dashboard is
   ever internet-facing while Jellyfin is LAN-only, an internal hostname or private IP reaching a
   browser is a different exposure than holding it server-side. Worth a conscious decision rather
   than an inherited default.

5. **`/api/health` is absent from `AppType`.** It is still registered as a bare `app.get(...)`
   statement whose return value is discarded — the same defect that made every route invisible to
   the typed client before it was repaired. Harmless today because only server tests reference it,
   but it will be rediscovered as a bug by whoever first tries to call it from the browser.

## Smaller cleanups

6. **No `keepPreviousData` on the paginated history query**, so every page turn full-skeletons
   instead of holding the previous page during refetch. Pagination is the one place in this app
   where that would most improve the feel.

7. **The 401 probe on the Live route fires on every `EventSource` error with no throttle**, so a
   sustained outage means one `/api/auth/me` per retry cycle. Bounded by `EventSource`'s own
   cadence and it cannot self-trigger, but a short cooldown would avoid the background load.

8. **The error card says "Try again." with no retry control.** The only recovery is nudging the
   date picker into a new query key. A retry button wired to the panel's `refetch` would close it,
   and every route container would want the same.

9. **`ActivityFeed`'s secondary line renders a calendar day only**, so in a compact recent-activity
   list most rows read identically. `startedAt` carries the time-of-day that `slice(0, 10)` drops.

10. **Two "Log out" buttons render on `/settings`** — the sidebar's and the account card's —
    disambiguated in tests via `within(route)`.

11. **Coverage gaps worth batching into one commit:** `EmptyState`'s conditional icon/description
    rendering; the library not-found state while the roster query is still loading; the
    malformed-JSON branch in the SSE handler; the filter-change page reset in the history route;
    and the settings "no editable control" tests not querying `role=switch`, `combobox`, or
    `slider`.

12. **The testcontainers reaper is the suite's one real flake source.** A full `pnpm test` can
    fail with `Error: Expected Reaper to map exposed port 8080` when many container-backed suites
    start at once — testcontainers' Ryuk helper losing a port race, not a defect in this code. It
    was observed twice in a row after heavy `docker compose` churn, failing differently each time
    (four tests, then one suite), and the affected file passed immediately in isolation and the
    full suite passed green on the next run. **Triage rule: if a failure names Reaper or Ryuk,
    re-run before investigating.** A `--pool=forks --poolOptions.forks.singleFork` run, or reusing
    one container across suites, would remove the contention if it becomes tiresome.

13. **Test-harness sensitivities worth knowing when triaging a flake.** The chart tests couple to
    Recharts' internal `.recharts-*` class names and need a jsdom `ResizeObserver` /
    `getBoundingClientRect` polyfill that lives in `WatchTimeChart.test.tsx`; extract it if a second
    chart appears. `apps/web/vitest.setup.ts` sits outside every tsconfig `include`, so a type error
    there surfaces only at test runtime. Recharts pulls `@reduxjs/toolkit`, `redux`, `react-redux`,
    `immer`, and the `d3-*` family transitively for a single area chart.

## What the static-traversal tests actually pin

Worth stating plainly, because the test names overstate it. `apps/server/src/api/static.test.ts`'s
three traversal cases discriminate on **"the fallback's root is not accidentally pointed above
`WEB_ROOT`"** — a real property, genuinely red when violated. They do **not** exercise
`@hono/node-server`'s traversal regex, and structurally cannot: the SPA fallback serves a hardcoded
`index.html` and never consults the request path, and none of the payloads requests a file named
`index.html`.

The behavior is safe — a sibling file placed outside the root with distinctive content is never
served — and `200`-with-`index.html` is the correct SPA response for an unknown path, which deep
links depend on. **Do not "fix" this by making it return 404.**

## What Plan 3 confirmed about this project's failure modes

Plan 1's lesson was that an assumption about a real system, encoded into a hand-written fixture,
confirms itself forever. Plan 2's was that a test which would pass with the behavior removed
advertises protection that does not exist. Plan 3 produced an instance of the second in
**essentially every task** — thirteen consecutive tasks, each caught in review — and sharpened it
into a third:

**A proof that depends on something ambient is not a proof.** Every hollow test in this plan looked
verified when it was written:

- A `formatDay` timezone test was proven red by its author — but only because the machine sits at
  UTC-4. On a UTC CI runner it would have passed against the broken implementation.
- A compile-time guard covered one of seven response types while its comment advertised all seven.
- A query key's filters could be dropped with all nineteen tests still green.
- Three path-traversal assertions checked a string absent from a body that was *always*
  `index.html`, so they held whether or not any protection existed.
- A credential-leak fix was verified with fake credentials that fail on a local 401 in
  milliseconds — never exercising the multi-second window it was written to close.
- Two pre-existing tests had faithfully encoded a bug as their expected result
  (`toHaveLength(1) // only the item that has a tag`), so fixing the bug required rewriting the
  tests that "protected" it.

The countermeasure that worked: after writing an assertion, ask **what you would have to break for
it to go red, and whether that redness is guaranteed by the test itself or by the environment it
happens to run in.** Where a fix rests on a guarantee, delete the guarantee and watch the test fail.
Two implementers began catching their own hollow tests before review reached them once this was
required in every fix dispatch.

**Three of the plan's own code blocks were wrong in ways only real infrastructure revealed** — a
`Hono` type that would not compile once passed a real typed instance, a `node_modules/.bin/tsx` path
that does not exist under pnpm's isolated linker, and `env_file: .env` leaving containers dialing
`localhost`. Vitest's transform-only checking never caught the first; only `tsc --build` did.

**For the next plan:** verify against the real thing before code depends on its shape, and verify
against the *composed* thing rather than a component in isolation — the traversal probe that misled
this plan tested `serveStatic` alone, not the two-handler wiring it actually runs in. When a comment
documents a mechanism's coverage, treat it as load-bearing: a comment claiming 401 handling covered
SSE and images, when it structurally could not, was one task away from producing a real defect in
the screen that trusted it.
