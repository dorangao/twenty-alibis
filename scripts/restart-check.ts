/**
 * Proves that the spend record survives Redis being killed, on the local docker-compose Redis.
 *
 *   npm run check:restart
 *
 * It writes a small test record (its own key prefix, database 15, never a real budget),
 * kills the Redis process outright, starts it again, and checks from a fresh connection that
 * every number, every attempt and the limit are exactly as they were. No model is called.
 */
import { execFileSync } from "node:child_process";
import { Redis } from "ioredis";
import { connectRedis } from "../src/spend/redis-client";
import { RedisSpendStore } from "../src/spend/redis-store";

const url = "redis://127.0.0.1:6379/15";
const prefix = "ta-restart-check";
const envelope = "e";
const docker = (...args: string[]) => execFileSync("docker", ["compose", ...args], { stdio: ["ignore", "ignore", "inherit"] });
const clear = async (key: string) => {
  const admin = new Redis(url);
  await admin.del(key);
  admin.disconnect();
};

let failures = 0;
const expect = (label: string, actual: unknown, wanted: unknown) => {
  const same = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!same) failures++;
  console.log(`  ${same ? "ok  " : "FAIL"} ${label}${same ? "" : `: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`}`);
};

// ---- Before: one attempt of each kind, 76 of 100 committed. ----
let redis = await connectRedis(url);
let store = new RedisSpendStore(redis.runner, { prefix });
await clear(store.keyOf(envelope));
await store.init({ envelope, limitNano: 100 });
await store.reserve({ envelope, attemptId: "paid", amountNano: 30, limitNano: 100 });
await store.settle({ envelope, attemptId: "paid", actualNano: 26 });
await store.reserve({ envelope, attemptId: "flying", amountNano: 10, limitNano: 100 });
await store.reserve({ envelope, attemptId: "lost", amountNano: 40, limitNano: 100 });
await store.retain({ envelope, attemptId: "lost" });
const before = await store.totals(envelope);
console.log("Before:", JSON.stringify(before));
await redis.close();

// ---- Kill Redis without warning, then bring it back. ----
console.log("Killing the Redis process and starting it again...");
docker("kill", "-s", "SIGKILL", "redis");
docker("up", "-d", "--wait");

// ---- After: a fresh connection must see exactly the same record. ----
redis = await connectRedis(url);
store = new RedisSpendStore(redis.runner, { prefix });
console.log("After:");
expect("totals are unchanged", await store.totals(envelope), before);
expect("the limit is unchanged", await store.limit(envelope), 100);
for (const [id, state] of [["paid", "settled"], ["flying", "reserved"], ["lost", "retained"]] as const) {
  const again = await store.reserve({ envelope, attemptId: id, amountNano: 1, limitNano: 100 });
  expect(`"${id}" is still known, as ${state}`, again.ok && again.duplicate ? again.state : "not a duplicate", state);
}
expect("a 25-unit hold is refused (76 + 25 > 100)", (await store.reserve({ envelope, attemptId: "new-25", amountNano: 25, limitNano: 100 })).ok, false);
expect("a 24-unit hold fits exactly (76 + 24 = 100)", (await store.reserve({ envelope, attemptId: "new-24", amountNano: 24, limitNano: 100 })).ok, true);
expect("the totals still equal what the attempts add up to", (await store.audit(envelope)).consistent, true);

await clear(store.keyOf(envelope));
await redis.close();
console.log(failures === 0 ? "\nThe record survived the restart." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
