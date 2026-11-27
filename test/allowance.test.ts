import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectRedis } from "../src/spend/redis-client";
import type { ScriptRunner } from "../src/spend/redis-store";
import { DEFAULT_LIMITS, memoryAllowance, redisAllowance, type Allowance, type AllowanceLimits } from "../src/web/allowance";
import { redisRun, redisUrl } from "./redis-run";

const HOUR = 60 * 60 * 1_000;
/** A clock a test can move. It starts in the middle of an hour, so a few minutes later is the same hour. */
const clock = () => {
  const state = { at: 1_000 * HOUR + 10 * 60 * 1_000 };
  return { now: () => state.at, state };
};

/**
 * What every allowance must do, in memory and in Redis. The hour's count goes by the clock
 * it is given; a visitor's window in Redis goes by Redis's own clock, so that part has its
 * own test for each.
 */
function contract(name: string, make: (limits: AllowanceLimits, now: () => number) => Allowance) {
  describe(`allowance contract: ${name}`, () => {
    const visitor = () => randomUUID();
    const limits = (over: Partial<AllowanceLimits>): AllowanceLimits => ({ ...DEFAULT_LIMITS, ...over });

    it("lets a visitor start so many games and no more, and counts nothing for a refusal", async () => {
      const { now } = clock();
      const allowance = make(limits({ sessionsPerVisitor: 2, sessionsPerHour: 100 }), now);
      const [a, b] = [visitor(), visitor()];
      expect(await allowance.session(a)).toBe("ok");
      expect(await allowance.session(a)).toBe("ok");
      expect(await allowance.session(a)).toBe("visitor");
      expect(await allowance.session(a)).toBe("visitor");
      // Another visitor has their own count.
      expect(await allowance.session(b)).toBe("ok");
    });

    it("lets everyone together start so many games in an hour; a refusal is not counted against anyone, and the next hour starts again", async () => {
      const { now, state } = clock();
      const allowance = make(limits({ sessionsPerVisitor: 3, sessionsPerHour: 3 }), now);
      const a = visitor();
      for (let i = 0; i < 3; i++) expect(await allowance.session(visitor())).toBe("ok");
      expect(await allowance.session(a)).toBe("site");
      expect(await allowance.session(a)).toBe("site");
      // A few minutes later it is the same hour.
      state.at += 20 * 60 * 1_000;
      expect(await allowance.session(a)).toBe("site");
      // The next hour. The refusals above were not counted: this visitor still has all three.
      state.at += HOUR;
      for (let i = 0; i < 3; i++) expect(await allowance.session(a)).toBe("ok");
      expect(await allowance.session(visitor())).toBe("site");
    });

    it("a visitor at their own limit is told so even when the hour is full too", async () => {
      const { now } = clock();
      const allowance = make(limits({ sessionsPerVisitor: 1, sessionsPerHour: 1 }), now);
      const a = visitor();
      expect(await allowance.session(a)).toBe("ok");
      expect(await allowance.session(a)).toBe("visitor");
      expect(await allowance.session(visitor())).toBe("site");
    });

    it("gives a visitor so many requests and no more, apart from the games they start", async () => {
      const { now } = clock();
      const allowance = make(limits({ requestsPerVisitor: 3, sessionsPerVisitor: 1 }), now);
      const [a, b] = [visitor(), visitor()];
      expect(await allowance.session(a)).toBe("ok");
      expect([await allowance.request(a), await allowance.request(a), await allowance.request(a)]).toEqual([true, true, true]);
      expect(await allowance.request(a)).toBe(false);
      expect(await allowance.request(a)).toBe(false);
      expect(await allowance.request(b)).toBe(true);
      // Requests used do not start games, and games started do not use requests.
      expect(await allowance.session(a)).toBe("visitor");
      expect(await allowance.session(b)).toBe("ok");
    });

    it("takes exactly as many as there are when many ask at once", async () => {
      const { now } = clock();
      const allowance = make(limits({ requestsPerVisitor: 5, sessionsPerVisitor: 4, sessionsPerHour: 100 }), now);
      const a = visitor();
      const requests = await Promise.all(Array.from({ length: 20 }, () => allowance.request(a)));
      expect(requests.filter(Boolean)).toHaveLength(5);
      const sessions = await Promise.all(Array.from({ length: 20 }, () => allowance.session(a)));
      expect(sessions.filter((s) => s === "ok")).toHaveLength(4);
    });
  });
}

contract("in memory", (limits, now) => memoryAllowance(limits, now));

describe("the allowance in memory", () => {
  it("a visitor's counts start again one window after their first use, not their last", async () => {
    const { now, state } = clock();
    const allowance = memoryAllowance({ ...DEFAULT_LIMITS, requestsPerVisitor: 1, sessionsPerVisitor: 1, visitorWindowMs: 1_000 }, now);
    expect(await allowance.request("a")).toBe(true);
    state.at += 900;
    expect(await allowance.request("a")).toBe(false);
    expect(await allowance.session("a")).toBe("ok");
    state.at += 99;
    expect(await allowance.request("a")).toBe(false);
    state.at += 1;
    expect(await allowance.request("a")).toBe(true);
    expect(await allowance.session("a")).toBe("ok");
  });
});

const prefix = redisRun();

if (redisUrl) {
  let runner: ScriptRunner;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const connection = await connectRedis(redisUrl!);
    runner = connection.runner;
    close = connection.close;
  });
  afterAll(() => close?.());
  contract("Redis", (limits, now) => redisAllowance({ eval: (...args) => runner.eval(...args) }, { prefix: `${prefix}:${randomUUID()}`, limits, now }));
}

describe.skipIf(!redisUrl)("the allowance in Redis", () => {
  let runner: ScriptRunner;
  let close: () => Promise<void>;
  let admin: Redis;
  const own = () => `${prefix}:${randomUUID()}`;

  beforeAll(async () => {
    const connection = await connectRedis(redisUrl!);
    runner = connection.runner;
    close = connection.close;
    admin = new Redis(redisUrl!);
  });
  afterAll(async () => {
    admin.disconnect();
    await close();
  });

  it("keeps its counts under its prefix, each with a time limit that later use does not move", async () => {
    const p = own();
    const { now } = clock();
    const allowance = redisAllowance(runner, { prefix: p, limits: { ...DEFAULT_LIMITS, visitorWindowMs: 60_000 }, now });
    await allowance.request("v");
    const first = await admin.pttl(`${p}:v:v`);
    expect(first).toBeGreaterThan(50_000);
    expect(first).toBeLessThanOrEqual(60_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await allowance.session("v");
    await allowance.request("v");
    expect(await admin.pttl(`${p}:v:v`)).toBeLessThan(first);
    expect(await admin.hgetall(`${p}:v:v`)).toEqual({ requests: "2", sessions: "1" });
    // The same when the first thing a visitor does is start a game.
    await allowance.session("w");
    const started = await admin.pttl(`${p}:v:w`);
    expect(started).toBeGreaterThan(50_000);
    expect(started).toBeLessThanOrEqual(60_000);
    const hour = `${p}:new:${Math.floor(now() / HOUR)}`;
    expect(await admin.get(hour)).toBe("2");
    const kept = await admin.pttl(hour);
    expect(kept).toBeGreaterThan(HOUR);
    expect(kept).toBeLessThanOrEqual(2 * HOUR);
  });

  it("a visitor's counts are gone one window after their first use", async () => {
    const allowance = redisAllowance(runner, { prefix: own(), limits: { ...DEFAULT_LIMITS, requestsPerVisitor: 1, visitorWindowMs: 200 } });
    expect(await allowance.request("v")).toBe(true);
    expect(await allowance.request("v")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(await allowance.request("v")).toBe(true);
  });

  it("two workers count in the same place", async () => {
    const p = own();
    const second = await connectRedis(redisUrl!);
    try {
      const limits = { ...DEFAULT_LIMITS, requestsPerVisitor: 3 };
      const workers = [redisAllowance(runner, { prefix: p, limits }), redisAllowance(second.runner, { prefix: p, limits })];
      const taken = await Promise.all(Array.from({ length: 12 }, (_, i) => workers[i % 2]!.request("v")));
      expect(taken.filter(Boolean)).toHaveLength(3);
    } finally {
      await second.close();
    }
  });

  it("a count that is damaged is never read as zero: the call rejects and nothing is counted", async () => {
    const p = own();
    const allowance = redisAllowance(runner, { prefix: p });
    for (const damage of ["many", "-1", "1.5", ""]) {
      await admin.hset(`${p}:v:v`, "requests", damage, "sessions", damage);
      await expect(allowance.request("v")).rejects.toThrow();
      await expect(allowance.session("v")).rejects.toThrow();
      expect(await admin.hget(`${p}:v:v`, "requests")).toBe(damage);
    }
    const hour = `${p}:new:${Math.floor(Date.now() / HOUR)}`;
    await admin.set(hour, "lots");
    await expect(allowance.session("w")).rejects.toThrow();
    expect(await admin.exists(`${p}:v:w`)).toBe(0);
  });

  it("when Redis refuses, both calls reject", async () => {
    const down: ScriptRunner = { eval: () => Promise.reject(new Error("connection refused")) };
    const allowance = redisAllowance(down, { prefix: own() });
    await expect(allowance.session("v")).rejects.toThrow("connection refused");
    await expect(allowance.request("v")).rejects.toThrow("connection refused");
  });
});
