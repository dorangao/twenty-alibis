import { describe, expect, it } from "vitest";
import { createMetered, MAX_PAYLOAD_BYTES, type MeteredRequest, type TraceEvent } from "../src/metered";
import { FakeProvider, scripted, textResponse } from "../src/provider/fake";
import { NotDispatchedError, type ProviderResponse } from "../src/provider/types";
import { costNano, usdToNano, worstCaseNano } from "../src/spend/pricing";
import { MemorySpendStore, type SpendStore } from "../src/spend/store";

const usage = { inputTokens: 3_500, cachedTokens: 2_800, outputTokens: 250 };
const request = (over: Partial<MeteredRequest> = {}): MeteredRequest => ({
  step: "test.step",
  promptId: "test-prompt-v1",
  messages: [{ role: "user", content: "Where were you at 21:00?" }],
  maxOutputTokens: 100,
  ...over,
});
const hold = worstCaseNano(100);

function setup(provider: FakeProvider, limitNano: number, store: SpendStore = new MemorySpendStore()) {
  const trace: TraceEvent[] = [];
  const metered = createMetered({ provider, store, envelope: "test", limitNano, trace: (e) => trace.push(e) });
  return { metered, store, trace };
}

describe("pricing", () => {
  it("prices a typical request in whole nanodollars", () => {
    // 700 uncached x 100 + 2,800 cached x 4 + 250 output x 500
    expect(costNano(usage)).toBe(70_000 + 11_200 + 125_000);
  });

  it("switches the whole request to the high tier above 200K input tokens", () => {
    expect(costNano({ inputTokens: 200_000, cachedTokens: 0, outputTokens: 0 })).toBe(20_000_000);
    expect(costNano({ inputTokens: 200_001, cachedTokens: 0, outputTokens: 0 })).toBe(200_001 * 300);
  });

  it("reserves a full low-tier input plus the whole output limit", () => {
    expect(hold).toBe(20_050_000); // $0.02005
    expect(4 * hold).toBe(usdToNano(0.0802));
    expect(20 * hold).toBe(usdToNano(0.401));
  });

  it("rejects impossible usage", () => {
    expect(() => costNano({ inputTokens: 10, cachedTokens: 11, outputTokens: 0 })).toThrow();
    expect(() => costNano({ inputTokens: -1, cachedTokens: 0, outputTokens: 0 })).toThrow();
    expect(() => worstCaseNano(0)).toThrow();
  });
});

describe("metered()", () => {
  it("settles the real cost and releases the rest of the hold", async () => {
    const { metered, store, trace } = setup(scripted([textResponse("In the foyer.", usage)]), usdToNano(1));
    const result = await metered(request());
    expect(result.ok).toBe(true);
    expect(await store.totals("test")).toMatchObject({ settledNano: 206_200, heldNano: 0, retainedNano: 0, committedNano: 206_200 });
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ outcome: "settled", costNano: 206_200, holdNano: hold, model: "muse-ember-1.0", reasoningEffort: "low" });
  });

  it("defaults to low reasoning effort and always sends an output limit", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered } = setup(provider, usdToNano(1));
    await metered(request());
    expect(provider.requests[0]).toMatchObject({ model: "muse-ember-1.0", reasoningEffort: "low", maxOutputTokens: 100 });
  });

  it("never writes prompt or reply text into the trace", async () => {
    const secret = "THE-CULPRIT-IS-ADA";
    const { metered, trace } = setup(scripted([textResponse(secret, usage)]), usdToNano(1));
    await metered(request({ messages: [{ role: "user", content: secret }] }));
    expect(JSON.stringify(trace)).not.toContain(secret);
  });

  it("admits only as many simultaneous requests as the envelope can cover", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider = new FakeProvider(async () => {
      await gate;
      return textResponse("ok", usage);
    });
    // Room for exactly three worst-case holds.
    const { metered, store } = setup(provider, 3 * hold + 1);
    const pending = Array.from({ length: 20 }, () => metered(request()));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provider.dispatched).toBe(3);
    expect((await store.totals("test")).heldNano).toBe(3 * hold);

    release();
    const results = await Promise.all(pending);
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const refused = results.filter((r) => !r.ok);
    expect(refused).toHaveLength(17);
    expect(refused.every((r) => !r.ok && r.sent === false && r.reason === "envelope-exhausted")).toBe(true);
    expect(provider.dispatched).toBe(3);
    // Once the real costs are known, the freed room can be used again.
    expect((await metered(request())).ok).toBe(true);
  });

  it("refuses at the exact boundary: one nanodollar short is not enough", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const short = setup(provider, hold - 1);
    expect(await short.metered(request())).toMatchObject({ ok: false, sent: false, reason: "envelope-exhausted" });
    expect(provider.dispatched).toBe(0);
    const exact = setup(provider, hold);
    expect((await exact.metered(request())).ok).toBe(true);
  });

  it("keeps the full hold when the response has no usage block", async () => {
    const { metered, store, trace } = setup(scripted([textResponse("ok")]), usdToNano(1));
    const result = await metered(request());
    expect(result).toMatchObject({ ok: false, sent: true, reason: "outcome-unknown" });
    expect(await store.totals("test")).toMatchObject({ settledNano: 0, heldNano: 0, retainedNano: hold, committedNano: hold });
    expect(trace[0]).toMatchObject({ outcome: "retained", costNano: hold });
  });

  it("keeps the full hold when the provider throws after dispatch", async () => {
    const provider = new FakeProvider(() => {
      throw new Error("socket hang up");
    });
    const { metered, store } = setup(provider, usdToNano(1));
    expect(await metered(request())).toMatchObject({ ok: false, sent: true, reason: "outcome-unknown" });
    expect((await store.totals("test")).retainedNano).toBe(hold);
  });

  it("keeps the full hold when the usage block cannot be priced", async () => {
    const bad: ProviderResponse = { text: "ok", toolCalls: [], usage: { inputTokens: 5, cachedTokens: 9, outputTokens: 1 } };
    const { metered, store } = setup(scripted([bad]), usdToNano(1));
    expect(await metered(request())).toMatchObject({ ok: false, sent: true, reason: "outcome-unknown" });
    expect((await store.totals("test")).retainedNano).toBe(hold);
  });

  it("charges nothing when the provider is certain nothing was sent", async () => {
    const provider = new FakeProvider(() => {
      throw new NotDispatchedError("invalid request shape");
    });
    const { metered, store } = setup(provider, usdToNano(1));
    expect(await metered(request())).toMatchObject({ ok: false, sent: false, reason: "not-dispatched" });
    expect((await store.totals("test")).committedNano).toBe(0);
  });

  it("never resends: one call is one dispatch, even on failure", async () => {
    const provider = new FakeProvider(() => {
      throw new Error("timeout");
    });
    const { metered } = setup(provider, usdToNano(1));
    await metered(request());
    expect(provider.dispatched).toBe(1);
  });

  it("does not send a repeated attempt id twice", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered, store } = setup(provider, usdToNano(1));
    expect((await metered(request({ attemptId: "turn-7" }))).ok).toBe(true);
    expect(await metered(request({ attemptId: "turn-7" }))).toMatchObject({ ok: false, sent: false, reason: "duplicate-attempt" });
    expect(provider.dispatched).toBe(1);
    expect((await store.totals("test")).settledNano).toBe(206_200);
  });

  it("a hold left by a process that died still counts after a restart", async () => {
    const store = new MemorySpendStore();
    // A worker reserved, dispatched, and died before settling.
    await store.reserve({ envelope: "test", attemptId: "lost", amountNano: hold, limitNano: 2 * hold });
    // A new process on the same store has room for one more request, not two.
    const provider = new FakeProvider(() => textResponse("ok")); // no usage: holds stay
    const { metered } = setup(provider, 2 * hold, store);
    expect((await metered(request())).ok).toBe(false); // sent, outcome unknown
    expect(await metered(request())).toMatchObject({ ok: false, sent: false, reason: "envelope-exhausted" });
    expect(provider.dispatched).toBe(1);
    expect((await store.totals("test")).committedNano).toBe(2 * hold);
  });

  it("refuses without sending when the kill switch is on, or cannot be read", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const store = new MemorySpendStore();
    const on = createMetered({ provider, store, envelope: "test", limitNano: usdToNano(1), killSwitch: () => true });
    expect(await on(request())).toMatchObject({ ok: false, sent: false, reason: "kill-switch" });
    const broken = createMetered({
      provider,
      store,
      envelope: "test",
      limitNano: usdToNano(1),
      killSwitch: () => {
        throw new Error("config unreachable");
      },
    });
    expect(await broken(request())).toMatchObject({ ok: false, sent: false, reason: "kill-switch" });
    expect(provider.dispatched).toBe(0);
    expect((await store.totals("test")).attempts).toBe(0);
  });

  it("refuses a body that is too large, and a missing or oversized output limit", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const { metered } = setup(provider, usdToNano(1));
    const big = "x".repeat(MAX_PAYLOAD_BYTES);
    expect(await metered(request({ messages: [{ role: "user", content: big }] }))).toMatchObject({ reason: "payload-too-large" });
    // Chinese text is three bytes a character: the limit is on bytes, not characters.
    const zh = "证".repeat(Math.ceil(MAX_PAYLOAD_BYTES / 3));
    expect(await metered(request({ messages: [{ role: "user", content: zh }] }))).toMatchObject({ reason: "payload-too-large" });
    expect(await metered(request({ maxOutputTokens: 0 }))).toMatchObject({ reason: "bad-output-limit" });
    expect(await metered(request({ maxOutputTokens: 1_000_000 }))).toMatchObject({ reason: "bad-output-limit" });
    expect(await metered(request({ maxOutputTokens: Number.NaN }))).toMatchObject({ reason: "bad-output-limit" });
    expect(provider.dispatched).toBe(0);
  });

  it("refuses without sending when the store cannot answer", async () => {
    const provider = scripted([textResponse("ok", usage)]);
    const down: SpendStore = {
      reserve: async () => {
        throw new Error("store unreachable");
      },
      settle: async () => {
        throw new Error("store unreachable");
      },
      retain: async () => {
        throw new Error("store unreachable");
      },
      totals: async () => {
        throw new Error("store unreachable");
      },
    };
    const { metered } = setup(provider, usdToNano(1), down);
    expect(await metered(request())).toMatchObject({ ok: false, sent: false, reason: "store-unavailable" });
    expect(provider.dispatched).toBe(0);
  });
});

describe("the spend store", () => {
  it("counts a settlement once", async () => {
    const store = new MemorySpendStore();
    await store.reserve({ envelope: "e", attemptId: "a", amountNano: 1_000, limitNano: 10_000 });
    expect((await store.settle({ envelope: "e", attemptId: "a", actualNano: 400 })).applied).toBe(true);
    const again = await store.settle({ envelope: "e", attemptId: "a", actualNano: 900 });
    expect(again.applied).toBe(false);
    expect(again.totals.settledNano).toBe(400);
  });

  it("lets a retained attempt be settled later, once, if its real cost turns up", async () => {
    const store = new MemorySpendStore();
    await store.reserve({ envelope: "e", attemptId: "a", amountNano: 1_000, limitNano: 10_000 });
    expect((await store.retain({ envelope: "e", attemptId: "a" })).retainedNano).toBe(1_000);
    const settled = await store.settle({ envelope: "e", attemptId: "a", actualNano: 300 });
    expect(settled.totals).toMatchObject({ settledNano: 300, retainedNano: 0, committedNano: 300 });
    // Retaining a settled attempt changes nothing.
    expect((await store.retain({ envelope: "e", attemptId: "a" })).committedNano).toBe(300);
  });

  it("charges the real cost even when it is above the hold, and says so", async () => {
    const store = new MemorySpendStore();
    await store.reserve({ envelope: "e", attemptId: "a", amountNano: 1_000, limitNano: 10_000 });
    const result = await store.settle({ envelope: "e", attemptId: "a", actualNano: 1_500 });
    expect(result).toMatchObject({ applied: true, overHold: true });
    expect(result.totals.settledNano).toBe(1_500);
  });

  it("keeps envelopes separate", async () => {
    const store = new MemorySpendStore();
    await store.reserve({ envelope: "local", attemptId: "a", amountNano: 900, limitNano: 1_000 });
    expect((await store.reserve({ envelope: "deployed", attemptId: "a", amountNano: 900, limitNano: 1_000 })).ok).toBe(true);
    expect((await store.reserve({ envelope: "local", attemptId: "b", amountNano: 200, limitNano: 1_000 })).ok).toBe(false);
  });

  it("rejects amounts that are not whole nanodollars", async () => {
    const store = new MemorySpendStore();
    await expect(store.reserve({ envelope: "e", attemptId: "a", amountNano: 0.5, limitNano: 10 })).rejects.toThrow();
    await expect(store.reserve({ envelope: "e", attemptId: "a", amountNano: -1, limitNano: 10 })).rejects.toThrow();
  });
});
