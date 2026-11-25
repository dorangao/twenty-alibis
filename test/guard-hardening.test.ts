import { describe, expect, it } from "vitest";
import { createMetered, type MeteredDeps, type MeteredRequest, type TraceEvent } from "../src/metered";
import { FakeProvider, scripted, textResponse } from "../src/provider/fake";
import { TIER_LIMIT_TOKENS, absoluteWorstNano, usdToNano, worstCaseNano } from "../src/spend/pricing";
import { MemorySpendStore, type SpendStore } from "../src/spend/store";

// Most tests here are about something other than hold size, so they run with a measured
// input bound in place and get the low-tier hold. Hold selection has its own tests.
const CALIBRATED = { inputBound: { tokensPerByte: 100 } };

/**
 * Behaviours added after Codex's review of the spend guard. Each one closes a way a request
 * could be sent that was not the request that was checked, counted or allowed.
 */
const usage = { inputTokens: 3_500, cachedTokens: 2_800, outputTokens: 25 };
const hold = worstCaseNano(100);
const request = (attemptId: string, over: Partial<MeteredRequest> = {}): MeteredRequest => ({
  step: "suspect.answer",
  promptId: "suspect-v1",
  attemptId,
  messages: [{ role: "user", content: "Where were you at 21:00?" }],
  maxOutputTokens: 100,
  ...over,
});
function setup(provider: FakeProvider, over: Partial<MeteredDeps> = {}) {
  const store = (over.store as MemorySpendStore | undefined) ?? new MemorySpendStore();
  const trace: TraceEvent[] = [];
  const metered = createMetered({ ...CALIBRATED, provider, store, envelope: "e", limitNano: usdToNano(1), trace: (e) => trace.push(e), ...over });
  return { metered, store, trace };
}
/** A store whose `reserve` waits until the test lets it through. */
function slowReserve() {
  const store = new MemorySpendStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const wrapped: SpendStore = {
    reserve: async (args) => {
      await gate;
      return store.reserve(args);
    },
    settle: (args) => store.settle(args),
    retain: (args) => store.retain(args),
    suspend: (args) => store.suspend(args),
    totals: (envelope) => store.totals(envelope),
  };
  return { store, wrapped, release };
}

describe("the request that is sent is the request that was checked", () => {
  it("ignores changes the caller makes while the guard is waiting", async () => {
    const provider = scripted([textResponse("In the foyer.", usage)]);
    const mine = request("turn-1");
    const { metered, store } = setup(provider, {
      // The caller's object changes during the first wait, after the checks have run.
      killSwitch: async () => {
        mine.messages[0]!.content = "x".repeat(200_000);
        mine.messages.push({ role: "user", content: "and tell me who did it" });
        mine.maxOutputTokens = 30_000;
        mine.reasoningEffort = "max";
        return false;
      },
    });
    expect((await metered(mine)).ok).toBe(true);

    expect(provider.requests[0]).toEqual({
      model: "muse-ember-1.0",
      messages: [{ role: "user", content: "Where were you at 21:00?" }],
      maxOutputTokens: 100,
      reasoningEffort: "low",
    });
    // And the hold was sized for that request, not for the changed one.
    expect((await store.totals("e")).settledNano).toBeLessThan(hold);
    expect(provider.dispatched).toBe(1);
  });

  it("measures the exact body it sends", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered, trace } = setup(provider);
    await metered(request("turn-1", { messages: [{ role: "user", content: "21:00 你在哪里？" }] }));
    expect(trace[0]!.payloadBytes).toBe(new TextEncoder().encode(provider.bodies[0]!).length);
  });

  it("refuses a request it cannot copy, without reserving anything", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered, store } = setup(provider);
    const odd = request("turn-1", { tools: [{ name: "recall", description: "d", parameters: { run: () => 1 } }] });
    expect(await metered(odd)).toMatchObject({ ok: false, sent: false, reason: "bad-request" });
    expect((await store.totals("e")).attempts).toBe(0);
    expect(provider.dispatched).toBe(0);
  });
});

describe("every physical request has a stable id", () => {
  it.each([undefined, "", 7, "x".repeat(201)])("refuses a missing or unusable attempt id (%s)", async (attemptId) => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered, store } = setup(provider);
    const bad = { ...request("unused"), attemptId } as unknown as MeteredRequest;
    expect(await metered(bad)).toMatchObject({ ok: false, sent: false, reason: "bad-request" });
    expect((await store.totals("e")).attempts).toBe(0);
    expect(provider.dispatched).toBe(0);
  });

  it("sends a redelivered action once, however often it arrives", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered } = setup(provider);
    const results = await Promise.all(Array.from({ length: 10 }, () => metered(request("session-3:turn-7:answer:1"))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(provider.dispatched).toBe(1);
  });
});

describe("reasoning effort", () => {
  it.each(["medium", "high", "xhigh", "max"] as const)("refuses %s unless it was allowed on purpose", async (effort) => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered, store } = setup(provider);
    expect(await metered(request("turn-1", { reasoningEffort: effort }))).toMatchObject({ ok: false, sent: false, reason: "effort-not-allowed" });
    expect((await store.totals("e")).attempts).toBe(0);

    const widened = setup(provider, { allowedEfforts: ["low", effort] });
    expect((await widened.metered(request("turn-2", { reasoningEffort: effort }))).ok).toBe(true);
    expect(provider.requests[0]!.reasoningEffort).toBe(effort);
  });

  it("allows minimal and low by default", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered } = setup(provider);
    expect((await metered(request("a", { reasoningEffort: "minimal" }))).ok).toBe(true);
    expect((await metered(request("b"))).ok).toBe(true);
  });
});

describe("the kill switch is checked again right before sending", () => {
  it("does not send a request that was waiting on the store when the switch was thrown", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { store, wrapped, release } = slowReserve();
    let stopped = false;
    const metered = createMetered({ ...CALIBRATED, provider, store: wrapped, envelope: "e", limitNano: usdToNano(1), killSwitch: () => stopped });

    const pending = metered(request("turn-1")); // passes the first check, then waits on the store
    await new Promise((resolve) => setTimeout(resolve, 0));
    stopped = true;
    release();

    expect(await pending).toMatchObject({ ok: false, sent: false, reason: "kill-switch" });
    expect(provider.dispatched).toBe(0);
    // Nothing left this machine, so nothing stays charged.
    expect(await store.totals("e")).toMatchObject({ settledNano: 0, heldNano: 0, retainedNano: 0, attempts: 1 });
  });

  it("does not send when the switch cannot be read at the last moment", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    let reads = 0;
    const { metered, store } = setup(provider, {
      killSwitch: () => {
        if (++reads === 2) throw new Error("config store unreachable");
        return false;
      },
    });
    expect(await metered(request("turn-1"))).toMatchObject({ ok: false, sent: false, reason: "kill-switch" });
    expect(provider.dispatched).toBe(0);
    expect((await store.totals("e")).committedNano).toBe(0);
  });

  it("keeps the hold if the stand-down itself cannot be recorded", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const store = new MemorySpendStore();
    const failingSettle: SpendStore = {
      reserve: (args) => store.reserve(args),
      settle: async () => {
        throw new Error("store unreachable");
      },
      retain: (args) => store.retain(args),
      suspend: (args) => store.suspend(args),
      totals: (envelope) => store.totals(envelope),
    };
    let reads = 0;
    const metered = createMetered({ ...CALIBRATED, provider, store: failingSettle, envelope: "e", limitNano: usdToNano(1), killSwitch: () => ++reads === 2 });
    expect(await metered(request("turn-1"))).toMatchObject({ ok: false, sent: false, reason: "kill-switch" });
    expect(provider.dispatched).toBe(0);
    expect((await store.totals("e")).heldNano).toBe(hold);
  });
});

describe("an operator can stop an envelope from another process", () => {
  it("refuses everything while suspended, and nothing is sent", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered, store } = setup(provider);
    expect((await metered(request("before"))).ok).toBe(true);
    await store.suspend({ envelope: "e", reason: "operator stop" });
    expect(await metered(request("during"))).toMatchObject({ ok: false, sent: false, reason: "envelope-suspended" });
    await store.resume("e");
    expect((await metered(request("after"))).ok).toBe(true);
    expect(provider.dispatched).toBe(2);
  });
});

describe("when the guard's own arithmetic is wrong, it stops", () => {
  it("suspends the envelope when a reply costs more than its hold", async () => {
    // The limit was 100 output tokens. The reply is billed for 100,000.
    const provider = scripted([textResponse("long", { inputTokens: 3_500, cachedTokens: 0, outputTokens: 100_000 }), textResponse("ok", usage)]);
    const { metered, store, trace } = setup(provider);
    const result = await metered(request("turn-1"));
    expect(result).toMatchObject({ ok: true, settled: true, breached: true });
    expect(trace[0]!.breach).toMatch(/above the hold/);

    const totals = await store.totals("e");
    expect(totals.settledNano).toBe(3_500 * 100 + 100_000 * 500); // the real cost is charged in full
    expect(totals.suspended).not.toBeNull();
    expect(await metered(request("turn-2"))).toMatchObject({ ok: false, sent: false, reason: "envelope-suspended" });
    expect(provider.dispatched).toBe(1);
  });

  it("suspends the envelope when a reply reports more input than the hold assumed", async () => {
    const provider = scripted([textResponse("ok", { inputTokens: TIER_LIMIT_TOKENS + 1, cachedTokens: 0, outputTokens: 1 }), textResponse("ok", usage)]);
    const { metered, store, trace } = setup(provider);
    expect(await metered(request("turn-1"))).toMatchObject({ ok: true, breached: true });
    expect(trace[0]!.breach).toMatch(/input tokens is above/);
    expect((await store.totals("e")).suspended).toMatch(/turn-1/);
    expect(await metered(request("turn-2"))).toMatchObject({ reason: "envelope-suspended" });
  });

  it("stays open after an ordinary reply", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered, store } = setup(provider);
    expect(await metered(request("turn-1"))).toMatchObject({ ok: true, settled: true, breached: false });
    expect((await store.totals("e")).suspended).toBeNull();
  });
});

describe("a settlement the store did not confirm is not reported as settled", () => {
  it("returns the reply, says the settlement is pending, and keeps the full hold", async () => {
    const provider = scripted([textResponse("In the foyer.", usage)]);
    const store = new MemorySpendStore();
    let fail = true;
    const flaky: SpendStore = {
      reserve: (args) => store.reserve(args),
      settle: async (args) => {
        if (fail) throw new Error("acknowledgement lost");
        return store.settle(args);
      },
      retain: (args) => store.retain(args),
      suspend: (args) => store.suspend(args),
      totals: (envelope) => store.totals(envelope),
    };
    const trace: TraceEvent[] = [];
    const metered = createMetered({ ...CALIBRATED, provider, store: flaky, envelope: "e", limitNano: usdToNano(1), trace: (e) => trace.push(e) });

    const result = await metered(request("turn-1"));
    expect(result).toMatchObject({ ok: true, settled: false, costNano: 93_700 });
    expect(trace[0]).toMatchObject({ outcome: "settle-pending", costNano: 93_700, holdNano: hold });
    expect((await store.totals("e")).heldNano).toBe(hold);

    // Later it is reconciled by id, without sending anything again.
    fail = false;
    expect((await flaky.settle({ envelope: "e", attemptId: "turn-1", actualNano: 93_700 })).applied).toBe(true);
    expect(await store.totals("e")).toMatchObject({ settledNano: 93_700, heldNano: 0 });
    expect(provider.dispatched).toBe(1);
  });
});

describe("the trace is a record, not a control", () => {
  it("a trace sink that throws changes nothing about what is sent or charged", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered, store } = setup(provider, {
      trace: () => {
        throw new Error("disk full");
      },
    });
    expect(await metered(request("turn-1"))).toMatchObject({ ok: true, settled: true });
    expect(await metered(request("turn-1"))).toMatchObject({ ok: false, reason: "duplicate-attempt" });
    expect(provider.dispatched).toBe(1);
    expect((await store.totals("e")).settledNano).toBe(93_700);
  });
});

describe("a request that spends real money needs an operator's authorization", () => {
  // A fake provider marked billable stands in for the real one. Nothing is spent.
  const billable = () => new FakeProvider(() => textResponse("ok", usage), { billable: true });

  it("is refused before anything is reserved or sent when the envelope has no authorization", async () => {
    const provider = billable();
    const { metered, store, trace } = setup(provider, { killSwitch: () => false });
    expect(await metered(request("turn-1"))).toMatchObject({ ok: false, sent: false, reason: "paid-not-enabled" });
    expect(provider.dispatched).toBe(0);
    expect(await store.totals("e")).toMatchObject({ committedNano: 0, attempts: 0, paidAllowed: null });
    expect(trace[0]).toMatchObject({ outcome: "refused:paid-not-enabled" });
  });

  it("is not unlocked by having a key, by the kill switch being off, or by a larger limit", async () => {
    const provider = billable();
    const { metered } = setup(provider, { limitNano: usdToNano(10), killSwitch: () => false, allowedEfforts: ["minimal", "low", "max"] });
    for (const id of ["a", "b", "c"]) {
      expect(await metered(request(id))).toMatchObject({ sent: false, reason: "paid-not-enabled" });
    }
    expect(provider.dispatched).toBe(0);
  });

  it("is sent once an operator has authorized paid requests, and refused again after that is revoked", async () => {
    const provider = billable();
    const { metered, store } = setup(provider);
    await store.allowPaid({ envelope: "e", note: "Doran, Nov 25: smoke test of ten requests" });
    expect((await store.totals("e")).paidAllowed).toBe("Doran, Nov 25: smoke test of ten requests");
    expect((await metered(request("turn-1"))).ok).toBe(true);
    await store.revokePaid("e");
    expect(await metered(request("turn-2"))).toMatchObject({ sent: false, reason: "paid-not-enabled" });
    expect(provider.dispatched).toBe(1);
  });

  it("an authorization needs a note, and covers only its own envelope", async () => {
    const store = new MemorySpendStore();
    await expect(store.allowPaid({ envelope: "e", note: "  " })).rejects.toThrow();
    await store.allowPaid({ envelope: "other", note: "someone else's budget" });
    const provider = billable();
    const { metered } = setup(provider, { store });
    expect(await metered(request("turn-1"))).toMatchObject({ sent: false, reason: "paid-not-enabled" });
  });

  it("does not affect a provider that spends nothing", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered } = setup(provider);
    expect(provider.billable).toBe(false);
    expect((await metered(request("turn-1"))).ok).toBe(true);
  });
});

describe("how much is held", () => {
  const most = absoluteWorstNano(100);
  const uncalibrated = (provider: FakeProvider, over: Partial<MeteredDeps> = {}) => {
    const store = new MemorySpendStore();
    const trace: TraceEvent[] = [];
    // No inputBound here: nothing is assumed about how many tokens a body becomes.
    const metered = createMetered({ provider, store, envelope: "e", limitNano: usdToNano(1), trace: (e) => trace.push(e), ...over });
    return { metered, store, trace };
  };

  it("without a measured bound, holds the most any request can cost: a full context window at the high price", async () => {
    expect(most).toBe(1_048_576 * 300 + 100 * 1_500); // about $0.3147
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider = new FakeProvider(async () => {
      await gate;
      return textResponse("ok", usage);
    });
    const { metered, store, trace } = uncalibrated(provider);
    const pending = metered(request("turn-1"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await store.totals("e")).heldNano).toBe(most);
    release();
    expect((await pending).ok).toBe(true);
    expect(trace[0]).toMatchObject({ holdNano: most, holdBasis: "context-window", costNano: 93_700 });
  });

  it("without a measured bound, even a high-tier reply stays inside its hold", async () => {
    // 300,000 input tokens: three times the price. Still under the context-window hold.
    const provider = scripted([textResponse("ok", { inputTokens: 300_000, cachedTokens: 0, outputTokens: 100 })]);
    const { metered, store } = uncalibrated(provider);
    expect(await metered(request("turn-1"))).toMatchObject({ ok: true, breached: false });
    const totals = await store.totals("e");
    expect(totals.settledNano).toBe(300_000 * 300 + 100 * 1_500);
    expect(totals.settledNano).toBeLessThan(most);
    expect(totals.suspended).toBeNull();
  });

  it("without a measured bound, refuses when the envelope cannot cover that hold", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered } = uncalibrated(provider, { limitNano: most - 1 });
    expect(await metered(request("turn-1"))).toMatchObject({ sent: false, reason: "envelope-exhausted" });
    expect(provider.dispatched).toBe(0);
  });

  it("with a measured bound that keeps the body in the low tier, holds the low-tier worst case", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered, trace } = uncalibrated(provider, { inputBound: { tokensPerByte: 0.5 } });
    expect((await metered(request("turn-1"))).ok).toBe(true);
    expect(trace[0]).toMatchObject({ holdNano: hold, holdBasis: "low-tier" });
  });

  it("with a measured bound that cannot keep the body in the low tier, goes back to the full hold", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered, trace } = uncalibrated(provider, { inputBound: { tokensPerByte: 10_000 } });
    expect((await metered(request("turn-1"))).ok).toBe(true);
    expect(trace[0]).toMatchObject({ holdNano: most, holdBasis: "context-window" });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("ignores a bound that is not a positive number (%s)", async (tokensPerByte) => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered, trace } = uncalibrated(provider, { inputBound: { tokensPerByte } });
    await metered(request("turn-1"));
    expect(trace[0]!.holdBasis).toBe("context-window");
  });

  it("suspends the envelope when a reply shows the measured bound was wrong", async () => {
    // The bound says this small body is at most a few hundred tokens. The reply says 50,000.
    const provider = scripted([textResponse("ok", { inputTokens: 50_000, cachedTokens: 0, outputTokens: 10 }), textResponse("ok", usage)]);
    const { metered, store, trace } = uncalibrated(provider, { inputBound: { tokensPerByte: 0.5 } });
    expect(await metered(request("turn-1"))).toMatchObject({ ok: true, breached: true });
    expect(trace[0]!.breach).toMatch(/above the \d+ the measured bound allowed/);
    expect((await store.totals("e")).suspended).not.toBeNull();
    expect(await metered(request("turn-2"))).toMatchObject({ sent: false, reason: "envelope-suspended" });
  });
});

describe("no ratio can shrink the hold on a request that spends money", () => {
  const most = absoluteWorstNano(100);

  it.each([0.0001, 0.5, 1, 100])("a paid-enabled billable provider holds the full context-window bound even with a ratio of %s", async (tokensPerByte) => {
    const provider = new FakeProvider(() => textResponse("ok", usage), { billable: true });
    const store = new MemorySpendStore();
    await store.allowPaid({ envelope: "e", note: "test" });
    const trace: TraceEvent[] = [];
    // An old, low ratio is supplied. It would have selected the small hold for a provider that spends nothing.
    const metered = createMetered({ provider, store, envelope: "e", limitNano: usdToNano(1), inputBound: { tokensPerByte }, trace: (e) => trace.push(e) });
    expect((await metered(request("turn-1"))).ok).toBe(true);
    expect(trace[0]).toMatchObject({ holdNano: most, holdBasis: "context-window" });
  });

  it("refuses a billable request the envelope cannot cover at the full bound, though the low-tier hold would fit", async () => {
    const provider = new FakeProvider(() => textResponse("ok", usage), { billable: true });
    const store = new MemorySpendStore();
    await store.allowPaid({ envelope: "e", note: "test" });
    const metered = createMetered({ provider, store, envelope: "e", limitNano: hold * 5, inputBound: { tokensPerByte: 0.0001 } });
    expect(hold * 5).toBeLessThan(most);
    expect(await metered(request("turn-1"))).toMatchObject({ ok: false, sent: false, reason: "envelope-exhausted" });
    expect(provider.dispatched).toBe(0);
  });

  it("a billable reply with far more input than any ratio suggested stays inside its hold and does not suspend", async () => {
    const provider = new FakeProvider(() => textResponse("ok", { inputTokens: 900_000, cachedTokens: 0, outputTokens: 100 }), { billable: true });
    const store = new MemorySpendStore();
    await store.allowPaid({ envelope: "e", note: "test" });
    const metered = createMetered({ provider, store, envelope: "e", limitNano: usdToNano(1), inputBound: { tokensPerByte: 0.0001 } });
    expect(await metered(request("turn-1"))).toMatchObject({ ok: true, settled: true, breached: false });
    const totals = await store.totals("e");
    expect(totals.settledNano).toBe(900_000 * 300 + 100 * 1_500);
    expect(totals.settledNano).toBeLessThanOrEqual(most);
    expect(totals.suspended).toBeNull();
  });

  it("the runtime that builds the real provider never reads or passes a ratio", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../src/runtime.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/inputBound\s*[:(]/);
    expect(source).not.toMatch(/tokensPerByte/);
  });
});
