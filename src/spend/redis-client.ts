import { Redis } from "ioredis";
import type { ScriptRunner } from "./redis-store";

/**
 * A TCP Redis connection for local runs. It fails fast: if Redis is not reachable, a command
 * rejects at once and the spend guard refuses the request. Nothing is queued for later.
 */
export async function connectRedis(url: string): Promise<{ runner: ScriptRunner; ping(): Promise<string>; close(): Promise<void> }> {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 3_000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  // Without a listener, a dropped connection would crash the process instead of failing the call.
  client.on("error", () => {});
  await client.connect();
  return {
    runner: {
      eval: (script, keys, args) => client.eval(script, keys.length, ...keys, ...args),
    },
    ping: () => client.ping(),
    close: async () => {
      client.disconnect();
    },
  };
}
