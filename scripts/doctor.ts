/**
 * Checks that a paid run is set up correctly, without making one.
 * It reports whether each setting is present. It never prints a secret.
 */
import { API_KEY_NAMES, readSpendConfig, resolveApiKey } from "../src/runtime";
import { nanoToUsd } from "../src/spend/pricing";
import { connectRedis } from "../src/spend/redis-client";
import { EnvelopeCorruptError, EnvelopeNotInitializedError, RedisSpendStore } from "../src/spend/redis-store";

const usd = (nano: number) => `$${nanoToUsd(nano).toFixed(6)}`;
let problems = 0;
const ok = (label: string, detail = "") => console.log(`  ok       ${label}${detail ? `: ${detail}` : ""}`);
const bad = (label: string, detail: string) => {
  problems++;
  console.log(`  MISSING  ${label}: ${detail}`);
};

console.log("Twenty Alibis: setup check (no model request is made)\n");

const apiKey = resolveApiKey(process.env);
if (apiKey) ok("API key", `set as ${apiKey.name}`);
else bad("API key", `set one of ${API_KEY_NAMES.join(", ")} in .env.local`);

console.log(`  ${process.env.EMBER_DISABLED === "1" ? "ON " : "off"}      kill switch (EMBER_DISABLED)`);

try {
  const config = readSpendConfig(process.env);
  ok("spend settings", `envelope "${config.envelope}", limit ${usd(config.limitNano)}`);
  try {
    const redis = await connectRedis(config.redisUrl);
    try {
      ok("Redis", await redis.ping());
      const store = new RedisSpendStore(redis.runner);
      try {
        const [totals, limit] = [await store.totals(config.envelope), await store.limit(config.envelope)];
        ok("envelope", `initialized with a fixed limit of ${usd(limit)}`);
        if (totals.suspended) bad("envelope", `SUSPENDED: ${totals.suspended}. Look into it, then \`npm run spend -- resume\``);
        const audit = await store.audit(config.envelope);
        if (audit.consistent) ok("record", "the totals equal what the attempt records add up to");
        else bad("record", "the totals do not match the attempt records; run `npm run spend -- audit`");
        if (limit !== config.limitNano) {
          console.log(`  note     SPEND_LIMIT_USD (${usd(config.limitNano)}) differs from the fixed limit; the lower one applies`);
        }
        console.log(
          `\n  settled ${usd(totals.settledNano)}   in flight ${usd(totals.heldNano)}   kept for unknown outcomes ${usd(totals.retainedNano)}` +
            `\n  committed ${usd(totals.committedNano)} of ${usd(Math.min(limit, config.limitNano))}   requests ${totals.attempts}`,
        );
      } catch (error) {
        if (error instanceof EnvelopeCorruptError) bad("envelope", "its record in Redis is damaged; reconcile it by hand before anything is sent");
        else if (error instanceof EnvelopeNotInitializedError) bad("envelope", "not initialized; run `npm run spend -- init`");
        else throw error;
      }
    } finally {
      await redis.close();
    }
  } catch (error) {
    bad("Redis", `cannot reach it (${(error as Error).message}); run \`npm run redis:up\``);
  }
} catch (error) {
  bad("spend settings", (error as Error).message);
}

console.log(problems === 0 ? "\nReady." : `\n${problems} thing(s) to fix before a paid run.`);
process.exit(problems === 0 ? 0 : 1);
