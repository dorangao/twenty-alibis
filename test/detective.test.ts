import { describe, expect, it } from "vitest";
import { detectiveBriefing, MAX_WASTED_IN_A_ROW, playDetective } from "../src/agents/detective";
import { archivePass } from "../src/case/fixtures/archive";
import type { Case } from "../src/case/schema";
import { createMetered, type Metered } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderRequest, ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore } from "../src/spend/store";
import { compilePlot } from "../src/writer/compile";
import { lighthousePeople, lighthouseSkeleton } from "../src/writer/fixtures/lighthouse";

const lighthouse: Case = (() => {
  const result = compilePlot("lighthouse", lighthouseSkeleton, lighthousePeople);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.case;
})();

const usage = { inputTokens: 1_500, cachedTokens: 0, outputTokens: 100 };
const PRICE = 1_500 * 100 + 100 * 500;
type Action = { action: string; topic?: string; inspection?: string; person?: string; cite?: string[] };
const reply = (a: Action): ProviderResponse => ({
  text: JSON.stringify({ action: a.action, topic: a.topic ?? "none", inspection: a.inspection ?? "none", person: a.person ?? "none", cite: a.cite ?? [] }),
  toolCalls: [],
  usage,
  finishReason: "stop",
});

function setup(script: (Action | ProviderResponse | Error)[], options: { killSwitch?: () => boolean } = {}) {
  const provider = new FakeProvider((_request, index) => {
    const next = script[Math.min(index, script.length - 1)]!;
    if (next instanceof Error) throw next;
    return "action" in next ? reply(next) : next;
  });
  const metered = createMetered({
    inputBound: { tokensPerByte: 100 },
    provider,
    store: new MemorySpendStore(),
    envelope: "e",
    limitNano: usdToNano(1),
    ...(options.killSwitch ? { killSwitch: options.killSwitch } : {}),
  });
  return { provider, metered };
}
const schemaOf = (request: ProviderRequest) =>
  request.responseSchema!.schema as { properties: { action: { enum: string[] }; topic: { enum: string[] }; inspection: { enum: string[] }; person: { enum: string[] }; cite: { items: { enum: string[] } } } };

/** The route a careful player takes on the lighthouse: hear the keeper, look at the rooms that matter, accuse with everything held. */
const SOLVE: Action[] = [
  { action: "ask", topic: "T2" },
  { action: "inspect", inspection: "I1" },
  { action: "inspect", inspection: "I2" },
  { action: "inspect", inspection: "I4" },
  { action: "inspect", inspection: "I5" },
  { action: "accuse", person: "P3", cite: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"] },
];

describe("the detective plays through the same game a player does", () => {
  it("solves the twenty-person case by the route a player would take", async () => {
    const { provider, metered } = setup(SOLVE);
    const report = await playDetective({ metered, c: lighthouse, gameId: "g1" });
    expect(report).toMatchObject({ outcome: "solved", turns: 6, actions: 5, requests: 6, costNano: 6 * PRICE });
    expect(report.verdict).toMatchObject({ accused: "s-03", outcome: "solved", missing: [], open: [] });
    expect(report.problem).toBeUndefined();
    expect(report.steps.map((s) => s.did)).toEqual([
      "asked T2 (t-02)",
      "inspected I1 (i-01)",
      "inspected I2 (i-02)",
      "inspected I4 (i-04)",
      "inspected I5 (i-05)",
      "accused P3 (s-03) citing 10 record(s)",
    ]);
    // The suspects' model is off by default: questioning them sent nothing.
    expect(provider.dispatched).toBe(6);
    expect(provider.requests.map((r) => r.messages.length)).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it("solves the handwritten case too", async () => {
    const { metered } = setup([
      { action: "inspect", inspection: "I1" },
      { action: "accuse", person: "P1", cite: ["R1", "R2", "R3", "R4"] },
    ]);
    expect(await playDetective({ metered, c: archivePass, gameId: "g1" })).toMatchObject({ outcome: "solved", turns: 2, actions: 1 });
  });

  it("is scored by the scorer: a right name without proof, and a wrong name, are not solved", async () => {
    const guess = setup([{ action: "accuse", person: "P3", cite: ["R1"] }]);
    const unproven = await playDetective({ metered: guess.metered, c: lighthouse, gameId: "g1" });
    expect(unproven).toMatchObject({ outcome: "right-but-unproven", turns: 1, actions: 0 });
    expect(unproven.verdict!.missing).toEqual(["opportunity", "motive"]);

    const wrong = setup([{ action: "accuse", person: "P1", cite: ["R1", "R2"] }]);
    expect(await playDetective({ metered: wrong.metered, c: lighthouse, gameId: "g1" })).toMatchObject({ outcome: "wrong" });
  });
});

describe("the detective is shown what a player sees, and nothing else", () => {
  it("never receives the answer, the hidden truth, or a record it has not inspected", async () => {
    const { provider, metered } = setup(SOLVE);
    await playDetective({ metered, c: lighthouse, gameId: "g1" });
    const sceneRecord = lighthouse.evidence.find((e) => e.id === "e-room-01")!.text.en;
    // Before the scene is inspected (the third request), its record is in no request.
    for (const body of provider.bodies.slice(0, 2)) expect(body).not.toContain("Lamp room, 22:20");
    expect(provider.bodies[2]).toContain(sceneRecord);
    for (const body of provider.bodies) {
      expect(body).not.toContain("culprit");
      expect(body).not.toContain("whereabouts");
      expect(body).not.toContain('"lies"');
      // No ids of the case file at all: the detective answers with handles.
      for (const a of lighthouse.assertions) expect(body).not.toContain(a.id);
      for (const e of lighthouse.evidence) expect(body).not.toContain(e.id);
      for (const s of lighthouse.suspects) expect(body).not.toContain(`"${s.id}"`);
      expect(body).not.toMatch(/\bs-0\d\b|\bt-0\d\b|\bi-0\d\b/);
    }
  });

  it("opens the same way whoever did it", () => {
    const a = lighthousePeople.suspects.find((s) => s.id === "s-01")!;
    const b = lighthousePeople.suspects.find((s) => s.id === "s-03")!;
    const swapped = compilePlot("lighthouse", lighthouseSkeleton, {
      culprit: "s-01",
      suspects: lighthousePeople.suspects.map((s) => (s.id === "s-01" ? { ...s, whereabouts: b.whereabouts } : s.id === "s-03" ? { ...s, whereabouts: a.whereabouts } : s)),
    });
    if (!swapped.ok) throw new Error("expected a case");
    expect(detectiveBriefing(swapped.case)).toBe(detectiveBriefing(lighthouse));
  });

  it("is offered only what is open right now", async () => {
    const { provider, metered } = setup(SOLVE);
    await playDetective({ metered, c: lighthouse, gameId: "g1" });
    const first = schemaOf(provider.requests[0]!).properties;
    expect(first.action.enum).toEqual(["ask", "inspect", "accuse"]);
    expect(first.topic.enum).toHaveLength(21); // twenty people, and "none"
    // The scene's record is locked until its keeper is heard.
    expect(first.inspection.enum).toEqual(["I2", "I3", "I4", "I5", "none"]);
    expect(first.cite.items.enum).toEqual(["R1", "R2", "R3", "R4", "R5", "R6"]);
    const second = schemaOf(provider.requests[1]!).properties;
    expect(second.inspection.enum).toEqual(["I1", "I2", "I3", "I4", "I5", "none"]);
    // The topic already heard is no longer offered; a handle keeps its meaning from turn to turn.
    expect(second.topic.enum).not.toContain("T2");
    expect(second.topic.enum).toContain("T3");
    const last = schemaOf(provider.requests[5]!).properties;
    expect(last.cite.items.enum).toHaveLength(10);
    expect(last.inspection.enum).toEqual(["I3", "none"]);
  });

  it("with no actions left may only accuse", async () => {
    const short: Case = { ...archivePass, id: "archive-short", sessionCap: 1 };
    const { provider, metered } = setup([
      { action: "inspect", inspection: "I1" },
      { action: "accuse", person: "P1", cite: ["R1", "R2", "R3", "R4"] },
    ]);
    const report = await playDetective({ metered, c: short, gameId: "g1" });
    expect(report.outcome).toBe("solved");
    const second = schemaOf(provider.requests[1]!).properties;
    expect(second.action.enum).toEqual(["accuse"]);
    expect(second.topic.enum).toEqual(["none"]);
    expect(second.inspection.enum).toEqual(["none"]);
    expect(provider.requests[1]!.messages[1]!.content).not.toContain("Ask a topic:");
  });
});

describe("a detective that does not make progress is stopped", () => {
  it("counts an unusable reply as a wasted turn and stops after two in a row", async () => {
    const { provider, metered } = setup([
      { action: "ask", topic: "T99" },
      { action: "inspect", inspection: "I1" }, // locked: not open yet
      { action: "accuse", person: "P3", cite: ["R1"] },
    ]);
    const report = await playDetective({ metered, c: lighthouse, gameId: "g1" });
    expect(report).toMatchObject({ outcome: "no-accusation", turns: MAX_WASTED_IN_A_ROW, actions: 0 });
    expect(report.steps).toEqual([
      { turn: 1, did: "asked for a topic that is not open: T99", used: false },
      { turn: 2, did: "asked to inspect something that is not open: I1", used: false },
    ]);
    expect(provider.dispatched).toBe(2);
  });

  it("forgives a wasted turn when the next is used: only two in a row end the game", async () => {
    const bad: ProviderResponse = { text: "not json", toolCalls: [], usage, finishReason: "stop" };
    const cutOff: ProviderResponse = { text: null, toolCalls: [], usage, finishReason: "length" };
    // Wasted, a question, wasted, an inspection, wasted, and on to the end: never two in a row.
    const { metered } = setup([bad, SOLVE[0]!, cutOff, SOLVE[1]!, bad, ...SOLVE.slice(2)]);
    const report = await playDetective({ metered, c: lighthouse, gameId: "g1" });
    expect(report).toMatchObject({ outcome: "solved", turns: 9, actions: 5 });
    expect(report.steps[0]).toEqual({ turn: 1, did: "the reply was not the object asked for", used: false });
    expect(report.steps[2]).toEqual({ turn: 3, did: "the reply was cut off at the output limit", used: false });
  });

  it("refuses an accusation that cites a record it does not hold, or names nobody", async () => {
    const { metered } = setup([
      { action: "accuse", person: "P3", cite: ["R9"] },
      { action: "accuse", person: "none", cite: [] },
    ]);
    const report = await playDetective({ metered, c: lighthouse, gameId: "g1" });
    expect(report).toMatchObject({ outcome: "no-accusation", turns: 2 });
    expect(report.session.verdict).toBeUndefined();
  });

  it("stops at its turn limit without accusing", async () => {
    const { provider, metered } = setup([{ action: "ask", topic: "T1" }, { action: "ask", topic: "T2" }, { action: "ask", topic: "T3" }, { action: "ask", topic: "T4" }]);
    const report = await playDetective({ metered, c: lighthouse, gameId: "g1", maxTurns: 3 });
    expect(report).toMatchObject({ outcome: "no-accusation", turns: 3, actions: 3 });
    expect(report.steps.at(-1)).toEqual({ turn: 4, did: "ran out of turns without accusing", used: false });
    expect(provider.dispatched).toBe(3);
  });
});

describe("the detective stops when a request does not come back cleanly", () => {
  it("sends nothing when refused, and reports the problem", async () => {
    const { provider, metered } = setup(SOLVE, { killSwitch: () => true });
    expect(await playDetective({ metered, c: lighthouse, gameId: "g1" })).toMatchObject({ outcome: "no-accusation", turns: 1, requests: 0, costNano: 0, problem: "refused:kill-switch" });
    expect(provider.dispatched).toBe(0);
  });

  it("stops after a failed request", async () => {
    const { provider, metered } = setup([{ action: "ask", topic: "T2" }, new Error("socket closed"), { action: "inspect", inspection: "I1" }]);
    expect(await playDetective({ metered, c: lighthouse, gameId: "g1" })).toMatchObject({ outcome: "no-accusation", turns: 2, requests: 2, costNano: PRICE, problem: "failed:outcome-unknown" });
    expect(provider.dispatched).toBe(2);
  });

  it("counts a cost only when it was settled, and stops on unsettled or suspended alike", async () => {
    for (const [settled, breached, costNano, problem] of [
      [false, false, 0, "unconfirmed:not-settled"],
      [true, true, 12, "envelope-suspended"],
    ] as const) {
      let sent = 0;
      const metered: Metered = async (request) => {
        sent++;
        return { ok: true, attemptId: request.attemptId, response: reply({ action: "ask", topic: "T2" }), costNano: 12, settled, breached };
      };
      const report = await playDetective({ metered, c: lighthouse, gameId: "g1" });
      expect(report, problem).toMatchObject({ outcome: "no-accusation", turns: 1, costNano, problem });
      expect(sent, problem).toBe(1);
    }
  });

  it("gives each turn its own request id, so a game delivered twice is not sent twice", async () => {
    const { provider, metered } = setup(SOLVE);
    await playDetective({ metered, c: lighthouse, gameId: "g1" });
    const again = await playDetective({ metered, c: lighthouse, gameId: "g1" });
    expect(again).toMatchObject({ outcome: "no-accusation", requests: 0, problem: "refused:duplicate-attempt" });
    expect(provider.dispatched).toBe(6);
  });
});
