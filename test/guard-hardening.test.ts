import { describe, expect, it } from "vitest";
import { createMetered, type MeteredDeps, type MeteredRequest, type TraceEvent } from "../src/metered";
import { FakeProvider, scripted, textResponse } from "../src/provider/fake";
import { TIER_LIMIT_TOKENS, usdToNano, worstCaseNano } from "../src/spend/pricing";
import { MemorySpendStore, type SpendStore } from "../src/spend/store";

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
  const metered = createMetered({ provider, store, envelope: "e", limitNano: usdToNano(1), trace: (e) => trace.push(e), ...over });
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
    const metered = createMetered({ provider, store: wrapped, envelope: "e", limitNano: usdToNano(1), killSwitch: () => stopped });

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
    const metered = createMetered({ provider, store: failingSettle, envelope: "e", limitNano: usdToNano(1), killSwitch: () => ++reads === 2 });
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
    const metered = createMetered({ provider, store: flaky, envelope: "e", limitNano: usdToNano(1), trace: (e) => trace.push(e) });

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
