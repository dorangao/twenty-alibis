import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMetered } from "../src/metered";
import { FakeProvider, textResponse } from "../src/provider/fake";
import { worstCaseNano } from "../src/spend/pricing";
import { connectRedis } from "../src/spend/redis-client";
import { scanKeys } from "../src/spend/redis-keys";
import { EnvelopeCorruptError, EnvelopeNotInitializedError, RedisSpendStore } from "../src/spend/redis-store";
import { MemorySpendStore, type SpendStore } from "../src/spend/store";

// Most tests here are about something other than hold size, so they run with a measured
// input bound in place and get the low-tier hold. Hold selection has its own tests.
const CALIBRATED = { inputBound: { tokensPerByte: 100 } };

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

    it("suspends the envelope in the same step as a cost above its hold", async () => {
      const envelope = await fresh();
      await ctx.store.reserve({ envelope, attemptId: "a", amountNano: 1_000, limitNano: 10_000 });
      expect((await ctx.store.totals(envelope)).suspended).toBeNull();
      const result = await ctx.store.settle({ envelope, attemptId: "a", actualNano: 1_500 });
      expect(result.totals.suspended).toMatch(/attempt a cost 1500, above its hold of 1000/);
      // Plenty of room is left, but nothing more is admitted.
      expect(await ctx.store.reserve({ envelope, attemptId: "b", amountNano: 1, limitNano: 10_000 })).toMatchObject({ ok: false, reason: "suspended" });
    });

    it("when suspended, admits nothing new but still settles and retains what is in flight", async () => {
      const envelope = await fresh();
      await ctx.store.reserve({ envelope, attemptId: "flying", amountNano: 400, limitNano: 10_000 });
      await ctx.store.reserve({ envelope, attemptId: "lost", amountNano: 400, limitNano: 10_000 });
      expect((await ctx.store.suspend({ envelope, reason: "operator stop" })).suspended).toBe("operator stop");
      // A second reason does not replace the first.
      expect((await ctx.store.suspend({ envelope, reason: "something else" })).suspended).toBe("operator stop");

      expect(await ctx.store.reserve({ envelope, attemptId: "new", amountNano: 1, limitNano: 10_000 })).toMatchObject({ ok: false, reason: "suspended" });
      // A repeated id is still reported as a duplicate, so it is not sent either.
      expect(await ctx.store.reserve({ envelope, attemptId: "flying", amountNano: 400, limitNano: 10_000 })).toMatchObject({ ok: true, duplicate: true });
      expect((await ctx.store.settle({ envelope, attemptId: "flying", actualNano: 90 })).applied).toBe(true);
      expect(await ctx.store.retain({ envelope, attemptId: "lost" })).toMatchObject({ settledNano: 90, heldNano: 0, retainedNano: 400, attempts: 2 });
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
      const provider = new FakeProvider(() => textResponse("ok", { inputTokens: 3_500, cachedTokens: 2_800, outputTokens: 25 }));
      const metered = createMetered({ ...CALIBRATED, provider, store: ctx.store, envelope, limitNano: hold + 93_700 });
      const request = (attemptId: string) => ({ step: "t", promptId: "p", attemptId, messages: [{ role: "user" as const, content: "hi" }], maxOutputTokens: 100 });
      expect((await metered(request("one"))).ok).toBe(true); // settles at 93,700
      expect((await metered(request("two"))).ok).toBe(true); // exactly enough room for one more hold
      expect(await metered(request("three"))).toMatchObject({ ok: false, sent: false, reason: "envelope-exhausted" });
      // The same action delivered again is not sent again.
      expect(await metered(request("one"))).toMatchObject({ ok: false, sent: false, reason: "duplicate-attempt" });
      expect(provider.dispatched).toBe(2);
    });
  });
}

contract("in memory", async () => ({ store: new MemorySpendStore(), prepare: async () => {} }));

const redisUrl = process.env.TEST_REDIS_URL;
const prefix = `ta-test-${randomUUID()}`;

// Every key a Redis test in this file writes is under `prefix`, which is this run's alone.
// They are removed once, when the whole file is done. Cleaning up inside one group of tests
// is not enough: the groups after it write under the same prefix. Only this run's prefix is
// ever removed, and its keys are found in small batches, never with a database-wide KEYS.
//
// A run that is killed cannot clean up, and these keys do not expire. So the prefix is said
// before anything is written: `npm run check:redis-clean -- --remove-run <prefix>` removes
// exactly that run's keys afterwards.
// Written straight to standard error, at once and before any test runs. The test runner holds
// back what a test logs through the console, and under some reporters never shows it: a run
// that was killed would then have left keys behind without ever having said which.
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
  afterAll(() => admin.disconnect());

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

  it("keeps the limit, the totals and every attempt in one key that never expires", async () => {
    const envelope = fresh();
    await store.init({ envelope, limitNano: 1_000 });
    await store.reserve({ envelope, attemptId: "a", amountNano: 300, limitNano: 1_000 });
    await store.reserve({ envelope, attemptId: "b", amountNano: 300, limitNano: 1_000 });
    expect(await scanKeys(admin, `${store.keyOf(envelope)}*`)).toEqual([store.keyOf(envelope)]);
    expect(await admin.ttl(store.keyOf(envelope))).toBe(-1);
  });

  it.each(["limit", "settled", "held", "retained", "attempts"])(
    "refuses to read a missing %s as zero, and refuses to initialize over the damage",
    async (field) => {
      const envelope = fresh();
      await store.init({ envelope, limitNano: 1_000 });
      await store.reserve({ envelope, attemptId: "a", amountNano: 900, limitNano: 1_000 });
      await admin.hdel(store.keyOf(envelope), field);

      await expect(store.reserve({ envelope, attemptId: "b", amountNano: 1, limitNano: 1_000 })).rejects.toBeInstanceOf(EnvelopeCorruptError);
      await expect(store.settle({ envelope, attemptId: "a", actualNano: 1 })).rejects.toBeInstanceOf(EnvelopeCorruptError);
      await expect(store.retain({ envelope, attemptId: "a" })).rejects.toBeInstanceOf(EnvelopeCorruptError);
      await expect(store.totals(envelope)).rejects.toBeInstanceOf(EnvelopeCorruptError);
      // Initializing again would wipe what survives, so it is refused too.
      await expect(store.init({ envelope, limitNano: 1_000 })).rejects.toBeInstanceOf(EnvelopeCorruptError);
      expect(await admin.hget(store.keyOf(envelope), "a:a")).toBe("reserved|900|0");
    },
  );

  it("refuses a total that is not a number", async () => {
    const envelope = fresh();
    await store.init({ envelope, limitNano: 1_000 });
    await admin.hset(store.keyOf(envelope), "held", "plenty");
    await expect(store.reserve({ envelope, attemptId: "a", amountNano: 1, limitNano: 1_000 })).rejects.toBeInstanceOf(EnvelopeCorruptError);
  });

  it("refuses, instead of counting from zero, when the whole record is lost", async () => {
    const envelope = fresh();
    await store.init({ envelope, limitNano: 1_000 });
    await store.reserve({ envelope, attemptId: "a", amountNano: 900, limitNano: 1_000 });
    await admin.del(store.keyOf(envelope));
    const error = await store.reserve({ envelope, attemptId: "c", amountNano: 1, limitNano: 1_000 }).catch((e) => e);
    expect(error).toBeInstanceOf(EnvelopeNotInitializedError);
    expect(error).not.toBeInstanceOf(EnvelopeCorruptError);
  });

  it("lists attempts and audits the totals against them", async () => {
    const envelope = fresh();
    await store.init({ envelope, limitNano: 10_000, carriedNano: 50 });
    await store.reserve({ envelope, attemptId: "paid", amountNano: 1_000, limitNano: 10_000 });
    await store.reserve({ envelope, attemptId: "flying", amountNano: 1_000, limitNano: 10_000 });
    await store.reserve({ envelope, attemptId: "lost", amountNano: 1_000, limitNano: 10_000 });
    await store.settle({ envelope, attemptId: "paid", actualNano: 120 });
    await store.retain({ envelope, attemptId: "lost" });

    expect((await store.attempts(envelope)).sort((a, b) => a.attemptId.localeCompare(b.attemptId))).toEqual([
      { attemptId: "flying", state: "reserved", holdNano: 1_000, chargedNano: 0 },
      { attemptId: "lost", state: "retained", holdNano: 1_000, chargedNano: 0 },
      { attemptId: "paid", state: "settled", holdNano: 1_000, chargedNano: 120 },
    ]);
    const audit = await store.audit(envelope);
    expect(audit.consistent).toBe(true);
    expect(audit.fromAttempts).toEqual({ settledNano: 170, heldNano: 1_000, retainedNano: 1_000, attempts: 3 });

    // Someone edits a total by hand. The audit sees that it no longer adds up.
    await admin.hset(store.keyOf(envelope), "settled", "0");
    expect((await store.audit(envelope)).consistent).toBe(false);
  });

  it("stays suspended across connections until an operator resumes it", async () => {
    const envelope = fresh();
    await store.init({ envelope, limitNano: 10_000 });
    const other = new RedisSpendStore((await connectRedis(redisUrl!)).runner, { prefix });
    await other.suspend({ envelope, reason: "stop from another process" });
    expect(await store.reserve({ envelope, attemptId: "a", amountNano: 1, limitNano: 10_000 })).toMatchObject({ ok: false, reason: "suspended" });
    expect((await store.resume(envelope)).suspended).toBeNull();
    expect((await other.reserve({ envelope, attemptId: "a", amountNano: 1, limitNano: 10_000 })).ok).toBe(true);
  });

  it("rejects an attempt id that could not be stored safely", async () => {
    const envelope = fresh();
    await store.init({ envelope, limitNano: 10_000 });
    await expect(store.reserve({ envelope, attemptId: "a|b", amountNano: 1, limitNano: 10_000 })).rejects.toThrow();
    await expect(store.reserve({ envelope, attemptId: "", amountNano: 1, limitNano: 10_000 })).rejects.toThrow();
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

describe.skipIf(!redisUrl)("Redis spend store: paid authorization and the measured bound", () => {
  let store: RedisSpendStore;
  const fresh = async () => {
    const envelope = `env-${randomUUID()}`;
    await store.init({ envelope, limitNano: 10_000 });
    return envelope;
  };
  beforeAll(async () => {
    store = new RedisSpendStore((await connectRedis(redisUrl!)).runner, { prefix });
  });

  it("refuses a billable request until paid requests are authorized, in the same atomic step", async () => {
    const envelope = await fresh();
    expect(await store.reserve({ envelope, attemptId: "a", amountNano: 1, limitNano: 10_000, billable: true })).toMatchObject({ ok: false, reason: "paid-not-enabled" });
    // A request that spends nothing is not affected.
    expect((await store.reserve({ envelope, attemptId: "free", amountNano: 1, limitNano: 10_000 })).ok).toBe(true);

    await expect(store.allowPaid({ envelope, note: "" })).rejects.toThrow();
    expect((await store.allowPaid({ envelope, note: "Doran, Nov 25" })).paidAllowed).toBe("Doran, Nov 25");
    expect((await store.reserve({ envelope, attemptId: "a", amountNano: 1, limitNano: 10_000, billable: true })).ok).toBe(true);

    expect((await store.revokePaid(envelope)).paidAllowed).toBeNull();
    expect(await store.reserve({ envelope, attemptId: "b", amountNano: 1, limitNano: 10_000, billable: true })).toMatchObject({ ok: false, reason: "paid-not-enabled" });
  });

  it("lets only as many simultaneous billable callers in as the limit covers, once authorized", async () => {
    const envelope = await fresh();
    await store.allowPaid({ envelope, note: "test" });
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => store.reserve({ envelope, attemptId: `a${i}`, amountNano: 3_000, limitNano: 10_000, billable: true })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });

  it("keeps a suspension stronger than an authorization", async () => {
    const envelope = await fresh();
    await store.allowPaid({ envelope, note: "test" });
    await store.suspend({ envelope, reason: "stop" });
    expect(await store.reserve({ envelope, attemptId: "a", amountNano: 1, limitNano: 10_000, billable: true })).toMatchObject({ ok: false, reason: "suspended" });
  });

  it("ignores a ratio left in the record by an older version", async () => {
    const envelope = await fresh();
    const stale = new Redis(redisUrl!);
    await stale.hset(store.keyOf(envelope), "bound", "0.0001|measured long ago");
    stale.disconnect();
    // The record is still healthy, and nothing about admission or totals changes.
    await store.allowPaid({ envelope, note: "test" });
    expect((await store.reserve({ envelope, attemptId: "a", amountNano: 9_000, limitNano: 10_000, billable: true })).ok).toBe(true);
    expect(await store.reserve({ envelope, attemptId: "b", amountNano: 1_001, limitNano: 10_000, billable: true })).toMatchObject({ ok: false, reason: "limit" });
    expect(await store.totals(envelope)).toMatchObject({ heldNano: 9_000, attempts: 1 });
    expect((await store.audit(envelope)).consistent).toBe(true);
  });
});

// Added after the integration review: these run against both stores.
function reviewContract(name: string, setup: () => Promise<Context>) {
  describe(`spend store contract, settlement and damage: ${name}`, () => {
    let ctx: Context;
    const fresh = async () => {
      const envelope = `env-${randomUUID()}`;
      await ctx.prepare(envelope);
      return envelope;
    };
    beforeAll(async () => {
      ctx = await setup();
    });

    it("treats the same settlement again as a harmless replay", async () => {
      const envelope = await fresh();
      await ctx.store.reserve({ envelope, attemptId: "a", amountNano: 1_000, limitNano: 10_000 });
      expect(await ctx.store.settle({ envelope, attemptId: "a", actualNano: 400 })).toMatchObject({ applied: true, chargedNano: 400, mismatch: false });
      const replay = await ctx.store.settle({ envelope, attemptId: "a", actualNano: 400 });
      expect(replay).toMatchObject({ applied: false, chargedNano: 400, mismatch: false });
      expect(replay.totals).toMatchObject({ settledNano: 400, suspended: null });
    });

    it("keeps the first amount and suspends the envelope when a second settlement disagrees", async () => {
      const envelope = await fresh();
      await ctx.store.reserve({ envelope, attemptId: "a", amountNano: 1_000, limitNano: 10_000 });
      await ctx.store.settle({ envelope, attemptId: "a", actualNano: 400 });
      const second = await ctx.store.settle({ envelope, attemptId: "a", actualNano: 900 });
      expect(second).toMatchObject({ applied: false, chargedNano: 400, mismatch: true });
      expect(second.totals.settledNano).toBe(400);
      expect(second.totals.suspended).toMatch(/attempt a is settled at 400 but a second settlement says 900/);
      expect(await ctx.store.reserve({ envelope, attemptId: "b", amountNano: 1, limitNano: 10_000 })).toMatchObject({ ok: false, reason: "suspended" });
    });

    it("behind metered(): a reply that disagrees with an operator's settlement is not reported as settled", async () => {
      const envelope = await fresh();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const provider = new FakeProvider(async () => {
        await gate;
        return textResponse("ok", { inputTokens: 3_500, cachedTokens: 2_800, outputTokens: 25 }); // 93,700
      });
      const metered = createMetered({ ...CALIBRATED, provider, store: ctx.store, envelope, limitNano: 1_000_000_000 });
      const pending = metered({ step: "t", promptId: "p", attemptId: "turn-1", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 100 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // While the request is in flight, an operator closes it by hand at another amount.
      await ctx.store.settle({ envelope, attemptId: "turn-1", actualNano: 50_000 });
      release();

      expect(await pending).toMatchObject({ ok: true, costNano: 93_700, settled: false, breached: true });
      const totals = await ctx.store.totals(envelope);
      expect(totals.settledNano).toBe(50_000);
      expect(totals.suspended).not.toBeNull();
      expect(provider.dispatched).toBe(1);
    });
  });
}
reviewContract("in memory", async () => ({ store: new MemorySpendStore(), prepare: async () => {} }));
if (redisUrl) {
  reviewContract("Redis", async () => {
    const { runner } = await connectRedis(redisUrl);
    const store = new RedisSpendStore(runner, { prefix });
    return { store, prepare: async (envelope) => void (await store.init({ envelope, limitNano: 1_000_000_000_000 })) };
  });
}

describe.skipIf(!redisUrl)("Redis spend store: only canonical numbers, and damage is never read as absence", () => {
  let store: RedisSpendStore;
  let admin: Redis;
  const fresh = async () => {
    const envelope = `env-${randomUUID()}`;
    await store.init({ envelope, limitNano: 10_000 });
    return envelope;
  };
  beforeAll(async () => {
    store = new RedisSpendStore((await connectRedis(redisUrl!)).runner, { prefix });
    admin = new Redis(redisUrl!);
  });
  afterAll(() => admin.disconnect());

  // Each of these parses as a number in Lua, but Redis integer commands reject it or read it
  // differently. If the script trusted it, a later command could fail after an earlier write.
  it.each(["1.5", "1e3", " 12", "12 ", "+7", "-0", "007", "0x10", "", "9999999999999999"])("refuses a total stored as %j", async (value) => {
    const envelope = await fresh();
    await store.reserve({ envelope, attemptId: "a", amountNano: 100, limitNano: 10_000 });
    await admin.hset(store.keyOf(envelope), "held", value);
    for (const call of [
      () => store.reserve({ envelope, attemptId: "b", amountNano: 1, limitNano: 10_000 }),
      () => store.settle({ envelope, attemptId: "a", actualNano: 1 }),
      () => store.retain({ envelope, attemptId: "a" }),
      () => store.totals(envelope),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(EnvelopeCorruptError);
    }
    // Nothing was written while refusing: the attempt and the damaged value are as they were.
    expect(await admin.hget(store.keyOf(envelope), "a:a")).toBe("reserved|100|0");
    expect(await admin.hget(store.keyOf(envelope), "held")).toBe(value);
  });

  it.each(["reserved|100", "reserved|1.5|0", "flying|100|0", "reserved|100|0|extra", "", "reserved|-1|0"])(
    "refuses an attempt stored as %j, and does not treat its id as free",
    async (value) => {
      const envelope = await fresh();
      await store.reserve({ envelope, attemptId: "a", amountNano: 100, limitNano: 10_000 });
      await admin.hset(store.keyOf(envelope), "a:a", value);
      // Reserving the same id again must not look like a new attempt.
      await expect(store.reserve({ envelope, attemptId: "a", amountNano: 100, limitNano: 10_000 })).rejects.toBeInstanceOf(EnvelopeCorruptError);
      await expect(store.settle({ envelope, attemptId: "a", actualNano: 1 })).rejects.toBeInstanceOf(EnvelopeCorruptError);
      await expect(store.retain({ envelope, attemptId: "a" })).rejects.toBeInstanceOf(EnvelopeCorruptError);
      // The totals were not touched, and the damaged record is kept for a person to look at.
      expect(await admin.hget(store.keyOf(envelope), "held")).toBe("100");
      expect(await admin.hget(store.keyOf(envelope), "a:a")).toBe(value);
    },
  );

  it("audits attempts and totals from one snapshot, so traffic during an audit is not a discrepancy", async () => {
    const envelope = await fresh();
    let reserving = true;
    let n = 0;
    const traffic = (async () => {
      while (reserving) await store.reserve({ envelope, attemptId: `t${n++}`, amountNano: 1, limitNano: 10_000 });
    })();
    for (let i = 0; i < 40; i++) expect((await store.audit(envelope)).consistent).toBe(true);
    reserving = false;
    await traffic;
    expect(n).toBeGreaterThan(10);
  });
});
