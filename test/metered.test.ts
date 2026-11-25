import { describe, expect, it, vi } from "vitest";
import { createMetered, MAX_PAYLOAD_BYTES, type MeteredRequest, type TraceEvent } from "../src/metered";
import { FakeProvider, scripted, textResponse } from "../src/provider/fake";
import { NotDispatchedError, type ProviderResponse } from "../src/provider/types";
import { costNano, usdToNano, worstCaseNano } from "../src/spend/pricing";
import { MemorySpendStore, type SpendStore } from "../src/spend/store";

// Most tests here are about something other than hold size, so they run with a measured
// input bound in place and get the low-tier hold. Hold selection has its own tests.
const CALIBRATED = { inputBound: { tokensPerByte: 100 } };

const usage = { inputTokens: 3_500, cachedTokens: 2_800, outputTokens: 25 };
// Every physical request needs its own stable id. Tests that care pass one; the rest get a fresh one.
let nextAttempt = 0;
const request = (over: Partial<MeteredRequest> = {}): MeteredRequest => ({
  step: "test.step",
  promptId: "test-prompt-v1",
  attemptId: `auto-${++nextAttempt}`,
  messages: [{ role: "user", content: "Where were you at 21:00?" }],
  maxOutputTokens: 100,
  ...over,
});
const hold = worstCaseNano(100);

function setup(provider: FakeProvider, limitNano: number, store: SpendStore = new MemorySpendStore()) {
  const trace: TraceEvent[] = [];
  const metered = createMetered({ ...CALIBRATED, provider, store, envelope: "test", limitNano, trace: (e) => trace.push(e) });
  return { metered, store, trace };
}

describe("pricing", () => {
  it("prices a typical request in whole nanodollars", () => {
    // 700 uncached x 100 + 2,800 cached x 4 + 250 output x 500
    expect(costNano({ ...usage, outputTokens: 250 })).toBe(70_000 + 11_200 + 125_000);
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
    expect(await store.totals("test")).toMatchObject({ settledNano: 93_700, heldNano: 0, retainedNano: 0, committedNano: 93_700 });
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ outcome: "settled", costNano: 93_700, holdNano: hold, model: "muse-ember-1.0", reasoningEffort: "low" });
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
    expect((await store.totals("test")).settledNano).toBe(93_700);
  });

  it.each(["before commit", "after commit"] as const)(
    "protects an admitted request when settlement fails %s",
    async (failure) => {
      const store = new MemorySpendStore();
      const settle = store.settle.bind(store);
      vi.spyOn(store, "settle").mockImplementationOnce(async (args) => {
        if (failure === "after commit") await settle(args);
        throw new Error("settlement acknowledgement unavailable");
      });
      const provider = scripted([textResponse("ok", usage)]);
      const cost = costNano(usage);
      const { metered } = setup(provider, hold + cost, store);

      await metered(request({ attemptId: "first" }));
      const totals = await store.totals("test");
      if (failure === "before commit") {
        expect(totals).toMatchObject({ heldNano: hold, settledNano: 0, committedNano: hold });
      } else {
        expect(totals).toMatchObject({ heldNano: 0, settledNano: cost, committedNano: cost });
      }
      expect(await metered(request({ attemptId: "first" }))).toMatchObject({ sent: false, reason: "duplicate-attempt" });
      const next = await metered(request({ attemptId: "next" }));
      if (failure === "before commit") {
        expect(next).toMatchObject({ sent: false, reason: "envelope-exhausted" });
        expect(provider.dispatched).toBe(1);
      } else {
        expect(next.ok).toBe(true);
        expect(provider.dispatched).toBe(2);
      }

      // Reconcile using the known cost, including when the acknowledgement alone was lost.
      const reconciled = await store.settle({ envelope: "test", attemptId: "first", actualNano: cost });
      expect(reconciled.applied).toBe(failure === "before commit");
      expect(reconciled.totals).toMatchObject({ heldNano: 0, committedNano: provider.dispatched * cost });
    },
  );

  it("admits a shared attempt id once when workers race with capacity for both", async () => {
    const store = new MemorySpendStore();
    const provider = scripted([textResponse("ok", usage)]);
    const workers = [setup(provider, 2 * hold, store), setup(provider, 2 * hold, store)];
    const results = await Promise.all(workers.map(({ metered }) => metered(request({ attemptId: "same-turn" }))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && !r.sent && r.reason === "duplicate-attempt")).toHaveLength(1);
    expect(provider.dispatched).toBe(1);
    expect(await store.totals("test")).toMatchObject({ attempts: 1, committedNano: costNano(usage) });
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
    const on = createMetered({ ...CALIBRATED, provider, store, envelope: "test", limitNano: usdToNano(1), killSwitch: () => true });
    expect(await on(request())).toMatchObject({ ok: false, sent: false, reason: "kill-switch" });
    const broken = createMetered({ ...CALIBRATED,
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

  it("stops later calls in a gossip wave while an earlier call is in flight", async () => {
    let stopped = false;
    let signalDispatch!: () => void;
    let finishResponse!: () => void;
    const dispatched = new Promise<void>((resolve) => (signalDispatch = resolve));
    const responseReady = new Promise<void>((resolve) => (finishResponse = resolve));
    const provider = new FakeProvider(async () => {
      signalDispatch();
      await responseReady;
      return textResponse("ok", usage);
    });
    const store = new MemorySpendStore();
    const metered = createMetered({ ...CALIBRATED, provider, store, envelope: "wave", limitNano: 4 * hold, killSwitch: () => stopped });
    const first = metered(request({ step: "gossip", attemptId: "first" }));
    await dispatched;
    stopped = true;

    const rest = await Promise.all(["second", "third", "fourth"].map((attemptId) => metered(request({ step: "gossip", attemptId }))));
    for (const result of rest) expect(result).toMatchObject({ sent: false, reason: "kill-switch" });
    expect(provider.dispatched).toBe(1);
    expect(await store.totals("wave")).toMatchObject({ heldNano: hold, attempts: 1 });

    finishResponse();
    expect((await first).ok).toBe(true);
    expect((await store.totals("wave")).committedNano).toBe(costNano(usage));
  });

  it("isolates interleaved waves with shared attempt ids and different envelope limits", async () => {
    const store = new MemorySpendStore();
    const lanes = [1, 2, 3, 4, 2, 1].map((capacity, index) => {
      const envelope = `group-${index}`;
      const provider = scripted([textResponse("usage unavailable")]);
      const metered = createMetered({ ...CALIBRATED, provider, store, envelope, limitNano: capacity * hold });
      return { envelope, capacity, provider, metered };
    });
    const wave = (attemptId: string) => Promise.all(lanes.map(({ metered }) => metered(request({ attemptId }))));
    const first = await wave("shared");
    for (const result of first) expect(result).toMatchObject({ sent: true, reason: "outcome-unknown" });

    const rest = await Promise.all(["a", "b", "c", "d"].map(wave));
    for (const [index, { envelope, capacity, provider }] of lanes.entries()) {
      const results = rest.map((round) => round[index]!);
      expect(results.filter((r) => !r.ok && r.reason === "outcome-unknown")).toHaveLength(capacity - 1);
      expect(results.filter((r) => !r.ok && r.reason === "envelope-exhausted")).toHaveLength(5 - capacity);
      expect(await store.totals(envelope)).toMatchObject({ attempts: capacity, committedNano: capacity * hold, retainedNano: capacity * hold });
      expect(provider.dispatched).toBe(capacity);
    }

    // Only this envelope receives confirmation that its first attempt cost zero.
    await store.settle({ envelope: lanes[0]!.envelope, attemptId: "shared", actualNano: 0 });
    const after = await wave("next");
    expect(after[0]).toMatchObject({ sent: true, reason: "outcome-unknown" });
    for (const result of after.slice(1)) expect(result).toMatchObject({ sent: false, reason: "envelope-exhausted" });
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
      suspend: async () => {
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

  it("does not send when the reservation commits but its acknowledgement is lost", async () => {
    const store = new MemorySpendStore();
    const reserve = store.reserve.bind(store);
    vi.spyOn(store, "reserve").mockImplementationOnce(async (args) => {
      await reserve(args);
      throw new Error("lost reservation acknowledgement");
    });
    const provider = scripted([textResponse("ok", usage)]);
    const { metered } = setup(provider, hold, store);
    expect(await metered(request({ attemptId: "original" }))).toMatchObject({ sent: false, reason: "store-unavailable" });
    expect(await metered(request({ attemptId: "original" }))).toMatchObject({ sent: false, reason: "duplicate-attempt" });
    expect(await metered(request({ attemptId: "other" }))).toMatchObject({ sent: false, reason: "envelope-exhausted" });
    expect(provider.dispatched).toBe(0);
    expect(await store.totals("test")).toMatchObject({ attempts: 1, heldNano: hold, committedNano: hold });
  });

  it("still reserves full capacity when an unknown outcome cannot be recorded", async () => {
    const store = new MemorySpendStore();
    vi.spyOn(store, "retain").mockRejectedValueOnce(new Error("store unreachable"));
    const provider = scripted([textResponse("usage unavailable")]);
    const { metered } = setup(provider, hold, store);
    expect(await metered(request({ attemptId: "original" }))).toMatchObject({ sent: true, reason: "outcome-unknown" });
    expect(await metered(request({ attemptId: "original" }))).toMatchObject({ sent: false, reason: "duplicate-attempt" });
    expect(await metered(request({ attemptId: "other" }))).toMatchObject({ sent: false, reason: "envelope-exhausted" });
    expect(provider.dispatched).toBe(1);
    expect(await store.totals("test")).toMatchObject({ attempts: 1, heldNano: hold, committedNano: hold });
  });
});

describe("the spend store", () => {
  it.each([17, 211, 4093])("matches a bounded-charge ledger after each operation (seed %i)", async (seed) => {
    const store = new MemorySpendStore();
    const envelope = "model";
    const limitNano = 90;
    let available = limitNano;
    let sequence = seed;
    const draw = (size: number) => {
      sequence = (Math.imul(sequence, 1664525) + 1013904223) >>> 0;
      return Math.floor((sequence / 0x1_0000_0000) * size);
    };
    type Account = { kind: "hold" | "unknown" | "paid"; charge: number };
    const accounts = new Map<string, Account>();
    const subtotal = (kind: Account["kind"]) =>
      [...accounts.values()].reduce((sum, entry) => sum + (entry.kind === kind ? entry.charge : 0), 0);

    for (let step = 0; step < 240; step++) {
      const attemptId = `attempt-${draw(24)}`;
      const target = { envelope, attemptId };
      const entry = accounts.get(attemptId);
      const operation = (["reserve", "reserve", "settle", "retain"] as const)[draw(4)];
      const where = `step ${step}: ${operation} ${attemptId}`;
      if (operation === "reserve") {
        const amountNano = 1 + draw(28);
        const result = await store.reserve({ ...target, amountNano, limitNano });
        if (entry) {
          expect(result, where).toMatchObject({ ok: true, duplicate: true });
        } else if (amountNano > available) {
          expect(result, where).toMatchObject({ ok: false, reason: "limit" });
        } else {
          expect(result, where).toMatchObject({ ok: true, duplicate: false });
          available -= amountNano;
          accounts.set(attemptId, { kind: "hold", charge: amountNano });
        }
      } else if (operation === "settle") {
        // The model assumes the reservation really bounds the charge. A settlement that is
        // repeated carries the same amount, as a replayed acknowledgement would; a repeat
        // with a different amount is a mismatch and has its own tests.
        const actualNano = entry?.kind === "paid" ? entry.charge : draw((entry?.charge ?? 0) + 1);
        const settlement = store.settle({ ...target, actualNano });
        if (entry) {
          const firstSettlement = entry.kind !== "paid";
          expect(await settlement, where).toMatchObject({ applied: firstSettlement, overHold: false });
          if (firstSettlement) {
            available += entry.charge - actualNano;
            accounts.set(attemptId, { kind: "paid", charge: actualNano });
          }
        } else {
          await expect(settlement, where).rejects.toThrow();
        }
      } else {
        const retention = store.retain(target);
        if (entry) {
          await retention;
          if (entry.kind === "hold") entry.kind = "unknown";
        } else {
          await expect(retention, where).rejects.toThrow();
        }
      }
      const actual = await store.totals(envelope);
      expect(actual, where).toEqual({
        settledNano: subtotal("paid"),
        heldNano: subtotal("hold"),
        retainedNano: subtotal("unknown"),
        committedNano: limitNano - available,
        attempts: accounts.size,
        // Costs in this model never pass their holds, so nothing suspends the envelope.
        suspended: null,
        paidAllowed: null,
      });
      expect(actual.committedNano, where).toBeLessThanOrEqual(limitNano);
    }
  });

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
