import { describe, expect, it } from "vitest";
import { createMetered } from "../src/metered";
import { EmberProvider, toWireBody } from "../src/provider/ember";
import { FakeProvider, textResponse } from "../src/provider/fake";
import type { ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore, type SpendStore } from "../src/spend/store";
import { runBatch, type TrialStep } from "../src/trial/batch";

const CALIBRATED = { inputBound: { tokensPerByte: 100 } };
const usage = { inputTokens: 1_000, cachedTokens: 0, outputTokens: 50 };
const toolCall = (): ProviderResponse => ({ text: null, toolCalls: [{ id: "call_1", name: "recall", arguments: '{"topic":"t"}' }], usage, finishReason: "tool_calls" });
const answer = (): ProviderResponse => ({ ...textResponse("In the foyer.", usage), finishReason: "stop" });
const cutOff = (): ProviderResponse => ({ text: null, toolCalls: [], usage: { ...usage, outputTokens: 300 }, finishReason: "length" });

// Three steps: the second needs the tool call returned by the first.
const steps: TrialStep[] = [
  {
    n: 1,
    what: ["question", "提问"],
    build: () => ({ step: "ask", promptId: "p", messages: [{ role: "user", content: "q" }], maxOutputTokens: 400 }),
    after: (r, ctx) => (ctx.calls.first = r.toolCalls[0]),
  },
  {
    n: 2,
    what: ["answer", "作答"],
    build: (ctx) => (ctx.calls.first ? { step: "answer", promptId: "p", messages: [{ role: "user", content: "q" }], maxOutputTokens: 400 } : null),
  },
  { n: 3, what: ["standalone", "独立"], build: () => ({ step: "other", promptId: "p", messages: [{ role: "user", content: "x" }], maxOutputTokens: 400 }) },
];
const idOf = (n: number) => `t-${n}`;
function setup(replies: (ProviderResponse | Error)[], store: SpendStore = new MemorySpendStore()) {
  const provider = new FakeProvider((_request, index) => {
    const reply = replies[Math.min(index, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const metered = createMetered({ ...CALIBRATED, provider, store, envelope: "e", limitNano: usdToNano(1) });
  return { provider, metered, store };
}
const outcomes = (report: Awaited<ReturnType<typeof runBatch>>) => report.rows.map((r) => r.outcome);

describe("a trial batch reports exactly what happened", () => {
  it("is complete only when every request was sent, confirmed and usable", async () => {
    const { metered, provider } = setup([toolCall(), answer(), answer()]);
    const report = await runBatch({ metered, steps, idOf });
    expect(outcomes(report)).toEqual(["ok", "ok", "ok"]);
    expect(report.complete).toBe(true);
    expect(report.pricedNano).toBe(3 * (1_000 * 100 + 50 * 500));
    expect(provider.dispatched).toBe(3);
  });

  it("run again, sends nothing, skips what depended on an earlier reply, and is not a success", async () => {
    const { metered, provider, store } = setup([toolCall(), answer(), answer()]);
    await runBatch({ metered, steps, idOf });
    const again = await runBatch({ metered, steps, idOf });
    // Step 2 needs step 1's reply, which this run never received.
    expect(outcomes(again)).toEqual(["earlier", "skipped", "earlier"]);
    expect(again.complete).toBe(false);
    expect(again.pricedNano).toBe(0);
    expect(provider.dispatched).toBe(3);
    expect((await store.totals("e")).attempts).toBe(3);
  });

  it("after a partial earlier run, sends only what is new and still says it is incomplete", async () => {
    const { metered, provider } = setup([toolCall(), answer(), answer()]);
    await runBatch({ metered, steps: steps.slice(0, 1), idOf });
    const report = await runBatch({ metered, steps, idOf });
    expect(outcomes(report)).toEqual(["earlier", "skipped", "ok"]);
    expect(report.complete).toBe(false);
    expect(provider.dispatched).toBe(2);
  });

  it("records the cost of a reply that was cut off, calls it truncated, and skips the step that needed it", async () => {
    const { metered } = setup([cutOff(), answer()]);
    const report = await runBatch({ metered, steps, idOf });
    expect(outcomes(report)).toEqual(["truncated", "skipped", "ok"]);
    expect(report.rows[0]).toMatchObject({ costNano: 1_000 * 100 + 300 * 500, output: 300, detail: "finish length, no usable reply" });
    expect(report.complete).toBe(false);
    // The truncated request's cost is in the total: it was paid for.
    expect(report.pricedNano).toBe(1_000 * 100 + 300 * 500 + 1_000 * 100 + 50 * 500);
  });

  it("treats an empty reply as truncated even when the finish reason looks normal", async () => {
    const { metered } = setup([{ text: "", toolCalls: [], usage, finishReason: "stop" }]);
    const report = await runBatch({ metered, steps: steps.slice(2), idOf });
    expect(outcomes(report)).toEqual(["truncated"]);
    expect(report.complete).toBe(false);
  });

  it("does not call a settlement the store never confirmed settled, and stops there", async () => {
    const real = new MemorySpendStore();
    const flaky: SpendStore = {
      reserve: (a) => real.reserve(a),
      settle: async () => {
        throw new Error("acknowledgement lost");
      },
      retain: (a) => real.retain(a),
      suspend: (a) => real.suspend(a),
      totals: (e) => real.totals(e),
    };
    const { metered, provider } = setup([toolCall(), answer(), answer()], flaky);
    const report = await runBatch({ metered, steps, idOf });
    expect(outcomes(report)).toEqual(["unconfirmed", "not-reached", "not-reached"]);
    expect(report.rows[0]!.detail).toBe("the store did not confirm the settlement");
    expect(report.complete).toBe(false);
    expect(provider.dispatched).toBe(1);
  });

  it("stops at a request whose outcome is unknown and says the rest was not reached", async () => {
    const { metered, provider } = setup([new Error("socket hang up")]);
    const report = await runBatch({ metered, steps, idOf });
    expect(outcomes(report)).toEqual(["failed", "not-reached", "not-reached"]);
    expect(report.rows[0]!.detail).toMatch(/outcome-unknown: socket hang up/);
    expect(report.complete).toBe(false);
    expect(provider.dispatched).toBe(1);
  });

  it("stops at a refusal without sending", async () => {
    const provider = new FakeProvider(() => answer(), { billable: true });
    const metered = createMetered({ provider, store: new MemorySpendStore(), envelope: "e", limitNano: usdToNano(1) });
    const report = await runBatch({ metered, steps, idOf });
    expect(outcomes(report)).toEqual(["refused", "not-reached", "not-reached"]);
    expect(report.rows[0]!.detail).toBe("paid-not-enabled");
    expect(provider.dispatched).toBe(0);
  });
});

describe("the cache label", () => {
  const base = { step: "s", promptId: "p", messages: [{ role: "user" as const, content: "q" }], maxOutputTokens: 100 };

  it("travels through metered() to the provider unchanged, and is absent when not given", async () => {
    const provider = new FakeProvider(() => answer());
    const metered = createMetered({ ...CALIBRATED, provider, store: new MemorySpendStore(), envelope: "e", limitNano: usdToNano(1) });
    await metered({ ...base, attemptId: "with", cacheKey: "case:archive-pass" });
    await metered({ ...base, attemptId: "without" });
    expect(provider.requests[0]!.cacheKey).toBe("case:archive-pass");
    expect("cacheKey" in provider.requests[1]!).toBe(false);
    // The label is part of the measured body: what is sent is still exactly what was checked.
    expect(provider.bodies[0]).toContain('"cacheKey":"case:archive-pass"');
    expect(provider.bodies[1]).not.toContain("cacheKey");
  });

  it.each(["", 7, null, { a: 1 }])("is dropped when it is not a non-empty string (%j)", async (cacheKey) => {
    const provider = new FakeProvider(() => answer());
    const metered = createMetered({ ...CALIBRATED, provider, store: new MemorySpendStore(), envelope: "e", limitNano: usdToNano(1) });
    expect((await metered({ ...base, attemptId: "a", cacheKey } as never)).ok).toBe(true);
    expect("cacheKey" in provider.requests[0]!).toBe(false);
  });

  it("becomes prompt_cache_key on the wire, only when present", () => {
    const request = { model: "muse-ember-1.0" as const, messages: base.messages, maxOutputTokens: 100, reasoningEffort: "low" as const };
    expect(toWireBody({ ...request, cacheKey: "case:archive-pass" }).prompt_cache_key).toBe("case:archive-pass");
    expect("prompt_cache_key" in toWireBody(request)).toBe(false);
    // And through the real provider's encoder, which is what the guard measures and sends.
    const ember = new EmberProvider({ apiKey: "k", fetch: (async () => new Response("{}")) as typeof fetch });
    expect(JSON.parse(ember.encode({ ...request, cacheKey: "case:x" })).prompt_cache_key).toBe("case:x");
  });
});
