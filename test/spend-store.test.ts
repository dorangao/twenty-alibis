import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMetered } from "../src/metered";
import { FakeProvider, textResponse } from "../src/provider/fake";
import { worstCaseNano } from "../src/spend/pricing";
import { connectRedis } from "../src/spend/redis-client";
import { EnvelopeNotInitializedError, RedisSpendStore } from "../src/spend/redis-store";
import { MemorySpendStore, type SpendStore } from "../src/spend/store";

/**
 * One set of behaviours that every spend store must have. It runs against the in-memory
 * store always, and against a real Redis when TEST_REDIS_URL is set (locally:
 * `npm run redis:up`, then `npm run test:redis`; in CI: a Redis service container).
 * Redis tests use their own key prefix and database, never the real counters.
 */
interface Context {
  store: SpendStore;
  /** Make an envelope usable. The in-memory store needs nothing. */
  prepare(envelope: string): Promise<void>;
}

function contract(name: string, setup: () => Promise<Context>) {
  describe(`spend store contract: ${name}`, () => {
    let ctx: Context;
    const fresh = async () => {
      const envelope = `env-${randomUUID()}`;
      await ctx.prepare(envelope);
      return envelope;
    };
    beforeAll(async () => {
      ctx = await setup();
    });

    it("admits up to the limit exactly, then refuses", async () => {
      const envelope = await fresh();
      const reserve = (attemptId: string, amountNano: number) => ctx.store.reserve({ envelope, attemptId, amountNano, limitNano: 1_000 });
      expect((await reserve("a", 600)).ok).toBe(true);
      expect((await reserve("b", 400)).ok).toBe(true);
      const refused = await reserve("c", 1);
      expect(refused).toMatchObject({ ok: false, reason: "limit" });
      expect(refused.totals).toMatchObject({ heldNano: 1_000, committedNano: 1_000, attempts: 2 });
    });

    it("reports a repeated attempt id as a duplicate and counts it once", async () => {
      const envelope = await fresh();
      const args = { envelope, attemptId: "a", amountNano: 300, limitNano: 1_000 };
      expect(await ctx.store.reserve(args)).toMatchObject({ ok: true, duplicate: false });
      expect(await ctx.store.reserve(args)).toMatchObject({ ok: true, duplicate: true, state: "reserved" });
      expect((await ctx.store.totals(envelope)).heldNano).toBe(300);
    });

    it("replaces a hold with the real cost, once", async () => {
      const envelope = await fresh();
      await ctx.store.reserve({ envelope, attemptId: "a", amountNano: 1_000, limitNano: 10_000 });
      const first = await ctx.store.settle({ envelope, attemptId: "a", actualNano: 400 });
      expect(first).toMatchObject({ applied: true, overHold: false });
      expect(first.totals).toMatchObject({ settledNano: 400, heldNano: 0, committedNano: 400 });
      const second = await ctx.store.settle({ envelope, attemptId: "a", actualNano: 900 });
      expect(second.applied).toBe(false);
      expect(second.totals.settledNano).toBe(400);
    });

    it("keeps a retained hold charged until its real cost is known", async () => {
      const envelope = await fresh();
      await ctx.store.reserve({ envelope, attemptId: "a", amountNano: 1_000, limitNano: 10_000 });
      expect(await ctx.store.retain({ envelope, attemptId: "a" })).toMatchObject({ heldNano: 0, retainedNano: 1_000, committedNano: 1_000 });
      // Retaining twice changes nothing.
      expect((await ctx.store.retain({ envelope, attemptId: "a" })).retainedNano).toBe(1_000);
      const settled = await ctx.store.settle({ envelope, attemptId: "a", actualNano: 300 });
      expect(settled.totals).toMatchObject({ settledNano: 300, retainedNano: 0, committedNano: 300 });
      expect((await ctx.store.retain({ envelope, attemptId: "a" })).committedNano).toBe(300);
    });

    it("charges a cost above the hold in full and flags it", async () => {
      const envelope = await fresh();
      await ctx.store.reserve({ envelope, attemptId: "a", amountNano: 1_000, limitNano: 10_000 });
      const result = await ctx.store.settle({ envelope, attemptId: "a", actualNano: 1_500 });
      expect(result).toMatchObject({ applied: true, overHold: true });
      expect(result.totals.settledNano).toBe(1_500);
    });

    it("rejects settling or retaining an attempt it has never seen", async () => {
      const envelope = await fresh();
      await expect(ctx.store.settle({ envelope, attemptId: "ghost", actualNano: 1 })).rejects.toThrow();
      await expect(ctx.store.retain({ envelope, attemptId: "ghost" })).rejects.toThrow();
    });

    it("keeps envelopes separate", async () => {
      const [one, two] = [await fresh(), await fresh()];
      await ctx.store.reserve({ envelope: one, attemptId: "a", amountNano: 900, limitNano: 1_000 });
      expect((await ctx.store.reserve({ envelope: two, attemptId: "a", amountNano: 900, limitNano: 1_000 })).ok).toBe(true);
      expect((await ctx.store.reserve({ envelope: one, attemptId: "b", amountNano: 200, limitNano: 1_000 })).ok).toBe(false);
    });

    it("rejects amounts that are not whole nanodollars", async () => {
      const envelope = await fresh();
      await expect(ctx.store.reserve({ envelope, attemptId: "a", amountNano: 0.5, limitNano: 10 })).rejects.toThrow();
      await expect(ctx.store.reserve({ envelope, attemptId: "a", amountNano: -1, limitNano: 10 })).rejects.toThrow();
    });

    it("lets exactly as many simultaneous callers in as the limit covers", async () => {
      const envelope = await fresh();
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => ctx.store.reserve({ envelope, attemptId: `a${i}`, amountNano: 300, limitNano: 1_000 })),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      expect(await ctx.store.totals(envelope)).toMatchObject({ heldNano: 900, committedNano: 900, attempts: 3 });
    });

    it("never lets committed spend pass the limit under mixed traffic", async () => {
      const envelope = await fresh();
      const limitNano = 5_000;
      let seed = 20261124;
      const next = (n: number) => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) % n;
      const open: string[] = [];
      for (let step = 0; step < 150; step++) {
        const action = next(3);
        if (action === 0 || open.length === 0) {
          const attemptId = `m${step}`;
          const result = await ctx.store.reserve({ envelope, attemptId, amountNano: 100 + next(900), limitNano });
          if (result.ok) open.push(attemptId);
        } else if (action === 1) {
          const attemptId = open.splice(next(open.length), 1)[0]!;
          await ctx.store.settle({ envelope, attemptId, actualNano: next(100) });
        } else {
          await ctx.store.retain({ envelope, attemptId: open[next(open.length)]! });
        }
        const totals = await ctx.store.totals(envelope);
        expect(totals.committedNano).toBeLessThanOrEqual(limitNano);
        expect(totals.committedNano).toBe(totals.settledNano + totals.heldNano + totals.retainedNano);
      }
    });

    it("works behind metered(): a refused request is never sent", async () => {
      const envelope = await fresh();
      const hold = worstCaseNano(100);
      const provider = new FakeProvider(() => textResponse("ok", { inputTokens: 3_500, cachedTokens: 2_800, outputTokens: 250 }));
      const metered = createMetered({ provider, store: ctx.store, envelope, limitNano: hold + 206_200 });
      const request = { step: "t", promptId: "p", messages: [{ role: "user" as const, content: "hi" }], maxOutputTokens: 100 };
      expect((await metered(request)).ok).toBe(true); // settles at 206,200
      expect((await metered(request)).ok).toBe(true); // exactly enough room for one more hold
      expect(await metered(request)).toMatchObject({ ok: false, sent: false, reason: "envelope-exhausted" });
      expect(provider.dispatched).toBe(2);
    });
  });
}

contract("in memory", async () => ({ store: new MemorySpendStore(), prepare: async () => {} }));

const redisUrl = process.env.TEST_REDIS_URL;
const prefix = `ta-test-${randomUUID()}`;

if (redisUrl) {
  contract("Redis", async () => {
    const { runner } = await connectRedis(redisUrl);
    const store = new RedisSpendStore(runner, { prefix });
    return { store, prepare: async (envelope) => void (await store.init({ envelope, limitNano: 1_000_000_000_000 })) };
  });
}

describe.skipIf(!redisUrl)("Redis spend store", () => {
  let store: RedisSpendStore;
  let admin: Redis;
  const fresh = () => `env-${randomUUID()}`;

  beforeAll(async () => {
    store = new RedisSpendStore((await connectRedis(redisUrl!)).runner, { prefix });
    admin = new Redis(redisUrl!);
  });
  afterAll(async () => {
    const keys = await admin.keys(`${prefix}:*`);
    if (keys.length) await admin.del(...keys);
    admin.disconnect();
  });

  it("refuses everything for an envelope that was never initialized", async () => {
    const envelope = fresh();
    await expect(store.reserve({ envelope, attemptId: "a", amountNano: 1, limitNano: 1_000 })).rejects.toBeInstanceOf(EnvelopeNotInitializedError);
    await expect(store.totals(envelope)).rejects.toBeInstanceOf(EnvelopeNotInitializedError);
  });

  it("fixes the limit at initialization: a later init or a higher request cannot raise it", async () => {
    const envelope = fresh();
    expect(await store.init({ envelope, limitNano: 1_000 })).toMatchObject({ created: true, limitNano: 1_000 });
    expect(await store.init({ envelope, limitNano: 9_000_000 })).toMatchObject({ created: false, limitNano: 1_000 });
    expect(await store.limit(envelope)).toBe(1_000);
    // The caller asks for a much higher limit; the fixed one still applies.
    expect((await store.reserve({ envelope, attemptId: "a", amountNano: 1_001, limitNano: 9_000_000 })).ok).toBe(false);
    // A caller may pass a lower limit.
    expect((await store.reserve({ envelope, attemptId: "b", amountNano: 600, limitNano: 500 })).ok).toBe(false);
    expect((await store.reserve({ envelope, attemptId: "c", amountNano: 1_000, limitNano: 9_000_000 })).ok).toBe(true);
  });

  it("counts spend carried over from before the record existed", async () => {
    const envelope = fresh();
    await store.init({ envelope, limitNano: 1_000, carriedNano: 700 });
    expect(await store.totals(envelope)).toMatchObject({ settledNano: 700, committedNano: 700 });
    expect((await store.reserve({ envelope, attemptId: "a", amountNano: 301, limitNano: 1_000 })).ok).toBe(false);
    expect((await store.reserve({ envelope, attemptId: "b", amountNano: 300, limitNano: 1_000 })).ok).toBe(true);
  });

  it("refuses, instead of counting from zero, when the counter is lost", async () => {
    const envelope = fresh();
    await store.init({ envelope, limitNano: 1_000 });
    await store.reserve({ envelope, attemptId: "a", amountNano: 900, limitNano: 1_000 });
    // Lose the totals but keep the rest, as a partial data loss would.
    await admin.del(`${prefix}:{${envelope}}:totals`);
    await expect(store.reserve({ envelope, attemptId: "b", amountNano: 1, limitNano: 1_000 })).rejects.toBeInstanceOf(EnvelopeNotInitializedError);
    // Lose everything.
    const keys = await admin.keys(`${prefix}:{${envelope}}:*`);
    await admin.del(...keys);
    await expect(store.reserve({ envelope, attemptId: "c", amountNano: 1, limitNano: 1_000 })).rejects.toBeInstanceOf(EnvelopeNotInitializedError);
  });

  it("holds totals up to the whole budget without losing precision", async () => {
    const envelope = fresh();
    const tenDollars = 10_000_000_000;
    await store.init({ envelope, limitNano: tenDollars, carriedNano: tenDollars - 20_050_001 });
    expect((await store.reserve({ envelope, attemptId: "a", amountNano: 20_050_000, limitNano: tenDollars })).ok).toBe(true);
    expect((await store.totals(envelope)).committedNano).toBe(tenDollars - 1);
    expect((await store.reserve({ envelope, attemptId: "b", amountNano: 2, limitNano: tenDollars })).ok).toBe(false);
  });

  it("shares one counter between separate connections", async () => {
    const envelope = fresh();
    await store.init({ envelope, limitNano: 1_000 });
    const other = new RedisSpendStore((await connectRedis(redisUrl!)).runner, { prefix });
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 ? store : other).reserve({ envelope, attemptId: `a${i}`, amountNano: 300, limitNano: 1_000 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });
});
