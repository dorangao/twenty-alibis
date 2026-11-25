/**
 * Proves that the spend record survives Redis being killed.
 * 验证 Redis 进程被强制终止后，额度记录完好无损。
 *
 *   npm run check:restart
 *
 * It starts its own throwaway Redis in Docker, on its own port and its own volume, with the
 * same durability settings as docker-compose.yml. It never touches the Redis you use for
 * development. It writes a small test record, kills that Redis outright, starts it again,
 * and checks from a fresh connection that every number, every attempt and the limit are
 * exactly as they were. Then it removes the container and the volume. No model is called.
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { connectRedis } from "../src/spend/redis-client";
import { RedisSpendStore } from "../src/spend/redis-store";
import { both, say } from "./say";

const name = `ta-restart-check-${process.pid}`;
const volume = `${name}-data`;
const envelope = "e";
const docker = (...args: string[]) => execFileSync("docker", args, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();

/** A port nothing is listening on right now. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });

/** Wait until this Redis answers. */
async function connect(url: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const redis = await connectRedis(url);
      if ((await redis.ping()) === "PONG") return redis;
      await redis.close();
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("the throwaway Redis did not start");
}

let failures = 0;
const expect = (en: string, zh: string, actual: unknown, wanted: unknown) => {
  const same = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!same) failures++;
  console.log(`  ${same ? "ok  " : "FAIL"} ${both(en, zh)}${same ? "" : `: ${JSON.stringify(actual)} != ${JSON.stringify(wanted)}`}`);
};

const port = await freePort();
const url = `redis://127.0.0.1:${port}`;
say(`Starting a throwaway Redis on port ${port} (container ${name}).`, `在端口 ${port} 启动一次性 Redis（容器 ${name}）。`);
docker("run", "-d", "--name", name, "-p", `127.0.0.1:${port}:6379`, "-v", `${volume}:/data`, "redis:7.4-alpine", "redis-server", "--appendonly", "yes", "--appendfsync", "always", "--save", "");

try {
  // ---- Before: one attempt of each kind, 76 of 100 committed. ----
  let redis = await connect(url);
  let store = new RedisSpendStore(redis.runner, { prefix: "ta-restart-check" });
  await store.init({ envelope, limitNano: 100 });
  await store.reserve({ envelope, attemptId: "paid", amountNano: 30, limitNano: 100 });
  await store.settle({ envelope, attemptId: "paid", actualNano: 26 });
  await store.reserve({ envelope, attemptId: "flying", amountNano: 10, limitNano: 100 });
  await store.reserve({ envelope, attemptId: "lost", amountNano: 40, limitNano: 100 });
  await store.retain({ envelope, attemptId: "lost" });
  await store.allowPaid({ envelope, note: "restart check" });
  const before = await store.totals(envelope);
  say(`Before: ${JSON.stringify(before)}`, "终止前的记录如上");
  await redis.close();

  // ---- Kill it without warning, then bring it back on the same volume. ----
  say("Killing that Redis process and starting it again...", "强制终止该 Redis 进程并重新启动……");
  docker("kill", "-s", "SIGKILL", name);
  docker("start", name);

  // ---- After: a fresh connection must see exactly the same record. ----
  redis = await connect(url);
  store = new RedisSpendStore(redis.runner, { prefix: "ta-restart-check" });
  say("After:", "重启后：");
  expect("totals are unchanged", "合计不变", await store.totals(envelope), before);
  expect("the limit is unchanged", "上限不变", await store.limit(envelope), 100);
  for (const [id, state] of [["paid", "settled"], ["flying", "reserved"], ["lost", "retained"]] as const) {
    const again = await store.reserve({ envelope, attemptId: id, amountNano: 1, limitNano: 100 });
    expect(`"${id}" is still known, as ${state}`, `"${id}" 仍在记录中（${state}）`, again.ok && again.duplicate ? again.state : "not a duplicate", state);
  }
  expect("a 25-unit hold is refused (76 + 25 > 100)", "25 单位的预留被拒绝", (await store.reserve({ envelope, attemptId: "new-25", amountNano: 25, limitNano: 100 })).ok, false);
  expect("a 24-unit hold fits exactly (76 + 24 = 100)", "24 单位的预留恰好放得下", (await store.reserve({ envelope, attemptId: "new-24", amountNano: 24, limitNano: 100 })).ok, true);
  expect("the totals still equal what the attempts add up to", "合计仍与逐笔记录一致", (await store.audit(envelope)).consistent, true);
  await redis.close();
} finally {
  // Only what this run created, by the names it created them under.
  docker("rm", "-f", name);
  docker("volume", "rm", volume);
}

console.log();
if (failures === 0) say("The record survived the restart.", "记录在重启后完好无损。");
else say(`${failures} check(s) failed.`, `${failures} 项检查未通过。`);
process.exit(failures === 0 ? 0 : 1);
