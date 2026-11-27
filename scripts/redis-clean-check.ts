/**
 * After the Redis tests: nothing of theirs may be left in the store.
 * Redis 测试之后：存储里不能留下任何测试键。
 *
 *   TEST_REDIS_URL=… npm run check:redis-clean
 *       Says whether any key whose name starts with "ta-test-" exists, and fails if one does.
 *       It reads names only, in small batches, never a value, and writes nothing. It is meant
 *       for a test database of its own: in a store that other runs share, a key it finds may
 *       belong to a run that is still going, which is why it never deletes on that evidence.
 *
 *   TEST_REDIS_URL=… npm run check:redis-clean -- --remove-run ta-test-<the run's id>
 *       Removes the keys of one abandoned run, named exactly: a run that was killed before it
 *       could clean up. Each run prints its prefix before it writes anything. Nothing outside
 *       that one prefix is touched.
 */
import { Redis } from "ioredis";
import { scanKeys } from "../src/spend/redis-keys";
import { say } from "./say";

const url = process.env.TEST_REDIS_URL;
if (!url) {
  say("TEST_REDIS_URL is not set. Nothing was checked.", "未设置 TEST_REDIS_URL。没有检查任何内容。");
  process.exit(1);
}
const args = process.argv.slice(2);
/** One run's prefix, whole: "ta-test-" or "ta-test-lease-" and a random id. */
const RUN = /^ta-test-(?:lease-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let removeRun: string | null = null;
if (args.length > 0) {
  if (args.length !== 2 || args[0] !== "--remove-run" || !RUN.test(args[1] ?? "")) {
    say('Usage: [--remove-run ta-test-<run id>]. The run id must be given whole. Nothing was done.', "用法：[--remove-run ta-test-<运行编号>]。运行编号必须完整给出。没有执行任何操作。");
    process.exit(1);
  }
  removeRun = args[1]!;
}

const redis = new Redis(url, { maxRetriesPerRequest: 2 });
redis.on("error", () => undefined);
try {
  if (removeRun) {
    // The run's spend keys are "<prefix>:{…}"; a lease's key is the prefix itself.
    const keys = [...(await scanKeys(redis, `${removeRun}:*`)), ...(await scanKeys(redis, removeRun))];
    if (keys.length > 0) await redis.del(...keys);
    say(`Removed ${keys.length} key(s) of the run ${removeRun}.`, `已删除运行 ${removeRun} 的 ${keys.length} 个键。`);
  } else if ((await scanKeys(redis, "ta-test-*", 1)).length > 0) {
    say('At least one test key was left behind (a name starting "ta-test-").', "至少留下了一个测试键（名称以 \"ta-test-\" 开头）。");
    process.exitCode = 1;
  } else say("No test keys were left behind.", "没有留下任何测试键。");
} finally {
  redis.disconnect();
}
