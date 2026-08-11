import { createClient, type RedisClientType } from "redis";

/** Queue names, so a typo cannot silently create a queue nobody reads. */
export const BUILD_QUEUE = "build-queue";
export const SCREENSHOT_QUEUE = "screenshot-queue";

/**
 * Builds a Redis client with the error handler already attached.
 *
 * Every service repeated `createClient()` followed by an `on("error")` line;
 * forgetting that listener turns a connection error into an unhandled 'error'
 * event, which crashes the process instead of logging.
 *
 * `label` shows up in the log so a failure names which client died — a worker
 * holds two (one blocked on brPop, one for publishing) and "Redis client error"
 * alone does not say which.
 *
 * Still a factory, and still not connected: blocking commands need their own
 * connection, so callers deliberately create more than one.
 */
export function createRedisClient(label = "redis"): RedisClientType {
  const client: RedisClientType = createClient({
    url: process.env.REDIS_URL,
  });
  client.on("error", (err) => console.error(`${label} client error`, err));
  return client;
}
