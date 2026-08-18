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

    // Best-effort, immediately after submit: blank both fields' DOM values.
    // The login request above already read the real credential from the DOM
    // synchronously at submit time (login.tsx's onSubmit builds its request
    // body from FormData before any await), so clearing the inputs now
    // cannot affect that request. What it does protect against: if any
    // assertion below fails while this form is still on screen (login
    // unexpectedly rejected), Playwright's automatic failure snapshot — an
    // accessibility-tree dump written to test-results/ — includes each
    // field's *current* value verbatim, which would otherwise put the real
    // password in a plaintext file on disk. If login has already succeeded
    // by the time this runs, the form has unmounted and these locators
    // simply find nothing to clear, which is fine — a form that no longer
    // exists has nothing left to leak.
    await page.getByLabel("Username").fill("", { timeout: 2000 }).catch(() => {});
    await page.getByLabel("Password").fill("", { timeout: 2000 }).catch(() => {});

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

    const playsCard = overview.locator('[data-slot="card"]').filter({ hasText: "Plays" });
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
