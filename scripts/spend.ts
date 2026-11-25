/**
 * Manage a spend envelope in Redis.
 *
 *   npm run spend -- init [--carried-usd 0.12]   create the envelope with the limit from SPEND_LIMIT_USD
 *   npm run spend -- status                      show what has been spent and held
 *
 * `init` does nothing if the envelope already exists: a limit, once set, cannot be raised here.
 * `--carried-usd` records spend that happened before this record existed.
 */
import { readSpendConfig } from "../src/runtime";
import { nanoToUsd, usdToNano } from "../src/spend/pricing";
import { connectRedis } from "../src/spend/redis-client";
import { RedisSpendStore } from "../src/spend/redis-store";

const usd = (nano: number) => `$${nanoToUsd(nano).toFixed(6)}`;
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const config = readSpendConfig(process.env);
const redis = await connectRedis(config.redisUrl);
const store = new RedisSpendStore(redis.runner);
try {
  if (command === "init") {
    const carried = Number(flag("carried-usd") ?? "0");
    if (!Number.isFinite(carried) || carried < 0) throw new Error("--carried-usd must be zero or more");
    const result = await store.init({ envelope: config.envelope, limitNano: config.limitNano, carriedNano: usdToNano(carried) });
    console.log(
      result.created
        ? `Created envelope "${config.envelope}" with a fixed limit of ${usd(result.limitNano)}, starting at ${usd(result.totals.settledNano)}.`
        : `Envelope "${config.envelope}" already exists with a fixed limit of ${usd(result.limitNano)}. Nothing changed.`,
    );
  } else if (command === "status") {
    const [totals, limit] = [await store.totals(config.envelope), await store.limit(config.envelope)];
    console.log(`Envelope "${config.envelope}": committed ${usd(totals.committedNano)} of ${usd(limit)}`);
    console.log(`  settled ${usd(totals.settledNano)}, in flight ${usd(totals.heldNano)}, kept for unknown outcomes ${usd(totals.retainedNano)}, requests ${totals.attempts}`);
  } else {
    console.log("usage: npm run spend -- init [--carried-usd N] | status");
    process.exitCode = 1;
  }
} finally {
  await redis.close();
}
