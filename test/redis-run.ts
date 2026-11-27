import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { Redis } from "ioredis";
import { afterAll } from "vitest";
import { scanKeys } from "../src/spend/redis-keys";

/** Set when the Redis tests are to run (locally: `npm run redis:up`, then `npm run test:redis`). */
export const redisUrl = process.env.TEST_REDIS_URL;

/**
 * The key prefix of one test file's run, and its cleanup.
 *
 * Every key the file writes must be under the prefix. The prefix is said on standard error
 * before anything is written, so a run that is killed has still said what it may have left
 * (`npm run check:redis-clean -- --remove-run <prefix>` removes exactly that). When the file
 * is done, its keys are found in small batches and removed; nothing else is touched.
 */
export function redisRun(): string {
  const prefix = `ta-test-${randomUUID()}`;
  if (redisUrl) writeSync(2, `Redis test keys of this run start with ${prefix}\n`);
  afterAll(async () => {
    if (!redisUrl) return;
    const admin = new Redis(redisUrl);
    try {
      const keys = await scanKeys(admin, `${prefix}:*`);
      if (keys.length) await admin.del(...keys);
    } finally {
      admin.disconnect();
    }
  });
  return prefix;
}
