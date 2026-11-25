/**
 * Manage a spend envelope in Redis. None of these commands calls the model.
 *
 *   npm run spend -- init [--carried-usd 0.12]   create the envelope with the limit from SPEND_LIMIT_USD
 *   npm run spend -- status                      what is settled, in flight and kept; suspended or not
 *   npm run spend -- attempts [retained]         list attempts, or only those with an unknown outcome
 *   npm run spend -- settle <attemptId> --usd N  record the real cost of an attempt, from the dashboard
 *   npm run spend -- suspend "why"               stop admitting requests, from any process
 *   npm run spend -- resume                      admit requests again
 *   npm run spend -- audit                       do the totals equal what the attempts add up to?
 *
 * `init` does nothing if the envelope already exists: a limit, once set, cannot be raised here.
 * `settle` is how a hold kept for an unknown outcome is closed once the dashboard shows its cost.
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
const amount = (name: string, fallback?: string) => {
  const value = Number(flag(name) ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be zero or more dollars`);
  return usdToNano(value);
};

const config = readSpendConfig(process.env);
const redis = await connectRedis(config.redisUrl);
const store = new RedisSpendStore(redis.runner);
const envelope = config.envelope;
try {
  if (command === "init") {
    const result = await store.init({ envelope, limitNano: config.limitNano, carriedNano: amount("carried-usd", "0") });
    console.log(
      result.created
        ? `Created envelope "${envelope}" with a fixed limit of ${usd(result.limitNano)}, starting at ${usd(result.totals.settledNano)}.`
        : `Envelope "${envelope}" already exists with a fixed limit of ${usd(result.limitNano)}. Nothing changed.`,
    );
  } else if (command === "status") {
    const [totals, limit] = [await store.totals(envelope), await store.limit(envelope)];
    console.log(`Envelope "${envelope}": committed ${usd(totals.committedNano)} of ${usd(limit)}`);
    console.log(`  settled ${usd(totals.settledNano)}, in flight ${usd(totals.heldNano)}, kept for unknown outcomes ${usd(totals.retainedNano)}, requests ${totals.attempts}`);
    console.log(totals.suspended ? `  SUSPENDED: ${totals.suspended}` : "  open");
  } else if (command === "attempts") {
    const only = rest[0];
    const list = (await store.attempts(envelope)).filter((a) => !only || a.state === only);
    for (const a of list) console.log(`${a.state.padEnd(9)} hold ${usd(a.holdNano)}  charged ${usd(a.chargedNano)}  ${a.attemptId}`);
    console.log(`${list.length} attempt(s)${only ? ` in state ${only}` : ""}.`);
  } else if (command === "settle") {
    const attemptId = rest[0];
    if (!attemptId || attemptId.startsWith("--")) throw new Error("usage: settle <attemptId> --usd N");
    if (flag("usd") === undefined) throw new Error("settle needs --usd N: the cost the dashboard shows for this request");
    const actualNano = amount("usd");
    const result = await store.settle({ envelope, attemptId, actualNano });
    console.log(
      result.applied
        ? `Settled ${attemptId} at ${usd(actualNano)}. Committed is now ${usd(result.totals.committedNano)}.`
        : `${attemptId} was already settled. Nothing changed.`,
    );
    if (result.overHold) console.log("That cost is above the attempt's hold, so the envelope is now suspended.");
  } else if (command === "suspend") {
    const totals = await store.suspend({ envelope, reason: rest[0] ?? "suspended by an operator" });
    console.log(`Envelope "${envelope}" is suspended: ${totals.suspended}`);
  } else if (command === "resume") {
    await store.resume(envelope);
    console.log(`Envelope "${envelope}" admits requests again.`);
  } else if (command === "audit") {
    const audit = await store.audit(envelope);
    if (audit.consistent) {
      console.log("Consistent: the totals equal what the attempt records add up to.");
    } else {
      console.log("MISMATCH between the totals and the attempt records:");
      console.log(`  totals:        settled ${audit.totals.settledNano}, in flight ${audit.totals.heldNano}, kept ${audit.totals.retainedNano}, requests ${audit.totals.attempts}`);
      console.log(`  from attempts: settled ${audit.fromAttempts.settledNano}, in flight ${audit.fromAttempts.heldNano}, kept ${audit.fromAttempts.retainedNano}, requests ${audit.fromAttempts.attempts}`);
      process.exitCode = 1;
    }
  } else {
    console.log('usage: npm run spend -- init [--carried-usd N] | status | attempts [retained] | settle <id> --usd N | suspend "why" | resume | audit');
    process.exitCode = 1;
  }
} finally {
  await redis.close();
}
