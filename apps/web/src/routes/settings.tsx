import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";

import { settingsQuery } from "../api/queries";
import { useSession } from "../auth/session";
import { SettingsAccountCard } from "../components/domain/SettingsAccountCard";
import { SettingsConfigCard } from "../components/domain/SettingsConfigCard";
import { PanelError } from "./PanelError";
import { rootRoute } from "./__root";

/**
 * The Settings screen. A container: it owns the one query this route needs
 * (`GET /api/settings`, added specifically for this task — see
 * apps/server/src/api/routes/settings.ts, which is admin-gated exactly like
 * every other route in api/app.ts) and reads the signed-in account from
 * `useSession()`, passing plain resolved data down to two props-only domain
 * components.
 *
 * The account card and the configuration card fail independently — the same
 * per-panel convention `routes/index.tsx` and `routes/history.tsx` use — so
 * a 500 from `/api/settings` shows `PanelError` in the configuration card's
 * place without also hiding the account name and logout control, which have
 * nothing to do with whether that query resolved.
 *
 * `session.user` can be `null` structurally (`SessionState`'s `status` and
 * `user` fields aren't a true discriminated union — see session.tsx), but
 * `routes/__root.tsx`'s gate only ever renders this route's `<Outlet />`
 * under `AppShell` once `session.status === "authenticated"` *and*
 * `session.user !== null`, so in practice this route never mounts with a
 * null user. Falling back to an empty name keeps this honest without a
 * non-null assertion, rather than asserting something the type system can't
 * actually promise.
 *
 * A 401 from `/api/settings` is not handled here, for the same ordering
 * reason it isn't in any other route container — see `routes/index.tsx`'s
 * doc comment: `unwrap` (api/client.ts) fires the shared
 * `notifyUnauthorized()` listener before a 401 ever reaches this component
 * as a query error, so the session has already flipped to "anonymous" and
 * the gate is already redirecting away.
 */
function SettingsRoute() {
  const session = useSession();
  const settings = useQuery(settingsQuery());

  const userName = session.user?.userName ?? "";

  return (
    <div data-testid="settings-route" className="flex flex-col gap-6">
      <h1 className="text-lg font-semibold text-foreground">Settings</h1>

      <SettingsAccountCard userName={userName} onLogout={() => void session.logout()} />

      {settings.isError ? (
        <PanelError testId="settings-error" />
      ) : (
        <SettingsConfigCard config={settings.data ?? null} loading={settings.isLoading} />
      )}
    </div>
  );
}

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsRoute,
});
