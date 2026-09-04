import { MAX_SETTING_LENGTH } from "@jfstats/db";
import type { Env, Hono, Schema } from "hono";
import { z } from "zod";

/**
 * The exact, non-secret fields `GET /api/settings` may ever return.
 * Deliberately its own named interface rather than `Pick<AppEnv, ...>` (or
 * `AppEnv` itself) — `AppEnv` also carries `JELLYFIN_API_KEY`,
 * `DATABASE_URL`, `FALLBACK_ADMIN_USER`, and
 * `FALLBACK_ADMIN_PASSWORD`. Every one of those would be a serious
 * credential leak if it ever reached this response. Because the handler
 * below is built from these four named fields one at a time (see the
 * comment on `registerSettingsRoutes`), a future env var added to the
 * schema in packages/shared/src/env.ts cannot reach the browser just by
 * existing — a caller of this file would have to add it here, by name, on
 * purpose.
 */
export interface SettingsDeps {
  sessionPollIntervalMs: number;
  referenceSyncIntervalMs: number;
  completionThreshold: number;
  jellyfinUrl: string;
  /**
   * Reads the operator-editable custom CSS, or null when none is saved. A
   * function rather than a value because unlike the four env fields above,
   * this changes at runtime — resolving it once at wiring time would serve a
   * stale stylesheet until the process restarted.
   */
  getCustomCss(): Promise<string | null>;
  saveCustomCss(css: string): Promise<void>;
  /**
   * The manual "sync now" hook into the scheduler's item-sync job. Null when
   * no scheduler is attached (the app built without one, as in tests), in
   * which case the status reports `available: false` and the trigger answers
   * 503 rather than pretending to start something.
   */
  sync: SyncControl | null;
}

export interface SyncControl {
  trigger(): "started" | "already_running";
  isRunning(): boolean;
  /** When the item sync last completed successfully, from `job_runs`. */
  lastRunAt(): Promise<Date | null>;
}

async function syncStatus(sync: SyncControl | null) {
  if (sync === null) return { available: false, running: false, lastRunAt: null };
  const lastRunAt = await sync.lastRunAt();
  return {
    available: true,
    running: sync.isRunning(),
    lastRunAt: lastRunAt === null ? null : lastRunAt.toISOString(),
  };
}

const customCssSchema = z.object({
  // Bounded here as well as in the repository: an unbounded body should never
  // reach the database layer in the first place. Empty string is allowed and
  // means "clear it" -- setSetting deletes the row rather than storing one.
  css: z.string().max(MAX_SETTING_LENGTH),
});

/**
 * Returns the app with this route chained onto it (rather than `void`), the
 * same reason registerStatsRoutes/registerHistoryRoutes do — see stats.ts
 * for why a bare `app.get(...)` statement here would make the web client's
 * typed RPC client see `unknown` for this route instead of its real schema.
 * The incoming `S` is generic (not defaulted) so a caller threading in an
 * already-chained app keeps those routes in the returned type too.
 *
 * The handler builds its response object field-by-field from `deps` rather
 * than `c.json(deps)` (a spread) — so even if a future call site accidentally
 * passed something wider than `SettingsDeps` as `deps` (the whole `AppEnv`,
 * say), only these four named keys would ever leave this handler. This is
 * belt-and-braces on top of the `SettingsDeps` type itself: `app.ts`'s call
 * site is where the real allow-list boundary lives, picking exactly these
 * four fields off `context.env` by name.
 */
export function registerSettingsRoutes<E extends Env, S extends Schema>(
  app: Hono<E, S>,
  deps: SettingsDeps,
) {
  return app
    .get("/api/settings", async (c) =>
      c.json({
        sessionPollIntervalMs: deps.sessionPollIntervalMs,
        referenceSyncIntervalMs: deps.referenceSyncIntervalMs,
        completionThreshold: deps.completionThreshold,
        jellyfinUrl: deps.jellyfinUrl,
        // Empty string rather than null, so the client has one type to render
        // into a textarea and does not need a null branch of its own.
        customCss: (await deps.getCustomCss()) ?? "",
        sync: await syncStatus(deps.sync),
      }),
    )
    .post("/api/settings/sync-now", (c) => {
      if (deps.sync === null) return c.json({ error: "sync_unavailable" }, 503);

      // Returns as soon as the job is started, not when it finishes: a full
      // item sync can outlast a proxy's request timeout. The client polls
      // GET /api/settings' `sync.running` to learn when it is done.
      if (deps.sync.trigger() === "already_running") {
        return c.json({ started: false, reason: "already_running" }, 200);
      }
      return c.json({ started: true }, 202);
    })
    .put("/api/settings/custom-css", async (c) => {
      const body = customCssSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) {
        return c.json({ error: "invalid_request" }, 400);
      }

      await deps.saveCustomCss(body.data.css);
      return c.json({ ok: true });
    });
}
