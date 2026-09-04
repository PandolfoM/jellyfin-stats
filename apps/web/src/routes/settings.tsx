import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { saveCustomCss, settingsQuery, triggerSync } from "../api/queries";
import { useSession } from "../auth/session";
import { SettingsAccountCard } from "../components/domain/SettingsAccountCard";
import { SettingsConfigCard } from "../components/domain/SettingsConfigCard";
import { SettingsCustomCssCard } from "../components/domain/SettingsCustomCssCard";
import { SettingsSyncCard } from "../components/domain/SettingsSyncCard";
import { PanelError } from "./PanelError";
import { rootRoute } from "./__root";

const SYNC_POLL_MS = 2_000;

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
  const queryClient = useQueryClient();
  const settings = useQuery({
    ...settingsQuery(),
    // While a sync is running, re-read every couple of seconds so the card
    // notices when it finishes — the trigger endpoint answers as soon as the
    // job *starts*, so this poll is the only way to learn it completed.
    refetchInterval: (query) => (query.state.data?.sync.running === true ? SYNC_POLL_MS : false),
  });

  // Invalidated rather than written into the cache directly: the stylesheet is
  // also read by `CustomCssStyle` inside AppShell, and a refetch is what makes
  // both it and this editor agree with what the server actually stored.
  const saveCss = useMutation({
    mutationFn: saveCustomCss,
    // `settingsQuery().queryKey` rather than reaching for the `queryKeys` map,
    // which queries.ts keeps module-private on purpose — the options object
    // already carries the key, so nothing has to be widened to read it.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsQuery().queryKey }),
  });

  const syncNow = useMutation({
    mutationFn: triggerSync,
    onSuccess: () => {
      // Re-read immediately so `sync.running` flips to true (starting the
      // poll above) without waiting for the next stale-time expiry.
      void queryClient.invalidateQueries({ queryKey: settingsQuery().queryKey });
    },
  });

  const wasRunning = useRef(false);
  const running = settings.data?.sync.running === true;
  useEffect(() => {
    // Falling edge: a sync just finished. Everything else on the dashboard
    // (top content, history, libraries) may now name items that did not
    // exist before, so drop the whole cache rather than pick queries by hand.
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries();
    }
    wasRunning.current = running;
  }, [running, queryClient]);

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

      {!settings.isError && (
        <SettingsSyncCard
          status={settings.data?.sync ?? null}
          loading={settings.isLoading}
          onSync={async () => {
            await syncNow.mutateAsync();
          }}
        />
      )}

      {!settings.isError && (
        <SettingsCustomCssCard
          savedCss={settings.data?.customCss ?? null}
          loading={settings.isLoading}
          onSave={(css) => saveCss.mutateAsync(css)}
        />
      )}
    </div>
  );
}

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsRoute,
});
