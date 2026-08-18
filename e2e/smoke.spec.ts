import { expect, test } from "@playwright/test";

/**
 * `E2E_JELLYFIN_USER` / `E2E_JELLYFIN_PASSWORD` name a real Jellyfin
 * administrator account. They are read from the environment only — never
 * hardcoded, never written to a file, and never logged by this suite. See
 * the README's "End-to-end tests" section for how to provide them locally.
 *
 * Every other test in this file needs no credential at all: an anonymous
 * redirect, the login screen rendering, and a rejected login are all
 * reachable without ever signing in for real.
 */
const E2E_USER = process.env.E2E_JELLYFIN_USER;
const E2E_PASSWORD = process.env.E2E_JELLYFIN_PASSWORD;

test.describe("anonymous access", () => {
  test("redirects an anonymous visit to / to /login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("renders the login screen", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Sign in with your Jellyfin administrator account.")).toBeVisible();
    await expect(page.getByLabel("Username")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("redirects an anonymous deep link to /login instead of 404ing", async ({ page }) => {
    await page.goto("/users/abc");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("shows the invalid-credentials message for a wrong username and password", async ({ page }) => {
    await page.goto("/login");

    // Invented for this test, obviously fake, and never a real credential:
    // asserting the rejection path needs a login attempt that Jellyfin will
    // actually refuse, not a real account.
    await page.getByLabel("Username").fill("e2e-smoke-test-does-not-exist");
    await page.getByLabel("Password").fill("obviously-fake-password-not-real-1");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toHaveText(
      "That username or password was not accepted by Jellyfin.",
    );
    // A rejected login must never navigate away from /login.
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("authenticated smoke", () => {
  // Calling `test.skip` here, at describe level rather than inside a test
  // body, is what makes a run without credentials report this test as
  // *skipped* in the results — not silently passing, and not failing. A
  // test that would pass whether or not it ever ran is this project's most
  // common defect class (see the task brief this file was written from), so
  // the skip has to be visible in the report, not just an early return.
  test.skip(
    E2E_USER === undefined || E2E_PASSWORD === undefined,
    "E2E_JELLYFIN_USER and/or E2E_JELLYFIN_PASSWORD are not set — skipping the credentialed " +
      "smoke test. Set both to a real Jellyfin administrator account to run it; see the README.",
  );

  test("signs in, sees real dashboard data, survives a deep-link reload, and logs out", async ({
    page,
  }) => {
    // Generous: this is the one test in the suite that waits on a real
    // login round-trip against a real Jellyfin server, which can be slow
    // (LDAP-backed Jellyfin auth, a loaded VM, a flaky network). See the
    // SETTLE_TIMEOUT_MS comment below for why the default per-test budget
    // isn't enough room for that plus the rest of this flow.
    test.setTimeout(45_000);

    // Unreachable when either is unset: the describe-level test.skip above
    // already skips this test in that case. Narrowing this way (rather than
    // a non-null assertion) is what lets the rest of the test use E2E_USER/
    // E2E_PASSWORD as plain strings under strict null checking.
    if (E2E_USER === undefined || E2E_PASSWORD === undefined) {
      throw new Error("E2E_JELLYFIN_USER/E2E_JELLYFIN_PASSWORD must be set to reach this point");
    }

    await page.goto("/login");
    await page.getByLabel("Username").fill(E2E_USER);
    await page.getByLabel("Password").fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    // Blank both fields' DOM values before anything else runs, and wait as
    // long as it takes (up to a generous ceiling) for that to actually
    // succeed. The login request above already read the real credential
    // from the DOM synchronously at submit time (login.tsx's onSubmit
    // builds its request body from FormData before any await), so clearing
    // the inputs now cannot affect that request.
    //
    // This has to be an inline, *awaited*, generously-timed-out clear —
    // not a fixed-short-timeout best-effort attempt, and not a separate
    // `afterEach` teardown — for a reason confirmed by reproduction rather
    // than assumed: Playwright's on-failure artifacts (the screenshot and
    // `error-context.md`, an accessibility-tree dump) are captured
    // synchronously, inside the test body, at the instant a *later*
    // assertion's own timeout elapses — not lazily during teardown. An
    // earlier version of this fix used a 2000ms-bounded clear right here,
    // verified against a fast (sub-second) rejected login; a slow real
    // login (`login.tsx` disables both fields via `disabled={submitting}`
    // for the whole request) can outlast 2000ms, in which case that clear
    // silently times out and does nothing, and the *next* assertion
    // (`overview-route` below) fails on a form that still has the real
    // password in it. A follow-up `afterEach`-based clear was tried next
    // and reproduced as *also* ineffective — it clears the live page, but
    // only after the on-failure snapshot for that same test has already
    // been written to disk. What actually closes the window: `fill("")`'s
    // own actionability wait blocks until the (disabled-while-submitting)
    // input is enabled again — exactly when the request settles, success
    // or failure, however long that took — so awaiting it here, before the
    // vulnerable assertion, means that assertion is never reached while a
    // real credential is still sitting in the DOM.
    const SETTLE_TIMEOUT_MS = 20_000;
    await page.getByLabel("Username").fill("", { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    await page.getByLabel("Password").fill("", { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});

    // Successful login lands on the dashboard (the / overview route).
    const overview = page.getByTestId("overview-route");
    await expect(overview).toBeVisible();

    // The overview shows a non-zero total when the database has data.
    // Rather than asserting a hardcoded non-zero number — meaningless
    // against an environment with no playback history — this fetches the
    // same /api/stats/overview the route itself queries (over the session
    // this login just established, via the same default range) and checks
    // the rendered "Plays" tile matches the real count exactly. That fails
    // if the tile ever renders stale, zeroed, or mismatched data, and it
    // still proves the totals are non-zero whenever the account's real
    // history actually has plays in the trailing 30 days.
    const overviewResponse = await page.request.get("/api/stats/overview");
    expect(overviewResponse.ok()).toBe(true);
    const overviewStats: { plays: number } = await overviewResponse.json();
    const expectedPlaysText = new Intl.NumberFormat("en-GB").format(overviewStats.plays);

    // Scoped to `[data-slot="card-title"]` (the CardTitle in StatCard.tsx),
    // not just any element containing the text "Plays" — the Top content
    // card elsewhere on this same route also contains "Plays" (its table
    // column header, and "No plays in this range" in its empty state,
    // which `filter({ hasText })`'s case-insensitive substring match would
    // also catch). Neither of those is a card-title, so this stays unique
    // to the actual StatCard being asserted on; toHaveCount(1) below turns
    // a future collision back into a loud failure instead of a silent
    // first()-picks-the-wrong-one.
    const playsCard = overview
      .locator('[data-slot="card"]')
      .filter({ has: page.locator('[data-slot="card-title"]', { hasText: /^Plays$/ }) });
    await expect(playsCard).toHaveCount(1);
    await expect(playsCard.locator("p").first()).toHaveText(expectedPlaysText);
    if (overviewStats.plays > 0) {
      await expect(playsCard.locator("p").first()).not.toHaveText("0");
    }

    // A deep link survives a page reload. /history is a real, parameter-free
    // route, so a hard reload here exercises the same SPA-fallback path
    // (apps/server/src/api/static.ts) a browser refresh would hit in
    // production, while still authenticated.
    await page.goto("/history");
    await expect(page.getByTestId("history-route")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("history-route")).toBeVisible();

    // Logout returns to /login.
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});
