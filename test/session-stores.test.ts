import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectRedis } from "../src/spend/redis-client";
import type { ScriptRunner } from "../src/spend/redis-store";
import { redisSessions, SessionWriteError } from "../src/web/redis-sessions";
import { memorySessions, type SessionRecord, type SessionStore } from "../src/web/sessions";
import { redisRun, redisUrl } from "./redis-run";

const blank = (id: string, options: { createdAt?: number; over?: boolean; owner?: string } = {}): SessionRecord => ({
  session: { id, caseId: "c", actions: 0, evidence: [], inspections: [], asked: 0, turns: [], ...(options.over ? { verdict: { accused: "s", cited: [], outcome: "wrong" as const, missing: [], open: [], accusedRuledOut: false, actions: 0 } } : {}) },
  owner: options.owner ?? "o",
  revision: 1,
  mode: "off",
  caseVersion: "v",
  topics: [],
  inspections: [],
  createdAt: options.createdAt ?? Date.now(),
});
const ended = (r: SessionRecord): SessionRecord => ({ ...r, session: blank(r.session.id, { over: true }).session, revision: r.revision + 1 });
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** A promise and the function that settles it. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/**
 * What every session store must do. It runs against the in-memory store always, and against
 * a real Redis when TEST_REDIS_URL is set. Times here are the real clock's: a session in
 * Redis expires when Redis says so.
 */
function contract(name: string, make: (options: { max?: number; ttlMs?: number }) => SessionStore) {
  describe(`session store contract: ${name}`, () => {
    const id = () => randomUUID();

    it("keeps what the work returns, keeps nothing more when it throws, and lets go either way", async () => {
      const store = make({});
      const a = id();
      expect(await store.create(blank(a))).toBe(true);
      expect(await store.read(a)).toMatchObject({ busy: false, record: { revision: 1, session: { id: a } } });
      expect(await store.update(a, "o", async (r) => ({ record: { ...r, revision: 2 }, value: "done" }))).toEqual({ ok: true, value: "done" });
      expect((await store.read(a))!.record.revision).toBe(2);
      await expect(store.update(a, "o", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
      expect(await store.read(a)).toMatchObject({ busy: false, record: { revision: 2 } });
      // Not left held by the work that threw.
      expect(await store.update(a, "o", async (r) => ({ record: r, value: 1 }))).toEqual({ ok: true, value: 1 });
      const nobody = id();
      expect(await store.update(nobody, "o", async (r) => ({ record: r, value: 1 }))).toEqual({ ok: false, why: "missing" });
      expect(await store.read(nobody)).toBeNull();
    });

    it("hands the work the record as it was last kept, whole", async () => {
      const store = make({});
      const a = id();
      const record: SessionRecord = { ...blank(a), topics: ["t-1", "t-2"], inspections: ["i-1"], mode: "live", inFlight: 3 };
      await store.create(record);
      let seen: SessionRecord | undefined;
      await store.update(a, "o", async (r) => ((seen = r), { record: r, value: null }));
      expect(seen).toEqual(record);
      expect((await store.read(a))!.record).toEqual(record);
    });

    it("to anyone but its owner a session is missing, even while it is at work; only the owner hears that it is busy", async () => {
      const store = make({});
      const a = id();
      await store.create(blank(a));
      let ran = false;
      expect(await store.update(a, "someone-else", async (r) => ((ran = true), { record: r, value: 1 }))).toEqual({ ok: false, why: "missing" });
      expect(ran).toBe(false);
      const { opened, open } = gate();
      const started = gate();
      const working = store.update(a, "o", async (r) => {
        started.open();
        await opened;
        return { record: { ...r, revision: 2 }, value: null };
      });
      await started.opened;
      expect(await store.update(a, "someone-else", async (r) => ({ record: r, value: 1 }))).toEqual({ ok: false, why: "missing" });
      expect(await store.update(a, "o", async (r) => ({ record: r, value: 1 }))).toEqual({ ok: false, why: "busy" });
      // A read does not wait, shows what was last kept, and says a request is at work.
      expect(await store.read(a)).toMatchObject({ busy: true, record: { revision: 1 } });
      open();
      await working;
      expect(await store.read(a)).toMatchObject({ busy: false, record: { revision: 2 } });
    });

    it("what is saved in the middle of the work is kept at once, and stays kept if the work then fails", async () => {
      const store = make({});
      const a = id();
      await store.create(blank(a));
      const { opened, open } = gate();
      const saved = gate();
      const working = store.update(a, "o", async (r, save) => {
        await save({ ...r, inFlight: 1 });
        saved.open();
        await opened;
        throw new Error("the worker died");
      });
      await saved.opened;
      expect(await store.read(a)).toMatchObject({ busy: true, record: { inFlight: 1, revision: 1 } });
      open();
      await expect(working).rejects.toThrow("the worker died");
      expect(await store.read(a)).toMatchObject({ busy: false, record: { inFlight: 1, revision: 1 } });
      // The next piece of work starts from what was saved, and may save more than once.
      await store.update(a, "o", async (r, save) => {
        expect(r.inFlight).toBe(1);
        await save({ ...r, inFlight: 2 });
        await save({ ...r, inFlight: 3, revision: 2 });
        const { inFlight: _, ...rest } = r;
        return { record: { ...rest, revision: 3 }, value: null };
      });
      const after = (await store.read(a))!.record;
      expect(after.revision).toBe(3);
      expect(after.inFlight).toBeUndefined();
    });

    it("when every place is taken a new game is refused; a place is given up only by a game that has ended or expired", async () => {
      const store = make({ max: 2, ttlMs: 400 });
      const [a, b, c, d] = [id(), id(), id(), id()];
      await store.create(blank(a));
      await store.create(blank(b));
      // Both are unfinished and unexpired. Nobody is acting on either: their players are thinking. A third is refused.
      expect(await store.create(blank(c))).toBe(false);
      expect(await store.read(a)).not.toBeNull();
      expect(await store.read(b)).not.toBeNull();
      expect(await store.read(c)).toBeNull();
      // "b" ends with an accusation: that makes room. "a", which is older, is still there.
      await store.update(b, "o", async (r) => ({ record: ended(r), value: null }));
      expect(await store.create(blank(c))).toBe(true);
      expect(await store.read(a)).not.toBeNull();
      // Full again with two unfinished games; when they expire there is room.
      expect(await store.create(blank(d))).toBe(false);
      await wait(450);
      expect(await store.create(blank(d))).toBe(true);
      expect(await store.read(a)).toBeNull();
      expect(await store.update(a, "o", async (r) => ({ record: r, value: 1 }))).toEqual({ ok: false, why: "missing" });
    });
  });
}

contract("in memory", (options) => memorySessions(options));

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
  // Each store gets a prefix of its own under the run's, so one test's games do not fill another's places.
  contract("Redis", (options) => redisSessions({ eval: (...args) => runner.eval(...args) }, { prefix: `${prefix}:${randomUUID()}`, ...options }));
}

describe.skipIf(!redisUrl)("sessions in Redis", () => {
  let runner: ScriptRunner;
  let close: () => Promise<void>;
  let admin: Redis;
  const id = () => randomUUID();
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

  it("keeps a session under its prefix only, with a time limit, and a second store on the same Redis sees it", async () => {
    const p = own();
    const store = redisSessions(runner, { prefix: p, ttlMs: 60_000 });
    const a = id();
    await store.create(blank(a));
    expect(await admin.hkeys(`${p}:s:${a}`)).toEqual(expect.arrayContaining(["record", "owner", "revision"]));
    const left = await admin.pttl(`${p}:s:${a}`);
    expect(left).toBeGreaterThan(50_000);
    expect(left).toBeLessThanOrEqual(60_000);
    expect(await admin.zscore(`${p}:open`, a)).not.toBeNull();
    // Another worker: a store made anew on its own connection.
    const second = await connectRedis(redisUrl!);
    try {
      const other = redisSessions(second.runner, { prefix: p });
      expect((await other.read(a))!.record.session.id).toBe(a);
      await other.update(a, "o", async (r) => ({ record: { ...r, revision: 2 }, value: null }));
      expect((await store.read(a))!.record.revision).toBe(2);
      // A write keeps the time limit: the session does not start living for ever.
      expect(await admin.pttl(`${p}:s:${a}`)).toBeGreaterThan(0);
      // Nothing is left held once the work is done.
      expect(await admin.exists(`${p}:s:${a}:lease`)).toBe(0);
    } finally {
      await second.close();
    }
    // A store with another prefix does not see it.
    expect(await redisSessions(runner, { prefix: own() }).read(a)).toBeNull();
  });

  it("counts a session's time on Redis's own clock: a server whose clock is ahead or behind keeps it exactly as long", async () => {
    for (const skew of [5_000, -5_000]) {
      const p = own();
      const now = () => Date.now() + skew;
      const store = redisSessions(runner, { prefix: p, ttlMs: 400, max: 1, now });
      const a = id();
      expect(await store.create(blank(a, { createdAt: now() }))).toBe(true);
      const left = await admin.pttl(`${p}:s:${a}`);
      expect(left).toBeGreaterThan(300);
      expect(left).toBeLessThanOrEqual(400);
      await wait(200);
      expect(await store.read(a)).not.toBeNull();
      expect(await store.create(blank(id(), { createdAt: now() }))).toBe(false);
      await wait(250);
      expect(await store.read(a)).toBeNull();
      // Its place is free by the same server's clock.
      expect(await store.create(blank(id(), { createdAt: now() }))).toBe(true);
    }
    // A session whose time is already up is not kept at all.
    const store = redisSessions(runner, { prefix: own(), ttlMs: 400 });
    const old = id();
    expect(await store.create(blank(old, { createdAt: Date.now() - 400 }))).toBe(false);
    expect(await store.read(old)).toBeNull();
  });

  it("a game that has ended gives up its place and can still be read", async () => {
    const p = own();
    const store = redisSessions(runner, { prefix: p, max: 1 });
    const a = id();
    await store.create(blank(a));
    await store.update(a, "o", async (r) => ({ record: ended(r), value: null }));
    expect(await admin.zscore(`${p}:open`, a)).toBeNull();
    expect((await store.read(a))!.record.session.verdict).toBeDefined();
    expect(await store.create(blank(id()))).toBe(true);
  });

  it("two workers handed the same session at once: one works, the other is told busy, and nothing is done twice", async () => {
    const p = own();
    const a = id();
    await redisSessions(runner, { prefix: p }).create(blank(a));
    const second = await connectRedis(redisUrl!);
    try {
      const workers = [redisSessions(runner, { prefix: p }), redisSessions(second.runner, { prefix: p })];
      let ran = 0;
      const results = await Promise.all(
        workers.map((w) =>
          w.update(a, "o", async (r) => {
            ran++;
            await wait(50);
            return { record: { ...r, revision: r.revision + 1 }, value: null };
          }),
        ),
      );
      expect(results.map((r) => r.ok).sort()).toEqual([false, true]);
      expect(results.find((r) => !r.ok)).toEqual({ ok: false, why: "busy" });
      expect(ran).toBe(1);
      expect((await workers[0]!.read(a))!.record.revision).toBe(2);
    } finally {
      await second.close();
    }
  });

  it("a worker at work keeps its lease alive for as long as the work takes", async () => {
    const p = own();
    const store = redisSessions(runner, { prefix: p, leaseMs: 300 });
    const a = id();
    await store.create(blank(a));
    const working = store.update(a, "o", async (r) => {
      // Three terms of the lease.
      await wait(900);
      return { record: { ...r, revision: 2 }, value: null };
    });
    await wait(700);
    expect(await store.update(a, "o", async (r) => ({ record: r, value: 1 }))).toEqual({ ok: false, why: "busy" });
    expect(await working).toEqual({ ok: true, value: null });
    expect((await store.read(a))!.record.revision).toBe(2);
  });

  it("a worker that dies stops renewing: the session is free again after one term, and holds what the worker had saved", async () => {
    const p = own();
    // The dead worker: its renewals never reach Redis, and its work never comes back.
    const dead: ScriptRunner = { eval: (script, keys, args) => (script.includes("PEXPIRE', KEYS[1]") ? Promise.resolve(0) : runner.eval(script, keys, args)) };
    const a = id();
    const store = redisSessions(runner, { prefix: p, leaseMs: 200 });
    await store.create(blank(a));
    const saved = gate();
    const never = gate();
    const lost = redisSessions(dead, { prefix: p, leaseMs: 200 }).update(a, "o", async (r, save) => {
      await save({ ...r, inFlight: 1 });
      saved.open();
      await never.opened;
      return { record: { ...r, revision: 99 }, value: "late" };
    });
    await saved.opened;
    expect(await store.update(a, "o", async (r) => ({ record: r, value: 1 }))).toEqual({ ok: false, why: "busy" });
    expect((await store.read(a))!.busy).toBe(true);
    await wait(260);
    // Free, and nobody is at work: what the dead worker saved is there.
    expect(await store.read(a)).toMatchObject({ busy: false, record: { inFlight: 1, revision: 1 } });
    expect(await store.update(a, "o", async (r) => ({ record: { ...r, revision: 2 }, value: "next" }))).toEqual({ ok: true, value: "next" });
    // The dead worker comes back to life long after. Its result is refused and changes nothing.
    never.open();
    await expect(lost).rejects.toBeInstanceOf(SessionWriteError);
    expect((await store.read(a))!.record.revision).toBe(2);
  });

  it("a worker that lost its lease to another can neither save nor commit, and does not free the other's lease", async () => {
    const p = own();
    const store = redisSessions(runner, { prefix: p });
    const a = id();
    await store.create(blank(a));
    const taken = gate();
    const resume = gate();
    let saveError: unknown;
    const slow = store.update(a, "o", async (r, save) => {
      taken.open();
      await resume.opened;
      await save({ ...r, inFlight: 7 }).catch((error: unknown) => (saveError = error));
      return { record: { ...r, revision: 50 }, value: "slow" };
    });
    await taken.opened;
    // The lease runs out (here: it is removed), and another worker takes the session and is still at work.
    await admin.del(`${p}:s:${a}:lease`);
    const hold = gate();
    const began = gate();
    const other = store.update(a, "o", async (r) => {
      began.open();
      await hold.opened;
      return { record: { ...r, revision: 2 }, value: "other" };
    });
    await began.opened;
    resume.open();
    await expect(slow).rejects.toBeInstanceOf(SessionWriteError);
    expect(saveError).toBeInstanceOf(SessionWriteError);
    // The other worker's lease is still its own: the session is still busy, and its record is untouched.
    expect(await store.read(a)).toMatchObject({ busy: true, record: { revision: 1 } });
    expect((await store.read(a))!.record.inFlight).toBeUndefined();
    hold.open();
    expect(await other).toEqual({ ok: true, value: "other" });
    expect((await store.read(a))!.record.revision).toBe(2);
  });

  it("a write is refused if the session is not at the revision the worker read, even with the lease in hand", async () => {
    const p = own();
    const store = redisSessions(runner, { prefix: p });
    const a = id();
    await store.create(blank(a));
    const working = store.update(a, "o", async (r) => {
      // Something else moved the session on, around the lease.
      await admin.hset(`${p}:s:${a}`, "revision", "5");
      return { record: { ...r, revision: 2 }, value: null };
    });
    await expect(working).rejects.toBeInstanceOf(SessionWriteError);
    expect((await store.read(a))!.record.revision).toBe(1);
    // The lease was given up all the same.
    expect(await admin.exists(`${p}:s:${a}:lease`)).toBe(0);

    // The same if the session is no longer this owner's.
    const b = id();
    await store.create(blank(b));
    const saves: unknown[] = [];
    const taken = store.update(b, "o", async (r, save) => {
      await admin.hset(`${p}:s:${b}`, "owner", "someone-else");
      await save({ ...r, inFlight: 1 }).catch((error: unknown) => saves.push(error));
      return { record: { ...r, revision: 2 }, value: null };
    });
    await expect(taken).rejects.toBeInstanceOf(SessionWriteError);
    expect(saves[0]).toBeInstanceOf(SessionWriteError);
    await admin.hset(`${p}:s:${b}`, "owner", "o");
    const kept = (await store.read(b))!.record;
    expect(kept.revision).toBe(1);
    expect(kept.inFlight).toBeUndefined();
  });

  it("a session that ran out while a worker was on it stays gone; the worker's answer is still given", async () => {
    const p = own();
    const store = redisSessions(runner, { prefix: p });
    const a = id();
    await store.create(blank(a));
    const done = await store.update(a, "o", async (r) => {
      await admin.del(`${p}:s:${a}`);
      return { record: { ...r, revision: 2 }, value: "answer" };
    });
    expect(done).toEqual({ ok: true, value: "answer" });
    expect(await store.read(a)).toBeNull();
    expect(await admin.exists(`${p}:s:${a}:lease`)).toBe(0);
  });

  it("a record that cannot be read is an error, never a guess, and the session is not left held", async () => {
    const p = own();
    const store = redisSessions(runner, { prefix: p });
    for (const damage of ["{not json", JSON.stringify({ session: { id: "another" }, owner: "o", revision: 1 }), "null"]) {
      const a = id();
      await store.create(blank(a));
      await admin.hset(`${p}:s:${a}`, "record", damage);
      await expect(store.read(a)).rejects.toBeInstanceOf(SessionWriteError);
      let ran = false;
      await expect(store.update(a, "o", async (r) => ((ran = true), { record: r, value: 1 }))).rejects.toBeInstanceOf(SessionWriteError);
      expect(ran).toBe(false);
      expect(await admin.exists(`${p}:s:${a}:lease`)).toBe(0);
    }
    // A record with a part missing beside it.
    const b = id();
    await store.create(blank(b));
    await admin.hdel(`${p}:s:${b}`, "revision");
    await expect(store.update(b, "o", async (r) => ({ record: r, value: 1 }))).rejects.toBeInstanceOf(SessionWriteError);
    expect(await admin.exists(`${p}:s:${b}:lease`)).toBe(0);
  });

  it("when Redis refuses, every call rejects: nothing is kept in the worker instead", async () => {
    const down: ScriptRunner = { eval: () => Promise.reject(new Error("connection refused")) };
    const store = redisSessions(down, { prefix: own() });
    await expect(store.create(blank(id()))).rejects.toThrow("connection refused");
    await expect(store.read(id())).rejects.toThrow("connection refused");
    await expect(store.update(id(), "o", async (r) => ({ record: r, value: 1 }))).rejects.toThrow("connection refused");
  });

  it("if Redis is lost in the middle of the work, the result is not reported as kept", async () => {
    const p = own();
    const a = id();
    await redisSessions(runner, { prefix: p }).create(blank(a));
    let cut = false;
    const flaky: ScriptRunner = { eval: (script, keys, args) => (cut ? Promise.reject(new Error("connection lost")) : runner.eval(script, keys, args)) };
    const store = redisSessions(flaky, { prefix: p, leaseMs: 200 });
    await expect(
      store.update(a, "o", async (r) => {
        cut = true;
        return { record: { ...r, revision: 2 }, value: "done" };
      }),
    ).rejects.toThrow("connection lost");
    expect((await redisSessions(runner, { prefix: p }).read(a))!.record.revision).toBe(1);
  });
});
