import { z } from "zod";

const schema = z.object({
  JELLYFIN_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, "")),
  JELLYFIN_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  SESSION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  REFERENCE_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(900_000),
  COMPLETION_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  FALLBACK_ADMIN_USER: z.string().min(1).optional(),
  FALLBACK_ADMIN_PASSWORD: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Secure cookies are dropped over plain HTTP, which is how most self-hosted
  // first runs happen. Default off; the README says to turn it on behind TLS.
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .catch("false")
    .transform((value) => value === "true"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
});

export type AppEnv = z.infer<typeof schema> & {
  /** True only when BOTH fallback credentials are set, per the spec's recovery path. */
  readonly fallbackAdminEnabled: boolean;
  /** Watch-time increments are clamped to this, so a stalled worker cannot inflate stats. */
  readonly maxWatchDeltaMs: number;
  /** An open session older than this is closed by startup reconciliation. */
  readonly staleSessionAfterMs: number;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const env = parsed.data;

  return {
    ...env,
    fallbackAdminEnabled:
      env.FALLBACK_ADMIN_USER !== undefined && env.FALLBACK_ADMIN_PASSWORD !== undefined,
    maxWatchDeltaMs: Math.round(env.SESSION_POLL_INTERVAL_MS * 1.5),
    staleSessionAfterMs: env.SESSION_POLL_INTERVAL_MS * 2,
  };
}
