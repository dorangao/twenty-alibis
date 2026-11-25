import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createMetered, type Metered, type TraceEvent } from "./metered";
import { EmberProvider } from "./provider/ember";
import { usdToNano } from "./spend/pricing";
import { connectRedis } from "./spend/redis-client";
import { RedisSpendStore } from "./spend/redis-store";

type Env = Record<string, string | undefined>;

/** Names the key may be stored under, in order of preference. The value is never logged. */
export const API_KEY_NAMES = ["EMBER_API_KEY", "META_API_KEY", "MUSE_API_KEY"] as const;

export function resolveApiKey(env: Env): { name: string; key: string } | null {
  for (const name of API_KEY_NAMES) {
    const key = env[name]?.trim();
    if (key) return { name, key };
  }
  return null;
}

export interface SpendConfig {
  redisUrl: string;
  envelope: string;
  limitNano: number;
}

export function readSpendConfig(env: Env): SpendConfig {
  const redisUrl = env.REDIS_URL?.trim();
  const envelope = env.SPEND_ENVELOPE?.trim();
  const limitUsd = Number(env.SPEND_LIMIT_USD);
  if (!redisUrl) throw new Error("REDIS_URL is not set");
  if (!envelope) throw new Error("SPEND_ENVELOPE is not set");
  if (!env.SPEND_LIMIT_USD?.trim() || !Number.isFinite(limitUsd) || limitUsd <= 0) {
    throw new Error("SPEND_LIMIT_USD must be a positive number of dollars");
  }
  return { redisUrl, envelope, limitNano: usdToNano(limitUsd) };
}

/** Appends one JSON line per request to a local file. The file is ignored by git. */
export function fileTrace(path: string): (event: TraceEvent) => void {
  mkdirSync(dirname(path), { recursive: true });
  return (event) => appendFileSync(path, `${JSON.stringify(event)}\n`);
}

/**
 * Everything a paid run needs, wired the one allowed way: the real provider behind the spend
 * guard, counting in Redis. Throws if any piece of configuration is missing.
 */
export async function createRuntime(env: Env = process.env): Promise<{
  metered: Metered;
  store: RedisSpendStore;
  config: SpendConfig;
  close(): Promise<void>;
}> {
  const config = readSpendConfig(env);
  const apiKey = resolveApiKey(env);
  if (!apiKey) throw new Error(`no API key found; set one of ${API_KEY_NAMES.join(", ")} in .env.local`);

  const redis = await connectRedis(config.redisUrl);
  const store = new RedisSpendStore(redis.runner);
  const metered = createMetered({
    provider: new EmberProvider({ apiKey: apiKey.key }),
    store,
    envelope: config.envelope,
    limitNano: config.limitNano,
    killSwitch: () => env.EMBER_DISABLED === "1",
    trace: fileTrace(`traces/${config.envelope}.trace.jsonl`),
  });
  return { metered, store, config, close: redis.close };
}
