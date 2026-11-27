import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createMetered, type Metered, type TraceEvent } from "./metered";
import { EmberProvider } from "./provider/ember";
import { usdToNano } from "./spend/pricing";
import { connectRedis } from "./spend/redis-client";
import { RedisSpendStore, type ScriptRunner } from "./spend/redis-store";
import { redisRunLock, type RunLock } from "./spend/run-lock";

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
 * The real provider behind the spend guard, counting in the Redis that `redis` reaches. This
 * is the one place the two are put together: a local run and the deployed server both get
 * their model from here, and differ only in where the trace goes.
 */
export function guardedModel(options: { env: Env; config: Pick<SpendConfig, "envelope" | "limitNano">; apiKey: string; redis: ScriptRunner; trace: (event: TraceEvent) => void }): { metered: Metered; store: RedisSpendStore } {
  const { env, config } = options;
  const store = new RedisSpendStore(options.redis);
  // No input ratio is read or passed here, on purpose: every real request holds the full
  // context-window worst case.
  const metered = createMetered({
    provider: new EmberProvider({ apiKey: options.apiKey }),
    store,
    envelope: config.envelope,
    limitNano: config.limitNano,
    // Two switches, both read again right before every send: this process's own setting,
    // and the envelope's suspension flag in Redis, which any other process can set
    // (`npm run spend -- suspend "why"`).
    killSwitch: async () => env.EMBER_DISABLED === "1" || (await store.totals(config.envelope)).suspended !== null,
    trace: options.trace,
  });
  return { metered, store };
}

/**
 * Everything a paid run needs, wired the one allowed way: the real provider behind the spend
 * guard, counting in Redis. Throws if any piece of configuration is missing.
 */
export async function createRuntime(env: Env = process.env): Promise<{
  metered: Metered;
  store: RedisSpendStore;
  /** The one-runner lease for this envelope, kept in the same Redis as the counter. */
  runLock: RunLock;
  config: SpendConfig;
  close(): Promise<void>;
}> {
  const config = readSpendConfig(env);
  const apiKey = resolveApiKey(env);
  if (!apiKey) throw new Error(`no API key found; set one of ${API_KEY_NAMES.join(", ")} in .env.local`);

  const redis = await connectRedis(config.redisUrl);
  const { metered, store } = guardedModel({ env, config, apiKey: apiKey.key, redis: redis.runner, trace: fileTrace(`traces/${config.envelope}.trace.jsonl`) });
  return { metered, store, runLock: redisRunLock(redis.runner, `${store.keyOf(config.envelope)}:run-lease`), config, close: redis.close };
}
