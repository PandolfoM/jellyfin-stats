import type Redis from "ioredis";

export interface RateLimiter {
  check(key: string): Promise<{ allowed: boolean; remaining: number }>;
}

const PREFIX = "jfstats:ratelimit:";

export function createRateLimiter(
  redis: Redis,
  options: { limit: number; windowSeconds: number },
): RateLimiter {
  return {
    async check(key) {
      const redisKey = `${PREFIX}${key}`;
      // INCR then EXPIRE in one round trip; NX means EXPIRE only takes effect on the
      // first call in the window, so the TTL isn't reset by every subsequent hit.
      const replies = await redis
        .multi()
        .incr(redisKey)
        .expire(redisKey, options.windowSeconds, "NX")
        .exec();

      // ioredis reports each command as [error, result]; a failed INCR arrives as
      // [err, null]. Reading that as a count of 0 would have *allowed* the request,
      // so a Redis fault silently switched login throttling off altogether —
      // precisely when an attacker would most like it off. Fail closed instead: if
      // the counter cannot be read, the attempt does not proceed. The cost is that
      // a Redis outage blocks logins, which is already true of everything else here
      // (sessions live in Redis, so no login could be issued anyway).
      const incr = replies?.[0];
      if (incr === undefined || incr[0] !== null || typeof incr[1] !== "number") {
        return { allowed: false, remaining: 0 };
      }

      const used = incr[1];
      return { allowed: used <= options.limit, remaining: Math.max(0, options.limit - used) };
    },
  };
}
