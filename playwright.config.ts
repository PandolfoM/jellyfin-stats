import { defineConfig, devices } from "@playwright/test";

// Overridable so this can point at a non-default host/port without editing
// the file, but the real deployment target is fixed: `docker compose up -d`
// serves the whole app (API + built SPA) on this one origin — see the
// README's "Running the production image" section.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  // The suite is small and shares one login rate limiter (10 attempts per 15
  // minutes per client — see the README's Authentication section) across its
  // two tests that actually submit a login form. Running serially keeps that
  // budget predictable instead of racing several workers against it.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: {
    baseURL,
    // Deliberately off, not "on-first-retry": a Playwright trace records
    // full request/response bodies, including the JSON body this suite's
    // credentialed test posts to /api/auth/login — which carries a real
    // Jellyfin password in plaintext. Turning tracing on would write that
    // password into a trace .zip under test-results/. Screenshots stay
    // enabled; they only capture the rendered page, and the password field
    // is a masked <input type="password">, never the raw value.
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
