import { describe, expect, it } from "vitest";
import { archiveFailTwin, archivePass } from "../src/case/fixtures/archive";
import type { Case } from "../src/case/schema";
import { solve } from "../src/case/solver";
import { accuse, actionsLeft, ask, heldBy, inspect, inspectionMenu, notebook, reveal, SessionError, startSession, topicMenu, type Session } from "../src/game/session";
import { createMetered } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderRequest, ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore } from "../src/spend/store";

const c = archivePass;
const usage = { inputTokens: 1_000, cachedTokens: 0, outputTokens: 60 };

/**
 * A stand-in suspect that behaves well: asked to choose, it calls recall with the first
 * topic on its menu; asked to answer, it repeats the statements it was given, word for word.
 */
function wellBehaved(request: ProviderRequest): ProviderResponse {
  if (request.tools?.length) {
    const menu = (request.tools[0]!.parameters as { properties: { topic: { enum: string[] } } }).properties.topic.enum;
    return { text: null, toolCalls: [{ id: "call_1", name: "recall", arguments: JSON.stringify({ topic: menu[0] }) }], usage, finishReason: "tool_calls" };
  }
  const recalled = JSON.parse(request.messages.find((m) => m.role === "tool")!.content) as { statements: { id: string; en: string; zh: string }[] };
  const zh = /\p{Script=Han}/u.test(request.messages.find((m) => m.role === "user")!.content);
  const line = recalled.statements.map((s) => (zh ? s.zh : s.en)).join(" ") || (zh ? "我不知道。" : "I don't know.");
  return { text: JSON.stringify({ assertions: recalled.statements.map((s) => s.id), line, language: zh ? "zh" : "en" }), toolCalls: [], usage, finishReason: "stop" };
}

function setup(options: { handler?: (request: ProviderRequest, index: number) => ProviderResponse; killSwitch?: () => boolean } = {}) {
  const provider = new FakeProvider(options.handler ?? wellBehaved);
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
const code = async (work: () => unknown): Promise<string> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof SessionError) return error.code;
    throw error;
  }
  return "no error";
};
const gated: Case = { ...c, id: "archive-gated", actions: { ...c.actions, topics: c.actions.topics.map((t) => (t.id === "t-ada-2100" ? { ...t, requires: ["e-attendance-log"] } : t)) } };
const short: Case = { ...c, id: "archive-short", sessionCap: 2 };

describe("a session starts with the briefing and nothing else", () => {
  it("holds the briefing evidence and has every action left", () => {
    const s = startSession(c, "s1");
    expect(s).toEqual({ id: "s1", caseId: "archive-pass", actions: 0, evidence: ["e-key-register", "e-letters", "e-dinner-photo"], inspections: [], asked: 0, turns: [] });
    expect(actionsLeft(c, s)).toBe(40);
    expect(notebook(c, s)).toMatchObject({ statements: [], contradictions: [] });
    expect(notebook(c, s).evidence.map((e) => e.id)).toEqual(["e-key-register", "e-letters", "e-dinner-photo"]);
  });

  it("offers what is open, and hides a topic until the player holds what it needs", () => {
    const s = startSession(gated, "s1");
    expect(topicMenu(gated, s, "s-ada")).toEqual([]);
    expect(topicMenu(gated, s, "s-ben").map((t) => t.id)).toEqual(["t-ben-2100"]);
    expect(inspectionMenu(gated, s)).toEqual([{ id: "i-attendance-log", label: { en: "Inspect the door and desk logs", zh: "查看门禁和前台记录" }, done: false }]);
    const after = inspect(gated, s, "i-attendance-log").session;
    expect(topicMenu(gated, after, "s-ada").map((t) => [t.id, t.heard])).toEqual([["t-ada-2100", false]]);
    expect(inspectionMenu(gated, after)[0]!.done).toBe(true);
  });

  it("is plain data: it survives being stored and read back", async () => {
    const { metered } = setup();
    let s = inspect(c, startSession(c, "s1"), "i-attendance-log").session;
    s = (await ask(metered, c, s, { suspect: "s-ada", topic: "t-ada-2100" })).session;
    const stored = JSON.parse(JSON.stringify(s)) as Session;
    expect(stored).toEqual(s);
    expect(accuse(c, stored, { suspect: "s-ada", evidence: stored.evidence }).verdict.outcome).toBe("solved");
  });

  it("refuses a session that belongs to another case", () => {
    expect(() => inspect(archiveFailTwin, startSession(c, "s1"), "i-attendance-log")).toThrow("belongs to case");
  });
});

describe("inspecting", () => {
  it("costs one action and adds the record to the notebook", () => {
    const start = startSession(c, "s1");
    const { session, evidence, repeated } = inspect(c, start, "i-attendance-log");
    expect(repeated).toBe(false);
    expect(evidence.map((e) => e.id)).toEqual(["e-attendance-log"]);
    expect(session.actions).toBe(1);
    expect(session.evidence).toEqual([...start.evidence, "e-attendance-log"]);
    // The session passed in is not changed.
    expect(start.actions).toBe(0);
    expect(start.evidence).toHaveLength(3);
  });

  it("looking again is free and changes nothing", () => {
    const once = inspect(c, startSession(c, "s1"), "i-attendance-log").session;
    const again = inspect(c, once, "i-attendance-log");
    expect(again.repeated).toBe(true);
    expect(again.session).toBe(once);
    expect(again.evidence.map((e) => e.id)).toEqual(["e-attendance-log"]);
  });

  it("gives the same error for a locked inspection and one that does not exist", async () => {
    const locked: Case = { ...c, id: "x", actions: { ...c.actions, inspections: c.actions.inspections.map((i) => ({ ...i, requires: ["a-ben-foyer-2100"] })) } };
    const s = startSession(locked, "s1");
    expect(await code(() => inspect(locked, s, "i-attendance-log"))).toBe("not-available");
    expect(await code(() => inspect(locked, s, "i-nothing"))).toBe("not-available");
  });
});

describe("asking", () => {
  it("a menu topic costs one action and one request, and its statement is held", async () => {
    const { metered, provider } = setup();
    const { session, turn, replayed, recorded } = await ask(metered, c, startSession(c, "s1"), { suspect: "s-ada", topic: "t-ada-2100" });
    expect({ replayed, recorded }).toEqual({ replayed: false, recorded: true });
    expect(turn).toMatchObject({ topic: "t-ada-2100", line: "I was in the foyer at 21:00.", source: "model", requests: 1 });
    expect(session).toMatchObject({ actions: 1, asked: 1 });
    expect(session.turns).toEqual([{ n: 1, question: "Where were you at 21:00?", turn }]);
    expect(heldBy(session).has("a-ada-foyer-2100")).toBe(true);
    expect(provider.dispatched).toBe(1);
    expect(topicMenu(c, session, "s-ada")[0]!.heard).toBe(true);
  });

  it("asks a menu topic in the language the player chose", async () => {
    const { metered } = setup();
    const { turn, session } = await ask(metered, c, startSession(c, "s1"), { suspect: "s-ada", topic: "t-ada-2100", language: "zh" });
    expect(session.turns[0]!.question).toBe("21:00 你在哪里？");
    expect(turn).toMatchObject({ language: "zh", line: "21:00 我在门厅。" });
  });

  it("a topic heard before is replayed: nothing is sent and no action is used", async () => {
    const { metered, provider } = setup();
    const first = await ask(metered, c, startSession(c, "s1"), { suspect: "s-ada", topic: "t-ada-2100" });
    const again = await ask(metered, c, first.session, { suspect: "s-ada", topic: "t-ada-2100" });
    expect(again).toMatchObject({ replayed: true, recorded: true });
    expect(again.turn).toBe(first.turn);
    expect(again.session).toBe(first.session);
    expect(provider.dispatched).toBe(1);
  });

  it("replays a topic that an earlier typed question already landed on", async () => {
    const { metered, provider } = setup();
    const typed = await ask(metered, c, startSession(c, "s1"), { suspect: "s-ada", question: "So where were you?" });
    expect(typed.turn).toMatchObject({ topic: "t-ada-2100", topicGiven: false, requests: 2 });
    const menu = await ask(metered, c, typed.session, { suspect: "s-ada", topic: "t-ada-2100" });
    expect(menu.replayed).toBe(true);
    expect(provider.dispatched).toBe(2);
  });

  it("gives each question its own request ids", async () => {
    const { metered, provider } = setup();
    let s = startSession(c, "game-7");
    s = (await ask(metered, c, s, { suspect: "s-ada", question: "Where were you?" })).session;
    s = (await ask(metered, c, s, { suspect: "s-ben", question: "And you?" })).session;
    expect(s.turns.map((t) => t.n)).toEqual([1, 2]);
    expect(provider.dispatched).toBe(4);
    expect(notebook(c, s).statements.map((x) => [x.turn, x.suspect, x.assertion])).toEqual([
      [1, "s-ada", "a-ada-foyer-2100"],
      [2, "s-ben", "a-ben-foyer-2100"],
    ]);
  });

  it("refuses what is not there, without sending anything", async () => {
    const { metered, provider } = setup();
    const s = startSession(gated, "s1");
    expect(await code(() => ask(metered, gated, s, { suspect: "s-nobody", question: "hi" }))).toBe("not-available");
    expect(await code(() => ask(metered, gated, s, { suspect: "s-ada", topic: "t-ada-2100" }))).toBe("not-available"); // locked
    expect(await code(() => ask(metered, gated, s, { suspect: "s-ada", topic: "t-ben-2100" }))).toBe("not-available"); // someone else's
    expect(await code(() => ask(metered, gated, s, { suspect: "s-ada", topic: "t-nothing" }))).toBe("not-available");
    expect(await code(() => ask(metered, gated, s, { suspect: "s-ada" }))).toBe("bad-question");
    expect(await code(() => ask(metered, gated, s, { suspect: "s-ada", question: "   " }))).toBe("bad-question");
    expect(await code(() => ask(metered, gated, s, { suspect: "s-ada", question: "x".repeat(301) }))).toBe("bad-question");
    expect(provider.dispatched).toBe(0);
  });

  it("when the spend guard refuses a typed question, keeps nothing and uses no action", async () => {
    let off = true;
    const { metered, provider } = setup({ killSwitch: () => off });
    const start = startSession(c, "s1");
    const refused = await ask(metered, c, start, { suspect: "s-ada", question: "Where were you?" });
    expect(refused).toMatchObject({ recorded: false, replayed: false });
    expect(refused.turn).toMatchObject({ source: "deflection", problem: "refused:kill-switch", statements: [] });
    expect(refused.session).toMatchObject({ actions: 0, turns: [], asked: 1 });
    expect(provider.dispatched).toBe(0);
    // Asked again once the guard allows it, the question goes through under a new number.
    off = false;
    const allowed = await ask(metered, c, refused.session, { suspect: "s-ada", question: "Where were you?" });
    expect(allowed.turn).toMatchObject({ source: "model", topic: "t-ada-2100" });
    expect(allowed.session).toMatchObject({ actions: 1, asked: 2 });
    expect(allowed.session.turns.map((t) => t.n)).toEqual([2]);
  });

  it("when the spend guard refuses a menu topic, the statement is still given, worded by code", async () => {
    const { metered, provider } = setup({ killSwitch: () => true });
    const { session, turn, recorded } = await ask(metered, c, startSession(c, "s1"), { suspect: "s-ada", topic: "t-ada-2100" });
    expect(recorded).toBe(true);
    expect(turn).toMatchObject({ source: "rendered", line: "I was in the foyer at 21:00.", requests: 0 });
    expect(session.actions).toBe(1);
    expect(heldBy(session).has("a-ada-foyer-2100")).toBe(true);
    expect(provider.dispatched).toBe(0);
  });

  it("keeps a question whose request failed after it was sent", async () => {
    const { metered } = setup({
      handler: () => {
        throw new Error("socket closed");
      },
    });
    const { session, turn, recorded } = await ask(metered, c, startSession(c, "s1"), { suspect: "s-ada", question: "Where were you?" });
    expect(recorded).toBe(true);
    expect(turn).toMatchObject({ source: "deflection", requests: 1, problem: "failed:outcome-unknown" });
    expect(session).toMatchObject({ actions: 1, asked: 1 });
  });
});

describe("the action cap", () => {
  it("stops new questions and inspections, but not replays or the accusation", async () => {
    const { metered, provider } = setup();
    let s = startSession(short, "s1");
    s = (await ask(metered, short, s, { suspect: "s-ada", topic: "t-ada-2100" })).session;
    s = (await ask(metered, short, s, { suspect: "s-ben", topic: "t-ben-2100" })).session;
    expect(actionsLeft(short, s)).toBe(0);
    expect(await code(() => inspect(short, s, "i-attendance-log"))).toBe("cap");
    expect(await code(() => ask(metered, short, s, { suspect: "s-ada", question: "Anything else?" }))).toBe("cap");
    expect(provider.dispatched).toBe(2);
    expect((await ask(metered, short, s, { suspect: "s-ada", topic: "t-ada-2100" })).replayed).toBe(true);
    expect(accuse(short, s, { suspect: "s-ada", evidence: s.evidence }).verdict.outcome).toBe("right-but-unproven");
  });
});

describe("the notebook", () => {
  it("shows a contradiction only once the statement and the record are both held", async () => {
    const { metered } = setup();
    let s = startSession(c, "s1");
    s = (await ask(metered, c, s, { suspect: "s-ada", topic: "t-ada-2100" })).session;
    s = (await ask(metered, c, s, { suspect: "s-ben", topic: "t-ben-2100" })).session;
    expect(notebook(c, s).contradictions).toEqual([]);
    s = inspect(c, s, "i-attendance-log").session;
    // Ada's claim is against the door log. Ben's matches it.
    expect(notebook(c, s).contradictions).toEqual([{ suspect: "s-ada", assertion: "a-ada-foyer-2100", evidence: "e-attendance-log" }]);
  });

  it("does not set a record that is not authoritative against a statement", async () => {
    const rumour: Case = {
      ...c,
      id: "archive-rumour",
      evidence: [...c.evidence, { id: "e-rumour", kind: "record", authoritative: false, proves: ["a-ada-archive-2100"], text: { en: "A note: someone thought they saw Ada near the archive.", zh: "一张便条：有人觉得在档案室附近见过艾达。" } }],
      briefing: { evidence: [...c.briefing.evidence, "e-rumour"] },
    };
    const { metered } = setup();
    const s = (await ask(metered, rumour, startSession(rumour, "s1"), { suspect: "s-ada", topic: "t-ada-2100" })).session;
    expect(notebook(rumour, s).evidence.find((e) => e.id === "e-rumour")).toMatchObject({ authoritative: false });
    expect(notebook(rumour, s).contradictions).toEqual([]);
    // And it proves nothing in an accusation.
    expect(accuse(rumour, s, { suspect: "s-ada", evidence: s.evidence }).verdict).toMatchObject({ outcome: "right-but-unproven", missing: ["opportunity"] });
  });

  it("words statements by code, whatever line was shown", async () => {
    const { metered } = setup();
    const s = (await ask(metered, c, startSession(c, "s1"), { suspect: "s-ada", topic: "t-ada-2100", language: "zh" })).session;
    expect(notebook(c, s).statements).toEqual([{ turn: 1, suspect: "s-ada", assertion: "a-ada-foyer-2100", en: "I was in the foyer at 21:00.", zh: "21:00 我在门厅。" }]);
  });
});

describe("the accusation is scored by the solver's rules", () => {
  const full = () => inspect(c, startSession(c, "s1"), "i-attendance-log").session;

  it("accepts the solver's own proof, followed action by action", () => {
    const proof = solve(c).proof!;
    let s = startSession(c, "s1");
    for (const action of proof.actions) {
      expect(action.type).toBe("inspection");
      s = inspect(c, s, action.id).session;
    }
    const { verdict, session } = accuse(c, s, { suspect: "s-ada", evidence: proof.evidence });
    expect(verdict).toEqual({ accused: "s-ada", cited: proof.evidence, outcome: "solved", missing: [], open: [], accusedRuledOut: false, actions: proof.actions.length });
    expect(session.verdict).toEqual(verdict);
  });

  it("the right name without the proof is not a solution, and says what is missing", () => {
    const s = startSession(c, "s1");
    expect(accuse(c, s, { suspect: "s-ada", evidence: s.evidence }).verdict).toMatchObject({ outcome: "right-but-unproven", missing: ["opportunity"], open: ["s-ben"], accusedRuledOut: false });
    expect(accuse(c, s, { suspect: "s-ada", evidence: [] }).verdict).toMatchObject({
      outcome: "right-but-unproven",
      missing: ["opportunity", "means", "motive"],
      open: c.suspects.map((x) => x.id).filter((id) => id !== "s-ada"),
    });
  });

  it("counts only the evidence that is cited", () => {
    const s = full();
    // The player holds the log but does not cite it.
    expect(accuse(c, s, { suspect: "s-ada", evidence: ["e-key-register", "e-letters", "e-dinner-photo"] }).verdict.outcome).toBe("right-but-unproven");
    expect(accuse(c, s, { suspect: "s-ada", evidence: s.evidence }).verdict.outcome).toBe("solved");
  });

  it("a wrong name is wrong, and the verdict shows the evidence against it", () => {
    const s = full();
    expect(accuse(c, s, { suspect: "s-ben", evidence: s.evidence }).verdict).toMatchObject({ outcome: "wrong", accusedRuledOut: true, missing: ["opportunity"], open: ["s-ada"] });
    expect(accuse(c, s, { suspect: "s-clara", evidence: s.evidence }).verdict).toMatchObject({ outcome: "wrong", accusedRuledOut: true });
  });

  it("statements prove nothing", async () => {
    const { metered } = setup();
    let s = startSession(c, "s1");
    s = (await ask(metered, c, s, { suspect: "s-ben", topic: "t-ben-2100" })).session;
    // Ben has said he was in the foyer. That does not rule him out.
    expect(accuse(c, s, { suspect: "s-ada", evidence: s.evidence }).verdict.open).toEqual(["s-ben"]);
    expect(await code(() => accuse(c, s, { suspect: "s-ada", evidence: ["a-ben-foyer-2100"] }))).toBe("not-held");
  });

  it("refuses evidence the player does not hold, and a suspect that does not exist", async () => {
    const s = startSession(c, "s1");
    expect(await code(() => accuse(c, s, { suspect: "s-ada", evidence: ["e-attendance-log"] }))).toBe("not-held");
    expect(await code(() => accuse(c, s, { suspect: "s-nobody", evidence: [] }))).toBe("not-available");
  });

  it("the twin that the solver refuses cannot be solved by a player either", () => {
    const s = startSession(archiveFailTwin, "s1");
    expect(inspectionMenu(archiveFailTwin, s)).toEqual([]);
    expect(accuse(archiveFailTwin, s, { suspect: "s-ada", evidence: s.evidence }).verdict).toMatchObject({ outcome: "right-but-unproven", open: ["s-ben"] });
  });

  it("never calls it solved when the cited records also rule the accused out", () => {
    // No valid case has records on both sides; the validator refuses a false record. The
    // scorer still must not be the place where such a case turns into a win.
    const broken: Case = {
      ...c,
      id: "archive-broken",
      evidence: [...c.evidence, { id: "e-false", kind: "record", authoritative: true, proves: ["a-ada-foyer-2100"], text: { en: "A second log.", zh: "另一份记录。" } }],
      briefing: { evidence: [...c.briefing.evidence, "e-false", "e-attendance-log"] },
    };
    const s = startSession(broken, "s1");
    expect(accuse(broken, s, { suspect: "s-ada", evidence: s.evidence }).verdict).toMatchObject({ outcome: "right-but-unproven", missing: [], open: [], accusedRuledOut: true });
  });

  it("ends the session", async () => {
    const { metered, provider } = setup();
    const over = accuse(c, full(), { suspect: "s-ada", evidence: ["e-attendance-log"] }).session;
    expect(await code(() => accuse(c, over, { suspect: "s-ada", evidence: over.evidence }))).toBe("over");
    expect(await code(() => inspect(c, over, "i-attendance-log"))).toBe("over");
    expect(await code(() => ask(metered, c, over, { suspect: "s-ada", topic: "t-ada-2100" }))).toBe("over");
    expect(provider.dispatched).toBe(0);
  });
});

describe("the reveal", () => {
  it("is refused until the session has ended", async () => {
    expect(await code(() => reveal(c, startSession(c, "s1")))).toBe("not-available");
  });

  it("gives the truth and which lies the player heard and caught", async () => {
    const { metered } = setup();
    let s = startSession(c, "s1");
    const unheard = reveal(c, accuse(c, s, { suspect: "s-ben", evidence: [] }).session);
    expect(unheard.lies).toEqual([{ suspect: "s-ada", assertion: "a-ada-foyer-2100", heard: false, caught: false }]);

    s = (await ask(metered, c, s, { suspect: "s-ada", topic: "t-ada-2100" })).session;
    expect(reveal(c, accuse(c, s, { suspect: "s-ada", evidence: [] }).session).lies[0]).toMatchObject({ heard: true, caught: false });

    s = inspect(c, s, "i-attendance-log").session;
    const truth = reveal(c, accuse(c, s, { suspect: "s-ada", evidence: s.evidence }).session);
    expect(truth.lies[0]).toMatchObject({ heard: true, caught: true });
    expect(truth).toMatchObject({ culprit: "s-ada", motive: "mo-debt" });
    expect(truth.timeline.find((t) => t.suspect === "s-ada")!.whereabouts).toEqual({ "20:40": "l-foyer", "21:00": "l-archive", "21:20": "l-foyer" });
  });
});
