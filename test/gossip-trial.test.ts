import { describe, expect, it } from "vitest";
import { GOSSIP_OUTPUT_TOKENS, gossipMessages } from "../src/agents/gossip-turn";
import { planRound } from "../src/game/gossip";
import { gossipDue, heldBy, startSession } from "../src/game/session";
import { createMetered, type TraceEvent } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderRequest, ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { memoryRunLock } from "../src/spend/run-lock";
import { MemorySpendStore } from "../src/spend/store";
import {
  BOUND_ENV,
  CHOICE_HOLD_NANO,
  STOP_ENV,
  checkLimits,
  checkTrial,
  choiceCeilingNano,
  gossipTrialCli,
  planGossipTrial,
  readLimits,
  refusalFor,
  runGossipTrial,
  trialSummary,
  walk,
  type GossipTrialConfig,
  type GossipTrialLimits,
  type GossipTrialReport,
  type GossipTrialRuntime,
  type TrialCount,
} from "../src/trial/gossip-trial";
import { lighthouseCase } from "../src/web/released";
import type { StoredAttempt } from "../src/writer/trial";

const c = lighthouseCase();
const config: GossipTrialConfig = { id: "gt-1", rounds: 3 };
/** Made-up limits, wide enough for the whole trial: a stop of seven cents, and a bound of four full holds and a dime. */
const limits: GossipTrialLimits = { stopNano: 70_000_000, boundNano: 4 * CHOICE_HOLD_NANO + 100_000_000 };
const FOUR = 4 * CHOICE_HOLD_NANO;
const env = { [STOP_ENV]: "0.07", [BOUND_ENV]: "1.360691200" };

const usage = { inputTokens: 900, cachedTokens: 300, outputTokens: 60, reasoningTokens: 50 };
const PRICE = 600 * 100 + 300 * 4 + 60 * 500;
/** The letters a request offers, read from the schema it was sent with. */
const lettersOf = (request: ProviderRequest): string[] => (request.responseSchema!.schema as { properties: { to: { enum: string[] } } }).properties.to.enum;
const letter = (to: string, extra: Partial<ProviderResponse> = {}): ProviderResponse => ({ text: JSON.stringify({ to }), toolCalls: [], usage, finishReason: "stop", ...extra });
/** An agent that always picks the person in this place of its list. */
const picks = (place: number) => (request: ProviderRequest) => letter(lettersOf(request)[place]!);

/** A fake provider behind the real spend guard, with the store's records read the way the real store gives them. */
function setup(handler: (request: ProviderRequest, index: number) => ProviderResponse | Promise<ProviderResponse>, options: { envelope?: string; paid?: boolean; killSwitch?: () => boolean } = {}) {
  const provider = new FakeProvider(handler);
  const store = new MemorySpendStore();
  const envelope = options.envelope ?? "local";
  const trace: TraceEvent[] = [];
  const metered = createMetered({ inputBound: { tokensPerByte: 100 }, provider, store, envelope, limitNano: usdToNano(5), trace: (e) => trace.push(e), ...(options.killSwitch ? { killSwitch: options.killSwitch } : {}) });
  const stored = (): StoredAttempt[] => trace.filter((e) => ["settled", "retained", "settle-pending"].includes(e.outcome)).map((e) => ({ attemptId: e.attemptId, state: e.outcome === "settled" ? "settled" : "retained" }));
  const lock = memoryRunLock();
  const saved: GossipTrialReport[] = [];
  const run = (over: Partial<GossipTrialConfig & GossipTrialLimits> = {}) =>
    runGossipTrial(c, { id: over.id ?? config.id, rounds: over.rounds ?? config.rounds }, { stopNano: over.stopNano ?? limits.stopNano, boundNano: over.boundNano ?? limits.boundNano }, { metered, lock, stored, save: (r) => saved.push(structuredClone(r)) });
  const calls = { opened: 0, closed: 0 };
  const runtime = async (): Promise<GossipTrialRuntime> => {
    calls.opened++;
    if (options.paid !== false) await store.allowPaid({ envelope, note: "test" });
    return { metered, store: { attempts: async () => stored(), totals: (e) => store.totals(e) }, runLock: lock, config: { envelope }, close: async () => void calls.closed++ };
  };
  const cliWith = async (given: Record<string, string | undefined>, ...argv: string[]) => {
    const lines: string[] = [];
    const code = await gossipTrialCli(argv, { c, config, env: given, envelope: "local", runtime, print: (line) => lines.push(line), save: (r) => saved.push(structuredClone(r)) });
    return { code, out: lines.join("\n") };
  };
  const cli = (...argv: string[]) => cliWith(env, ...argv);
  const sentIds = () => provider.requests.map((r) => (r as unknown as { attemptId?: string }).attemptId);
  return { provider, store, lock, saved, run, cli, cliWith, calls, stored, sentIds, trace };
}
const ran = (run: Awaited<ReturnType<typeof runGossipTrial>>): GossipTrialReport => {
  if (run.kind !== "ran") throw new Error(`the trial did not run: ${run.kind}`);
  return run.report;
};

describe("the walker", () => {
  it("uses actions at no cost and stops when a round is due", async () => {
    const s = await walk(c, startSession(c, "w", { gossip: true }));
    expect(s.actions).toBe(4);
    expect(gossipDue(c, s)).toBe(true);
    expect(await walk(c, s)).toBe(s);
  });
});

describe("the plan of a gossip trial", () => {
  it("lists every request the trial can ever send, with no model", async () => {
    const plan = await planGossipTrial(c, config);
    expect(plan.rounds.map((r) => [r.n, r.at, r.ids.length])).toEqual([[1, 4, 8], [2, 8, 8], [3, 12, 8]]);
    expect(plan.ids).toHaveLength(24);
    expect(new Set(plan.ids).size).toBe(24);
    expect(plan.ids.every((id) => /^gt-1:g[123]:\d+$/.test(id))).toBe(true);
    expect(plan.ceilingNano).toBe(plan.rounds.reduce((sum, r) => sum + r.ceilingNano, 0));
    // What the guard holds for one request is a full context window at the higher price, and the output limit.
    expect(CHOICE_HOLD_NANO).toBe(1_048_576 * 300 + GOSSIP_OUTPUT_TOKENS * 1_500);
    expect(plan.heldAtOnceNano).toBe(4 * CHOICE_HOLD_NANO);
    expect(plan.refused).toBeNull();
    expect((await planGossipTrial(c, config, limits)).refused).toBeNull();
  });

  it("counts a choice as a token for every byte of its messages, a thousand more, and the whole output limit", async () => {
    const s = await walk(c, startSession(c, "w", { gossip: true }));
    const plans = planRound(c, s.gossip!, heldBy(s), 1);
    expect(plans).toHaveLength(8);
    for (const plan of plans) {
      const bytes = Buffer.byteLength(JSON.stringify(gossipMessages(c, plan).messages), "utf8");
      expect(bytes).toBeGreaterThan(1_000);
      expect(choiceCeilingNano(c, plan)).toBe((bytes + 1_000) * 100 + GOSSIP_OUTPUT_TOKENS * 500);
    }
    const plan = await planGossipTrial(c, config);
    expect(plan.rounds[0]!.ceilingNano).toBe(plans.reduce((sum, p) => sum + choiceCeilingNano(c, p), 0));
  });

  it("says which round the limits would not let start, and which limit", async () => {
    const plan = await planGossipTrial(c, config);
    const two = plan.rounds[0]!.ceilingNano + plan.rounds[1]!.ceilingNano;
    const withLimits = async (over: Partial<GossipTrialLimits>) => (await planGossipTrial(c, config, { ...limits, ...over })).refused;
    expect(await withLimits({ stopNano: plan.ceilingNano })).toBeNull();
    expect(await withLimits({ stopNano: plan.ceilingNano - 1 })).toEqual({ round: 3, by: "stop" });
    expect(await withLimits({ stopNano: two - 1 })).toEqual({ round: 2, by: "stop" });
    expect(await withLimits({ stopNano: 1 })).toEqual({ round: 1, by: "stop" });
    // The bound counts full holds: a wave of four must fit on top of the estimate of everything up to and including the round.
    const first = plan.rounds[0]!.ceilingNano;
    expect(await withLimits({ boundNano: FOUR })).toEqual({ round: 1, by: "bound" });
    expect(await withLimits({ boundNano: FOUR + first - 1 })).toEqual({ round: 1, by: "bound" });
    expect(await withLimits({ boundNano: FOUR + first })).toEqual({ round: 2, by: "bound" });
    expect(await withLimits({ boundNano: FOUR + two - 1 })).toEqual({ round: 2, by: "bound" });
    expect(await withLimits({ boundNano: FOUR + two })).toEqual({ round: 3, by: "bound" });
    expect(await withLimits({ boundNano: FOUR + plan.ceilingNano - 1 })).toEqual({ round: 3, by: "bound" });
    expect(await withLimits({ boundNano: FOUR + plan.ceilingNano })).toBeNull();
    // A bound the size of an ordinary estimate admits nothing: no single request's hold fits under it.
    expect(await withLimits({ boundNano: 30_000_000, stopNano: 30_000_000 })).toEqual({ round: 1, by: "bound" });
  });

  it("refuses a config or limits it cannot run", () => {
    expect(() => checkTrial({ ...config, id: "Bad Id" })).toThrow();
    expect(() => checkTrial({ ...config, id: "a:b" })).toThrow();
    expect(() => checkTrial({ ...config, rounds: 0 })).toThrow();
    expect(() => checkTrial({ ...config, rounds: 4 })).toThrow();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => checkLimits({ ...limits, stopNano: bad })).toThrow();
      expect(() => checkLimits({ ...limits, boundNano: bad })).toThrow();
    }
  });
});

describe("the operator's limits", () => {
  it("reads both, in plain dollars", () => {
    expect(readLimits({})).toEqual({ ok: true, limits: null });
    expect(readLimits({ [STOP_ENV]: "0.07", [BOUND_ENV]: "1.5" })).toEqual({ ok: true, limits: { stopNano: 70_000_000, boundNano: 1_500_000_000 } });
    expect(readLimits({ [STOP_ENV]: "3", [BOUND_ENV]: "0.000000001" })).toEqual({ ok: true, limits: { stopNano: 3_000_000_000, boundNano: 1 } });
  });

  it("refuses one without the other, and anything it cannot read as a positive amount", () => {
    expect(readLimits({ [STOP_ENV]: "0.07" })).toMatchObject({ ok: false });
    expect(readLimits({ [BOUND_ENV]: "1.5" })).toMatchObject({ ok: false });
    for (const bad of ["", " 0.07", "0.07 ", "-1", "+1", "1e-2", ".5", "5.", "0", "0.0", "01", "$1", "1,5", "NaN", "Infinity", "0.0000000001", "1000000"]) {
      expect(readLimits({ [STOP_ENV]: bad, [BOUND_ENV]: "1.5" }), `stop "${bad}"`).toMatchObject({ ok: false });
      expect(readLimits({ [STOP_ENV]: "0.07", [BOUND_ENV]: bad }), `bound "${bad}"`).toMatchObject({ ok: false });
    }
  });
});

describe("the trial's own admission of a request", () => {
  const none: TrialCount = { confirmed: 0, flying: 0, flyingEstimate: 0, unresolved: 0, over: null };
  const tight: GossipTrialLimits = { stopNano: 1_000, boundNano: 2 * CHOICE_HOLD_NANO + 500 };

  it("never admits a request that is not in the plan, or any request once one has cost more than its estimate", () => {
    expect(refusalFor(none, limits, undefined)).toBe("trial-unplanned");
    expect(refusalFor({ ...none, over: "gt-1:g1:0" }, limits, 1)).toBe("trial-over-estimate");
    expect(refusalFor(none, limits, 1)).toBeNull();
  });

  it("counts a full hold for this request and for every one in flight or unresolved, on top of what is confirmed", () => {
    expect(refusalFor(none, tight, 100)).toBeNull();
    expect(refusalFor({ ...none, flying: 1 }, tight, 100)).toBeNull();
    expect(refusalFor({ ...none, flying: 2 }, tight, 100)).toBe("trial-bound");
    expect(refusalFor({ ...none, flying: 1, unresolved: 1 }, tight, 100)).toBe("trial-bound");
    expect(refusalFor({ ...none, unresolved: 2 }, tight, 100)).toBe("trial-bound");
    expect(refusalFor({ ...none, flying: 1, confirmed: 500 }, tight, 100)).toBeNull();
    expect(refusalFor({ ...none, flying: 1, confirmed: 501 }, tight, 100)).toBe("trial-bound");
    // A bound under one hold admits nothing at all.
    expect(refusalFor(none, { stopNano: 1_000, boundNano: CHOICE_HOLD_NANO - 1 }, 100)).toBe("trial-bound");
  });

  it("counts what is confirmed and the estimate of every request in flight against the stop", () => {
    expect(refusalFor({ ...none, confirmed: 400, flying: 1, flyingEstimate: 500 }, tight, 100)).toBeNull();
    expect(refusalFor({ ...none, confirmed: 400, flying: 1, flyingEstimate: 500 }, tight, 101)).toBe("trial-stop");
    expect(refusalFor({ ...none, confirmed: 401, flying: 1, flyingEstimate: 500 }, tight, 100)).toBe("trial-stop");
    expect(refusalFor({ ...none, confirmed: 400, flying: 1, flyingEstimate: 501 }, tight, 100)).toBe("trial-stop");
  });
});

describe("running a gossip trial", () => {
  it("sends exactly the planned requests, once each, and records who was picked", async () => {
    const t = setup(picks(1));
    const plan = await planGossipTrial(c, config);
    const report = ran(await t.run());
    expect(t.stored().map((a) => a.attemptId).sort()).toEqual([...plan.ids].sort());
    expect(t.provider.dispatched).toBe(24);
    expect(report.complete).toBe(true);
    expect(report.stoppedBy).toBeUndefined();
    expect(report.rounds.map((r) => [r.n, r.at, r.requests, r.events.length])).toEqual([[1, 4, 8, 8], [2, 8, 8, 8], [3, 12, 8, 8]]);
    expect(report.choices).toHaveLength(24);
    for (const row of report.choices) {
      expect(row).toMatchObject({ outcome: "picked", place: 1, input: 900, cached: 300, output: 60, reasoning: 50, finish: "stop", costNano: PRICE });
      expect(row.ceilingNano).toBeGreaterThan(PRICE);
      expect(row.to).toBe(row.candidates[1]);
      expect(row.candidates).not.toContain(row.speaker);
    }
    const total = trialSummary(report);
    expect(total).toMatchObject({ requests: 24, picked: 24, unusable: 0, places: [0, 24, 0, 0], input: 24 * 900, cached: 24 * 300, output: 24 * 60, reasoning: 24 * 50, costNano: 24 * PRICE, events: 24, perPickNano: PRICE, unresolved: 0, unresolvedHoldNano: 0 });
    expect(total.estimateNano).toBe(report.rounds.reduce((sum, r) => sum + r.ceilingNano, 0));
    expect(report.limits).toEqual(limits);
  });

  it("uses the game's own requests: step, prompt, effort, output limit and one cache label", async () => {
    const t = setup(picks(0));
    ran(await t.run({ rounds: 1 }));
    expect(t.trace.filter((e) => e.outcome === "settled")).toHaveLength(8);
    for (const e of t.trace) expect(e).toMatchObject({ step: "gossip.tell", promptId: "gossip-v1", reasoningEffort: "minimal", maxOutputTokens: GOSSIP_OUTPUT_TOKENS });
    expect(new Set(t.provider.requests.map((r) => r.cacheKey))).toEqual(new Set([`gossip:${c.id}`]));
  });

  it("sends the same ids whatever the agents answer", async () => {
    const [first, last, nobody] = [setup(picks(0)), setup(picks(3)), setup(() => letter("z"))];
    for (const t of [first, last, nobody]) ran(await t.run());
    const ids = (t: typeof first) => t.stored().map((a) => a.attemptId).sort();
    expect(ids(last)).toEqual(ids(first));
    expect(ids(nobody)).toEqual(ids(first));
  });

  it("saves the report after every round", async () => {
    const t = setup(picks(0));
    ran(await t.run());
    expect(t.saved.map((r) => r.rounds.length)).toEqual([1, 2, 3, 3]);
    expect(t.saved.map((r) => r.complete)).toEqual([false, false, true, true]);
  });

  it("runs once: a second run sends nothing", async () => {
    const t = setup(picks(0));
    ran(await t.run({ rounds: 1 }));
    const again = await t.run();
    expect(again).toMatchObject({ kind: "closed" });
    expect(again.kind === "closed" && again.held).toHaveLength(8);
    expect(t.provider.dispatched).toBe(8);
  });

  it("sends nothing while another run holds the lease", async () => {
    const t = setup(picks(0));
    const lease = await t.lock.acquire();
    expect(await t.run()).toEqual({ kind: "locked" });
    expect(t.provider.dispatched).toBe(0);
    await lease!.release();
    expect(ran(await t.run()).complete).toBe(true);
  });

  it("does not start a round whose estimate passes the stop", async () => {
    const plan = await planGossipTrial(c, config);
    const none = setup(picks(0));
    const report = ran(await none.run({ stopNano: plan.rounds[0]!.ceilingNano - 1 }));
    expect(none.provider.dispatched).toBe(0);
    expect(report).toMatchObject({ complete: false, rounds: [] });
    expect(report.stoppedBy).toContain("round 1 was not started");
    expect(report.stoppedBy).toContain("passes the stop");
    expect(none.saved).toHaveLength(1);

    // What round 1 really cost, not its estimate, is what round 2 is added to. One nano-dollar more and round 2 would fit.
    const one = setup(picks(0));
    const short = 8 * PRICE + plan.rounds[1]!.ceilingNano - 1;
    expect(short).toBeGreaterThan(plan.rounds[0]!.ceilingNano);
    const partial = ran(await one.run({ stopNano: short }));
    expect(one.provider.dispatched).toBe(8);
    expect(partial.rounds).toHaveLength(1);
    expect(partial.stoppedBy).toContain("round 2 was not started");
    expect(partial.complete).toBe(false);

    const two = setup(picks(0));
    expect(ran(await two.run({ stopNano: short + 1, rounds: 2 })).complete).toBe(true);
    expect(two.provider.dispatched).toBe(16);
  });

  it("sends nothing under a bound that does not hold a wave of full holds, however small the estimate", async () => {
    for (const boundNano of [20_000_000, CHOICE_HOLD_NANO, FOUR]) {
      const t = setup(picks(0));
      const report = ran(await t.run({ boundNano }));
      expect(t.provider.dispatched, String(boundNano)).toBe(0);
      expect(report.stoppedBy).toContain("round 1 was not started");
      expect(report.stoppedBy).toContain("passes the bound");
      expect(report).toMatchObject({ complete: false, rounds: [], choices: [] });
    }
    // Four holds and round 1's estimate admit round 1, all of it; what it cost then leaves no room for round 2.
    const first = (await planGossipTrial(c, config)).rounds[0]!.ceilingNano;
    const t = setup(picks(0));
    const report = ran(await t.run({ boundNano: FOUR + first }));
    expect(t.provider.dispatched).toBe(8);
    expect(report.rounds[0]).toMatchObject({ requests: 8, refused: 0 });
    expect(report.rounds).toHaveLength(1);
    expect(report.stoppedBy).toContain("round 2 was not started");
    expect(report.stoppedBy).toContain("passes the bound");
  });

  it("sends nothing more once a request has cost more than its estimate: the rest of the round is refused by the trial", async () => {
    // Far more input tokens billed than the body has bytes. The estimate was wrong, and the stop is not a bound on the bill.
    const big = { inputTokens: 25_100, cachedTokens: 0, outputTokens: 40 };
    const t = setup((request) => letter(lettersOf(request)[0]!, { usage: big }));
    const report = ran(await t.run());
    expect(t.provider.dispatched).toBe(4);
    expect(report.complete).toBe(false);
    expect(report.rounds).toHaveLength(1);
    expect(report.stoppedBy).toMatch(/^round 1: gt-1:g1:\d cost more than the trial's estimate of it$/);
    expect(report.choices.map((r) => [r.outcome, r.reason ?? null])).toEqual([...Array(4).fill(["picked", null]), ...Array(4).fill(["refused", "trial-over-estimate"])]);
    const cost = 25_100 * 100 + 40 * 500;
    expect(report.choices.slice(0, 4).every((r) => r.costNano === cost && r.costNano > r.ceilingNano)).toBe(true);
    // What was confirmed is what four requests cost, each above its estimate: more than the estimates said, and far under the holds.
    expect(report.rounds[0]).toMatchObject({ requests: 4, refused: 4, costNano: 4 * cost });
    expect(4 * cost).toBeLessThan(limits.stopNano);
    expect(trialSummary(report)).toMatchObject({ requests: 4, costNano: 4 * cost, unresolved: 0 });
    expect(await t.run()).toMatchObject({ kind: "closed" });
    expect(t.provider.dispatched).toBe(4);
  });

  it("goes on after a reply that picks nobody, and counts its cost", async () => {
    const t = setup((request, index) => (index === 0 ? letter("z") : index === 1 ? letter("a", { finishReason: "length" }) : picks(2)(request)));
    const report = ran(await t.run());
    expect(report.complete).toBe(true);
    expect(report.choices.filter((r) => r.outcome === "unusable").map((r) => r.finish)).toEqual(["stop", "length"]);
    expect(report.choices.filter((r) => r.outcome === "unusable").every((r) => r.costNano === PRICE && r.to === undefined)).toBe(true);
    expect(report.rounds[0]!.events).toHaveLength(6);
    expect(trialSummary(report)).toMatchObject({ requests: 24, picked: 22, unusable: 2, cutOff: 1, places: [0, 0, 22, 0], costNano: 24 * PRICE, events: 22, perPickNano: Math.round((24 * PRICE) / 22) });
  });

  it("stops after the round in which a request failed, with no further wave and no further round", async () => {
    const t = setup((request, index) => {
      if (index === 1) throw new Error("the connection dropped");
      return picks(0)(request);
    });
    const report = ran(await t.run());
    expect(t.provider.dispatched).toBe(4);
    expect(report.complete).toBe(false);
    expect(report.rounds).toHaveLength(1);
    expect(report.stoppedBy).toBe("round 1: failed:outcome-unknown");
    expect(report.choices.map((r) => r.outcome).sort()).toEqual(["failed", "picked", "picked", "picked"]);
    expect(report.rounds[0]).toMatchObject({ requests: 4, unconfirmed: 1, costNano: 3 * PRICE });
    // The one unknown outcome keeps a full hold: money the envelope counts, not a charge that was seen.
    expect(report).toMatchObject({ unresolved: 1, unresolvedHoldNano: CHOICE_HOLD_NANO });
    expect(report.rounds[0]!.events).toHaveLength(3);
    expect(t.stored().filter((a) => a.state === "retained")).toHaveLength(1);
    // The trial is now closed, and the unknown outcome is on the store's record.
    expect(await t.run()).toMatchObject({ kind: "closed" });
    expect(t.provider.dispatched).toBe(4);
  });

  it("stops after a round whose requests were refused", async () => {
    let on = false;
    const t = setup(picks(0), { killSwitch: () => on });
    on = true;
    const report = ran(await t.run());
    expect(t.provider.dispatched).toBe(0);
    expect(report.stoppedBy).toBe("round 1: refused:kill-switch");
    expect(report.choices.map((r) => [r.outcome, r.reason])).toEqual(Array(4).fill(["refused", "kill-switch"]));
    expect(report).toMatchObject({ unresolved: 0, unresolvedHoldNano: 0 });
    expect(report.rounds[0]).toMatchObject({ requests: 0, refused: 4, costNano: 0, events: [] });
    expect(trialSummary(report)).toMatchObject({ requests: 0, picked: 0, perPickNano: null, medianMs: 0 });
  });
});

describe("the command line of the gossip trial", () => {
  it("refuses an argument it does not know before anything is connected", async () => {
    const t = setup(picks(0));
    for (const argv of [["--plans"], ["--game", "2"], ["--plan", "--plan"], ["run"]]) {
      const { code, out } = await t.cli(...argv);
      expect(code, argv.join(" ")).toBe(1);
      expect(out).toContain("Nothing was sent");
    }
    expect(t.calls.opened).toBe(0);
    expect(t.provider.dispatched).toBe(0);
  });

  it("says the plan and sends nothing with --plan", async () => {
    const t = setup(picks(0));
    const { code, out } = await t.cli("--plan");
    expect(code).toBe(0);
    expect(out).toContain("at most 24 request(s), ever");
    expect(out).toContain("gt-1:g1:0 gt-1:g1:1");
    expect(out).toContain("gt-1:g3:16");
    expect(out).toContain("A run now would send at most 24 request(s).");
    expect(out).toContain("Limits set for this run: stop $0.070000");
    expect(out).toContain("bound $1.360691");
    expect(out).toContain("$0.315173 for each request in flight, $1.260691 at the most at one moment");
    expect(out).not.toContain("would not start");
    expect(t.provider.dispatched).toBe(0);
    expect(t.calls).toEqual({ opened: 1, closed: 1 });
  });

  it("with no limits set it still says the plan, and refuses to run before anything is connected", async () => {
    const t = setup(picks(0));
    const plan = await t.cliWith({}, "--plan");
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("No limits are set");
    expect(plan.out).toContain("at most 24 request(s), ever");
    expect(t.calls.opened).toBe(1);
    const run = await t.cliWith({});
    expect(run.code).toBe(1);
    expect(run.out).toContain(`A run needs both of its limits, set by the person running it: ${STOP_ENV} and ${BOUND_ENV}`);
    expect(t.calls.opened).toBe(1);
    expect(t.provider.dispatched).toBe(0);
  });

  it("refuses a limit it cannot read, or one without the other, before anything is connected, even for a plan", async () => {
    const t = setup(picks(0));
    for (const given of [{ [STOP_ENV]: "0.07" }, { [BOUND_ENV]: "2" }, { [STOP_ENV]: "seven cents", [BOUND_ENV]: "2" }, { [STOP_ENV]: "0.07", [BOUND_ENV]: "1e3" }]) {
      for (const argv of [[], ["--plan"]]) {
        const { code, out } = await t.cliWith(given, ...argv);
        expect(code).toBe(1);
        expect(out).toContain("Nothing was sent");
      }
    }
    expect(t.calls.opened).toBe(0);
    expect(t.provider.dispatched).toBe(0);
  });

  it("says in the plan when the limits would not let a round start, and then sends nothing", async () => {
    const t = setup(picks(0));
    const small = { [STOP_ENV]: "0.03", [BOUND_ENV]: "0.03" };
    const plan = await t.cliWith(small, "--plan");
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("With these limits round 1 would not start: a wave of full holds, on top of the estimate up to there, passes the bound.");
    expect(plan.out).toContain("A run now would send at most 0 request(s).");
    // A stop that fits two rounds by estimate: sixteen requests, and the plan says so.
    const two = await t.cliWith({ [STOP_ENV]: "0.009", [BOUND_ENV]: "2" }, "--plan");
    expect(two.out).toContain("With these limits round 3 would not start: by estimate it passes the stop.");
    expect(two.out).toContain("A run now would send at most 16 request(s).");
    const run = await t.cliWith(small);
    expect(run.code).toBe(1);
    expect(run.out).toContain("STOPPED: round 1 was not started");
    expect(t.provider.dispatched).toBe(0);
  });

  it("sends nothing on another envelope", async () => {
    const t = setup(picks(0), { envelope: "deployed" });
    const { code, out } = await t.cli();
    expect(code).toBe(1);
    expect(out).toContain('uses the "local" envelope only');
    expect(t.provider.dispatched).toBe(0);
    expect(t.calls.closed).toBe(1);
  });

  it("sends nothing while paid requests are not authorized", async () => {
    const t = setup(picks(0), { paid: false });
    const { code, out } = await t.cli();
    expect(code).toBe(1);
    expect(out).toContain("Paid requests are not authorized");
    expect(t.provider.dispatched).toBe(0);
    expect((await t.cli("--plan")).code).toBe(0);
    expect(t.calls).toEqual({ opened: 2, closed: 2 });
  });

  it("runs, prints each choice and the summary, and is closed afterwards", async () => {
    const t = setup(picks(3));
    const { code, out } = await t.cli();
    expect(code).toBe(0);
    expect(t.provider.dispatched).toBe(24);
    expect(out).toContain("Round 3, after 12 actions: 8 speaker(s), 8 request(s)");
    expect(out).toContain("24 request(s) sent: 24 picked a listener, 0 picked nobody");
    expect(out).toContain("Picked the 1st, 2nd, 3rd, 4th person offered: 0, 0, 0, 24 time(s).");
    expect(out).toContain(`${24 * 900} input (${24 * 300} cached)`);
    expect(out).not.toContain("STOPPED");
    expect(t.saved.at(-1)).toMatchObject({ id: "gt-1", caseId: c.id, complete: true });
    expect(t.calls).toEqual({ opened: 1, closed: 1 });

    const again = await t.cli();
    expect(again.code).toBe(1);
    expect(again.out).toContain("This trial is closed: the spend store already holds 24 of its request(s). A trial runs once");
    expect((await t.cli("--plan")).code).toBe(0);
    expect(t.provider.dispatched).toBe(24);
  });

  it("ends with an error code and says why when it stopped early", async () => {
    const t = setup((request, index) => {
      if (index === 0) throw new Error("the connection dropped");
      return picks(0)(request);
    });
    const { code, out } = await t.cli();
    expect(code).toBe(1);
    expect(out).toContain("STOPPED: round 1: failed:outcome-unknown");
    expect(out).toContain("PROBLEM: failed:outcome-unknown");
    expect(out).toContain("1 request(s) have no confirmed cost: the spend guard keeps $0.315173 for them");
    const again = await t.cli();
    expect(again.out).toContain("1 of them with an unknown outcome (gt-1:g1:");
    expect(t.provider.dispatched).toBe(4);
  });

  it("says every line in both languages", async () => {
    const t = setup(picks(0));
    const { out } = await t.cli();
    const prose = out.split("\n").filter((line) => line.trim() !== "" && !/^\s+(gt-1:|\d+ ms)/.test(line) && !/^\s+gt-1:g/.test(line));
    for (const line of prose) expect(/[一-鿿]/.test(line), line).toBe(true);
  });
});
