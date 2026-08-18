import { bumpRateLimit, type Db } from "@jfstats/db";

export interface RateLimiter {
  check(key: string): Promise<{ allowed: boolean; remaining: number }>;
}

export function createRateLimiter(
  db: Db,
  options: { limit: number; windowSeconds: number },
): RateLimiter {
  const windowMs = options.windowSeconds * 1000;

  return {
    async check(key) {
      let used: number;
      try {
        used = await bumpRateLimit(db, key, new Date(), windowMs);
      } catch {
        // Fail closed. Reading a failure as "0 attempts so far" would have
        // ALLOWED the request, silently switching login throttling off exactly
        // when an attacker would most like it off. The cost is that a database
        // outage blocks logins — already true regardless, since sessions live
        // in the same database and no login could be issued anyway.
        return { allowed: false, remaining: 0 };
      }

      return { allowed: used <= options.limit, remaining: Math.max(0, options.limit - used) };
    },
  };
}
