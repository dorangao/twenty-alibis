/**
 * After the Redis tests: nothing of theirs may be left in the store.
 * Redis 测试之后：存储里不能留下任何测试键。
 *
 *   TEST_REDIS_URL=… npm run check:redis-clean
 *
 * Every key a test writes starts with "ta-test-". This counts them and fails if there are any.
 * It reads key names only, and never a value.
 */
import { Redis } from "ioredis";
import { say } from "./say";

const url = process.env.TEST_REDIS_URL;
if (!url) {
  say("TEST_REDIS_URL is not set. Nothing was checked.", "未设置 TEST_REDIS_URL。没有检查任何内容。");
  process.exit(1);
}
const redis = new Redis(url, { maxRetriesPerRequest: 2 });
redis.on("error", () => undefined);
try {
  const left = (await redis.keys("ta-test-*")).length;
  if (left > 0) {
    say(`${left} test key(s) were left behind (names starting "ta-test-").`, `留下了 ${left} 个测试键（名称以 "ta-test-" 开头）。`);
    process.exitCode = 1;
  } else say("No test keys were left behind.", "没有留下任何测试键。");
} finally {
  redis.disconnect();
}
