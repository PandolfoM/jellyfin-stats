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
    // Generous: a real Jellyfin login (LDAP-backed auth, a loaded VM, a
    // flaky network) plus the rest of this flow can outrun the default
    // 30s. The clear step below no longer contributes to this budget —
    // see its own comment for why — so this mainly covers a slow
    // `overview-route` render plus the /history reload/logout cycle.
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

    // Blank both fields' raw DOM value immediately, on both the success and
    // failure path alike, without waiting on anything. The login request
    // above already read the real credential from the DOM synchronously at
    // submit time (login.tsx's onSubmit builds its request body from
    // FormData before any await), so clearing the inputs now cannot affect
    // that request either way.
    //
    // This uses a direct `.evaluate()` DOM write, not `fill("")`, and that
    // is the actual fix, not a retuned timeout. Two earlier versions both
    // failed empirically:
    //   - `fill("", { timeout: 2000 })` right after click: `fill()` enforces
    //     actionability (the target must be *enabled*), and both fields are
    //     `disabled={submitting}` (login.tsx) for the whole request — a
    //     login slower than 2s left the real password uncleared when the
    //     next assertion's own failure snapshot was captured.
    //   - Raising that same timeout to 20000ms fixed the slow-failure case
    //     (confirmed by reproduction: a mocked 3s-delayed 401 leaked at
    //     2000ms, did not leak at 20000ms) but broke the *success* path
    //     instead: once login succeeds, `LoginRoute` unmounts entirely
    //     (routes/__root.tsx's gate swap), so `fill()` finds nothing to act
    //     on and has to poll the *full* 20000ms before giving up on each of
    //     the two fields — ~40s of dead time on every successful run, which
    //     was never measured because every reproduction up to that point
    //     was a login that fails on purpose.
    // Setting `element.value` directly needs no actionability wait at all —
    // it works whether the element is enabled or disabled, and this locator
    // resolves to zero elements almost immediately once the form actually
    // unmounts, so `.count()` below returns 0 and there is nothing left to
    // clear. Either way this step costs low-single-digit milliseconds, not
    // a duration tied to how slow the request was. Both inputs are
    // uncontrolled (login.tsx's own comment: "a failed submit does not
    // clear this field"), so writing `.value` directly does not fight a
    // React re-render that would otherwise stomp it back.
    //
    // Not wrapped in `.catch()`: the only realistic way this throws is the
    // element handle going stale (the locator matched, then the element was
    // removed from the DOM before `.evaluate()` ran) — which can only mean
    // the form was already unmounting, i.e. nothing was left to leak in the
    // first place. Any other failure here is unexpected enough that an
    // aborted test — which leaks nothing, since it never proceeds to a
    // snapshot-producing assertion with a real value still sitting in the
    // DOM — is the correct outcome, per this project's standing rule that a
    // failing-loud test beats a passing-quiet one that might have missed
    // something.
    async function clearFieldIfPresent(label: string): Promise<void> {
      const field = page.getByLabel(label);
      if ((await field.count()) > 0) {
        await field.evaluate((el) => {
          (el as HTMLInputElement).value = "";
        });
      }
    }
    await clearFieldIfPresent("Username");
    await clearFieldIfPresent("Password");

    // Successful login lands on the dashboard (the / overview route). A
    // generous timeout here (not the default 5s) is what actually accounts
    // for a slow real login/redirect — decoupled from the clear step above,
    // which no longer needs one at all.
    const overview = page.getByTestId("overview-route");
    await expect(overview).toBeVisible({ timeout: 20_000 });

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
