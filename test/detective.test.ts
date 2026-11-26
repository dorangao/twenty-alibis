import { describe, expect, it } from "vitest";
import { DETECTIVE_OUTPUT_TOKENS, detectiveBriefing, MAX_WASTED_IN_A_ROW, playDetective } from "../src/agents/detective";
import { archivePass } from "../src/case/fixtures/archive";
import type { Case } from "../src/case/schema";
import { createMetered, type Metered } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderRequest, ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore } from "../src/spend/store";
import { proofRules } from "../src/case/proof";
import { NOTE_MARK, PROOF_RULES } from "../src/game/rules";
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
// Inspections are numbered as they open: the gallery, kitchen, cellar and boathouse are I1 to I4
// from the start, and the lamp room becomes I5 once its keeper has been heard.
const SOLVE: Action[] = [
  { action: "ask", topic: "T2" },
  { action: "inspect", inspection: "I5" },
  { action: "inspect", inspection: "I1" },
  { action: "inspect", inspection: "I3" },
  { action: "inspect", inspection: "I4" },
  { action: "accuse", person: "P3", cite: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"] },
];

describe("the detective plays through the same game a player does", () => {
  it("solves the twenty-person case by the route a player would take", async () => {
    const { provider, metered } = setup(SOLVE);
    const report = await playDetective({ metered, c: lighthouse, gameId: "g1" });
    expect(report).toMatchObject({ outcome: "solved", turns: 6, actions: 5, requests: 6, costNano: 6 * PRICE, detectiveCostNano: 6 * PRICE, suspectCostNano: 0 });
    expect(report.verdict).toMatchObject({ accused: "s-03", outcome: "solved", missing: [], open: [] });
    expect(report.problem).toBeUndefined();
    expect(report.steps.map((s) => s.did)).toEqual([
      "asked T2 (t-02)",
      "inspected I5 (i-01)",
      "inspected I1 (i-02)",
      "inspected I3 (i-04)",
      "inspected I4 (i-05)",
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
    expect(first.inspection.enum).toEqual(["I1", "I2", "I3", "I4", "none"]);
    expect(first.cite.items.enum).toEqual(["R1", "R2", "R3", "R4", "R5", "R6"]);
    const second = schemaOf(provider.requests[1]!).properties;
    expect(second.inspection.enum).toEqual(["I1", "I2", "I3", "I4", "I5", "none"]);
    // The topic already heard is no longer offered; a handle keeps its meaning from turn to turn.
    expect(second.topic.enum).not.toContain("T2");
    expect(second.topic.enum).toContain("T3");
    const last = schemaOf(provider.requests[5]!).properties;
    expect(last.cite.items.enum).toHaveLength(10);
    expect(last.inspection.enum).toEqual(["I2", "none"]);
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
      { action: "inspect", inspection: "I5" }, // the locked scene: it has no number yet
      { action: "accuse", person: "P3", cite: ["R1"] },
    ]);
    const report = await playDetective({ metered, c: lighthouse, gameId: "g1" });
    expect(report).toMatchObject({ outcome: "no-accusation", turns: MAX_WASTED_IN_A_ROW, actions: 0 });
    expect(report.steps).toEqual([
      { turn: 1, did: "asked for a topic that is not open: T99", used: false },
      { turn: 2, did: "asked to inspect something that is not open: I5", used: false },
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

  it("leaves room to think: every turn carries the output limit, which a caller may set", async () => {
    // Against the real model a turn's reasoning alone passed 800 tokens once the scene's record was held.
    expect(DETECTIVE_OUTPUT_TOKENS).toBeGreaterThanOrEqual(3_000);
    const usual = setup(SOLVE);
    await playDetective({ metered: usual.metered, c: lighthouse, gameId: "g1" });
    expect(new Set(usual.provider.requests.map((r) => r.maxOutputTokens))).toEqual(new Set([DETECTIVE_OUTPUT_TOKENS]));
    const tight = setup(SOLVE);
    await playDetective({ metered: tight.metered, c: lighthouse, gameId: "g1", maxOutputTokens: 1_200 });
    expect(new Set(tight.provider.requests.map((r) => r.maxOutputTokens))).toEqual(new Set([1_200]));
  });

  it("is told the rules of proof word for word as a person is, and then how to play", () => {
    const lines = detectiveBriefing(lighthouse).split("\n");
    const start = lines.indexOf("RULES") + 1;
    // The same four sentences, in the same order, with the same numbers.
    expect(lines.slice(start, start + PROOF_RULES.length)).toEqual(PROOF_RULES.map((rule, i) => `${i + 1}. ${rule.en}`));
    expect(lines[start + 3]).toContain("It does not show that nobody else was");
    // Then the detective's own: numbered on from there, and pointing back at the right rules.
    expect(lines.slice(start + 4, start + 8).map((l) => l.slice(0, 2))).toEqual(["5.", "6.", "7.", "8."]);
    expect(lines[start + 6]).toContain("Do not accuse until your evidence does all of rules 2 to 5.");
    expect(lines[start + 8]).toBe("");
    // The rules are the same for every case.
    expect(detectiveBriefing(archivePass).split("THE CASE")[0]).toBe(detectiveBriefing(lighthouse).split("THE CASE")[0]);
  });

  it("the scene's record is not a roll call: accusing as soon as one person fits is right but unproven", async () => {
    // After the keeper and the scene, one person in the lamp room holds the means and has a motive.
    // The others who hold it and have one are not in that record, and that does not rule them out.
    const early = setup([{ action: "ask", topic: "T2" }, { action: "inspect", inspection: "I5" }, { action: "accuse", person: "P3", cite: ["R1", "R2", "R3", "R4", "R5", "R6", "R7"] }]);
    const report = await playDetective({ metered: early.metered, c: lighthouse, gameId: "g1" });
    expect(report.outcome).toBe("right-but-unproven");
    expect(report.verdict).toMatchObject({ accused: "s-03", missing: [], accusedRuledOut: false });
    expect(report.verdict!.open.length).toBeGreaterThan(0);
    expect(report.steps.at(-1)!.did).toBe("accused P3 (s-03) citing 7 record(s)");
  });

  it("what proves is evidence that is authoritative, whatever its kind, and the notebook marks the rest", async () => {
    // The register proves who held what was needed. As an object it proves the same; marked as a note it proves nothing.
    const culprit = lighthouse.culprit.suspect;
    const change = (patch: object): Case => ({ ...lighthouse, evidence: lighthouse.evidence.map((e) => (e.id === "e-register" ? { ...e, ...patch } : e)) });
    const meansGoal = (c: Case) => proofRules(c).suspectGoals.get(culprit)!.positive[1];
    expect(meansGoal(lighthouse)).toEqual([[["e-register"]]]);
    expect(meansGoal(change({ kind: "object" }))).toEqual([[["e-register"]]]);
    expect(meansGoal(change({ authoritative: false }))).toEqual([]);

    // The detective's notebook marks the one item that is not authoritative, with the rules' own word.
    const { provider, metered } = setup(SOLVE);
    await playDetective({ metered, c: lighthouse, gameId: "g1" });
    const shown = provider.requests[0]!.messages[1]!.content.split("\n");
    expect(shown).toContain("Evidence:");
    expect(shown.filter((l) => l.endsWith(` ${NOTE_MARK.en}`))).toHaveLength(1);
    expect(detectiveBriefing(lighthouse)).toContain("An item marked as a note is not evidence and proves nothing.");
  });

  it("is told that a person no evidence rules out is still open", () => {
    const rules = detectiveBriefing(lighthouse);
    expect(rules).toContain("A person no evidence rules out is still open");
    expect(rules).toContain("keep inspecting while anyone is still open");
    // The rules say how the game is scored. They name nobody and nothing from this case's answer.
    const culprit = lighthouse.suspects.find((s) => s.id === lighthouse.culprit.suspect)!;
    expect(rules.split("THE CASE")[0]).not.toContain(culprit.name.en);
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

  it("gives each turn its own request id, so a game delivered twice is not sent twice", async () => {
    const { provider, metered } = setup(SOLVE);
    await playDetective({ metered, c: lighthouse, gameId: "g1" });
    const again = await playDetective({ metered, c: lighthouse, gameId: "g1" });
    expect(again).toMatchObject({ outcome: "no-accusation", requests: 0, problem: "refused:duplicate-attempt" });
    expect(provider.dispatched).toBe(6);
  });
});

describe("the detective's numbers say nothing about what is still locked", () => {
  it("sends identical requests whether the locked record sits first or last in the case file", async () => {
    // The same case, with the scene's inspection moved from first to last. A player sees no difference until it opens.
    const moved: Case = { ...lighthouse, actions: { ...lighthouse.actions, inspections: [...lighthouse.actions.inspections.slice(1), lighthouse.actions.inspections[0]!] } };
    const first = setup(SOLVE);
    const second = setup(SOLVE);
    const a = await playDetective({ metered: first.metered, c: lighthouse, gameId: "g1" });
    const b = await playDetective({ metered: second.metered, c: moved, gameId: "g1" });
    expect(a.outcome).toBe("solved");
    expect(b.outcome).toBe("solved");
    // Every request of the two games is the same, byte for byte: before the keeper is heard, and after.
    expect(second.provider.bodies).toEqual(first.provider.bodies);
    expect(b.steps).toEqual(a.steps);
  });

  it("numbers a record when it opens, after the ones already on the menu", async () => {
    const { provider, metered } = setup(SOLVE);
    await playDetective({ metered, c: lighthouse, gameId: "g1" });
    expect(provider.requests[0]!.messages[1]!.content).toContain("- I1: Check who was in the gallery at 22:20");
    expect(provider.requests[0]!.messages[1]!.content).not.toContain("lamp room at 22:20");
    expect(provider.requests[1]!.messages[1]!.content).toContain("- I5: Check who was in the lamp room at 22:20");
  });

  it("with an empty notebook offers nothing to cite, in a schema that is still valid", async () => {
    // Every record of the handwritten case moved behind its one inspection: the game opens with nothing held.
    const empty: Case = {
      ...archivePass,
      id: "archive-empty",
      briefing: { evidence: [] },
      actions: { ...archivePass.actions, inspections: [{ ...archivePass.actions.inspections[0]!, yields: archivePass.evidence.map((e) => e.id) }] },
    };
    const { provider, metered } = setup([
      { action: "inspect", inspection: "I1" },
      { action: "accuse", person: "P1", cite: ["R1", "R2", "R3", "R4"] },
    ]);
    const report = await playDetective({ metered, c: empty, gameId: "g1" });
    expect(report.outcome).toBe("solved");
    const first = provider.requests[0]!.responseSchema!.schema as { properties: { cite: unknown } };
    expect(first.properties.cite).toEqual({ type: "array", items: { type: "string" }, maxItems: 0 });
    expect(schemaOf(provider.requests[1]!).properties.cite.items.enum).toEqual(["R1", "R2", "R3", "R4"]);
  });
});

describe("a reply whose cost is not confirmed is not acted on", () => {
  /** A detective wrapper that answers from a script and reports each reply as settled or not. */
  const scripted = (script: Action[], verdictAt: (n: number) => { settled: boolean; breached: boolean }) => {
    let sent = 0;
    const metered: Metered = async (request) => {
      const n = sent++;
      return { ok: true, attemptId: request.attemptId, response: reply(script[n]!), costNano: 12, ...verdictAt(n) };
    };
    return { metered, sent: () => sent };
  };
  const ok = { settled: true, breached: false };

  it("an unconfirmed accusation is not scored", async () => {
    for (const [last, problem, costNano] of [
      [{ settled: false, breached: false }, "unconfirmed:not-settled", 12],
      [{ settled: true, breached: true }, "envelope-suspended", 24],
    ] as const) {
      const d = scripted(
        [
          { action: "inspect", inspection: "I1" },
          { action: "accuse", person: "P1", cite: ["R1", "R2", "R3", "R4"] },
        ],
        (n) => (n === 1 ? last : ok),
      );
      const report = await playDetective({ metered: d.metered, c: archivePass, gameId: "g1" });
      expect(report, problem).toMatchObject({ outcome: "no-accusation", turns: 2, actions: 1, costNano, problem });
      expect(report.verdict, problem).toBeUndefined();
      expect(report.session.verdict, problem).toBeUndefined();
      expect(report.steps.at(-1), problem).toEqual({ turn: 2, did: `the reply came back but was not acted on: ${problem}`, used: false });
    }
  });

  it("an unconfirmed question does not reach the suspect", async () => {
    const d = scripted([{ action: "ask", topic: "T1" }], () => ({ settled: false, breached: false }));
    let suspectRequests = 0;
    const suspects: Metered = async (request) => {
      suspectRequests++;
      return { ok: true, attemptId: request.attemptId, response: reply({ action: "ask" }), costNano: 456, settled: true, breached: false };
    };
    const report = await playDetective({ metered: d.metered, suspects, c: archivePass, gameId: "g1" });
    expect(report).toMatchObject({ outcome: "no-accusation", turns: 1, actions: 0, requests: 1, problem: "unconfirmed:not-settled" });
    expect(suspectRequests).toBe(0);
    expect(report.session.turns).toEqual([]);
  });
});

describe("when the suspects' model is turned on", () => {
  const answer: ProviderResponse = { text: JSON.stringify({ assertions: ["a-ada-foyer-2100"], line: "I was in the foyer at 21:00.", language: "en" }), toolCalls: [], usage, finishReason: "stop" };
  const game: Action[] = [
    { action: "ask", topic: "T1" },
    { action: "inspect", inspection: "I1" },
    { action: "accuse", person: "P1", cite: ["R1", "R2", "R3", "R4"] },
  ];
  const detective = (): Metered => {
    let n = 0;
    return async (request) => ({ ok: true, attemptId: request.attemptId, response: reply(game[n++]!), costNano: 12, settled: true, breached: false });
  };

  it("reports the whole game's cost and both parts of it", async () => {
    const suspects: Metered = async (request) => ({ ok: true, attemptId: request.attemptId, response: answer, costNano: 456, settled: true, breached: false });
    const report = await playDetective({ metered: detective(), suspects, c: archivePass, gameId: "g1" });
    expect(report).toMatchObject({ outcome: "solved", requests: 4, detectiveCostNano: 36, suspectCostNano: 456, costNano: 492 });
    expect(report.session.turns[0]!.turn).toMatchObject({ source: "model", line: "I was in the foyer at 21:00." });
  });

  it("a refusal from it ends the game, where the model being off would not", async () => {
    const suspended: Metered = async (request) => ({ ok: false, attemptId: request.attemptId, sent: false, reason: "envelope-suspended" });
    const live = await playDetective({ metered: detective(), suspects: suspended, c: archivePass, gameId: "g1" });
    expect(live).toMatchObject({ outcome: "no-accusation", turns: 1, problem: "suspect:refused:envelope-suspended" });
    expect(live.session.verdict).toBeUndefined();
    // The same game with the suspects' model simply off plays to the end.
    expect(await playDetective({ metered: detective(), c: archivePass, gameId: "g1" })).toMatchObject({ outcome: "solved", suspectCostNano: 0, costNano: 36 });
  });

  it("an unconfirmed suspect request ends the game too", async () => {
    const pending: Metered = async (request) => ({ ok: true, attemptId: request.attemptId, response: answer, costNano: 456, settled: false, breached: false });
    const report = await playDetective({ metered: detective(), suspects: pending, c: archivePass, gameId: "g1" });
    expect(report).toMatchObject({ outcome: "no-accusation", turns: 1, actions: 1, suspectCostNano: 0, problem: "suspect:unconfirmed:not-settled" });
  });
});
