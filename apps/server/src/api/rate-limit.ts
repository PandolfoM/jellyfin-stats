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
      const [count] = await redis
        .multi()
        .incr(redisKey)
        .expire(redisKey, options.windowSeconds, "NX")
        .exec()
        .then((replies) => (replies ?? []).map((reply) => Number(reply?.[1] ?? 0)));

      const used = count ?? 0;
      return { allowed: used <= options.limit, remaining: Math.max(0, options.limit - used) };
    },
  };
}
