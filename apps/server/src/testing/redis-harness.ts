import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import Redis from "ioredis";

let container: StartedRedisContainer | undefined;
let client: Redis | undefined;

/**
 * Starts one Redis container for the whole test file and reuses it across cases,
 * mirroring packages/db's Postgres harness (src/testing/harness.ts). Real Redis
 * rather than a mock, because the behavior under test IS Redis semantics — TTL
 * sliding, atomic INCR/EXPIRE, key expiry. Hermetic: no dependency on a dev stack
 * being up or on any machine-specific port mapping, so it also runs unchanged in CI.
 */
export async function startTestRedis(): Promise<Redis> {
  container ??= await new RedisContainer("redis:7-alpine").start();
  // Matches the maxRetriesPerRequest setting AppContext uses for its real client.
  client ??= new Redis(container.getConnectionUrl(), { maxRetriesPerRequest: null });
  return client;
}

export async function stopTestRedis(): Promise<void> {
  await client?.quit();
  client = undefined;
  await container?.stop();
  container = undefined;
}
