import { describe, expect, it } from "vitest";
import { DEFLECTION, MAX_TURN_REQUESTS, suspectTurn, type SuspectTurnArgs } from "../src/agents/suspect-turn";
import { startingHeld } from "../src/case/access";
import { archivePass } from "../src/case/fixtures/archive";
import type { Case } from "../src/case/schema";
import { createMetered, type TraceEvent } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore } from "../src/spend/store";

const c = archivePass;
const usage = { inputTokens: 1_000, cachedTokens: 0, outputTokens: 60 };
const PRICE = 1_000 * 100 + 60 * 500;
const EN = "Where were you at 21:00?";
const ZH = "21:00 你在哪里？";

const recall = (topic: string, text: string | null = null): ProviderResponse => ({
  text,
  toolCalls: [{ id: "call_1", name: "recall", arguments: JSON.stringify({ topic }) }],
  usage,
  finishReason: "tool_calls",
});
const answer = (assertions: string[], line: string): ProviderResponse => ({ text: JSON.stringify({ assertions, line, language: "en" }), toolCalls: [], usage, finishReason: "stop" });
const text = (line: string): ProviderResponse => ({ text: line, toolCalls: [], usage, finishReason: "stop" });
const cutOff = (): ProviderResponse => ({ text: null, toolCalls: [], usage, finishReason: "length" });

function setup(replies: (ProviderResponse | Error)[], options: { killSwitch?: () => boolean } = {}) {
  const provider = new FakeProvider((_request, index) => {
    const reply = replies[Math.min(index, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const trace: TraceEvent[] = [];
  const metered = createMetered({
    inputBound: { tokensPerByte: 100 },
    provider,
    store: new MemorySpendStore(),
    envelope: "e",
    limitNano: usdToNano(1),
    trace: (e) => trace.push(e),
    ...(options.killSwitch ? { killSwitch: options.killSwitch } : {}),
  });
  const ask = (over: Partial<SuspectTurnArgs> = {}) => suspectTurn({ metered, c, suspect: "s-ada", held: startingHeld(c), question: EN, turnId: "s1:1", ...over });
  return { provider, trace, ask };
}

const RENDERED_EN = "I was in the foyer at 21:00.";
const RENDERED_ZH = "21:00 我在门厅。";
const GOOD = "At 21:00 I was in the foyer. Please note the exact time.";

describe("a suspect turn: the model's line is shown when it passes", () => {
  it("asks for the topic, then the answer, and shows the model's own line", async () => {
    const { ask, provider, trace } = setup([recall("t-ada-2100", "Let me think back to that evening."), answer(["a-ada-foyer-2100"], GOOD)]);
    const turn = await ask();
    expect(turn).toMatchObject({ suspect: "s-ada", topic: "t-ada-2100", topicGiven: false, language: "en", line: GOOD, source: "model", rejections: [], requests: 2, costNano: 2 * PRICE });
    expect(turn.statements).toEqual([{ assertion: "a-ada-foyer-2100", en: RENDERED_EN, zh: RENDERED_ZH }]);
    expect(turn.problem).toBeUndefined();
    expect(provider.dispatched).toBe(2);
    expect(trace.map((t) => [t.attemptId, t.step, t.promptId])).toEqual([
      ["s1:1:recall", "suspect.recall", "suspect-v2"],
      ["s1:1:answer", "suspect.answer", "suspect-v2"],
    ]);
  });

  it("never shows the text the model sent along with its tool call", async () => {
    const { ask } = setup([recall("t-ada-2100", "SECRET THOUGHT"), answer(["a-ada-foyer-2100"], GOOD)]);
    expect(JSON.stringify(await ask())).not.toContain("SECRET THOUGHT");
  });

  it("gives the model only the public briefing, its own voice and what recall returned", async () => {
    const { ask, provider } = setup([recall("t-ada-2100"), answer(["a-ada-foyer-2100"], GOOD)]);
    await ask();
    const last = provider.requests[1]!;
    expect(last.messages.map((m) => m.role)).toEqual(["system", "system", "user", "assistant", "tool"]);
    expect(last.messages[4]!.content).toBe(JSON.stringify({ topic: "t-ada-2100", statements: [{ id: "a-ada-foyer-2100", en: RENDERED_EN, zh: RENDERED_ZH }] }));
    expect(last.tools).toBeUndefined();
    for (const body of provider.bodies) {
      expect(body).not.toContain("a-ada-archive-2100");
      expect(body).not.toContain("e-attendance-log");
      expect(body).not.toContain("door log");
      expect(body).not.toContain("culprit");
      expect(body).not.toContain("whereabouts");
    }
  });

  it("answers in the language of the question", async () => {
    const { ask } = setup([recall("t-ada-2100"), answer(["a-ada-foyer-2100"], "21:00 我在门厅。别催我。")]);
    expect(await ask({ question: ZH })).toMatchObject({ language: "zh", line: "21:00 我在门厅。别催我。", source: "model" });
  });

  it("passes the cache label through to every request", async () => {
    const { ask, provider } = setup([recall("t-ada-2100"), answer(["a-ada-foyer-2100"], GOOD)]);
    await ask({ cacheKey: "case:archive-pass" });
    expect(provider.requests.map((r) => r.cacheKey)).toEqual(["case:archive-pass", "case:archive-pass"]);
  });
});

describe("a suspect turn: a line that fails is retried once, then replaced", () => {
  it("retries once and shows the second line when it passes", async () => {
    const { ask, provider } = setup([recall("t-ada-2100"), answer(["a-ada-foyer-2100"], "I was in the foyer at 21:00. Alone."), answer(["a-ada-foyer-2100"], GOOD)]);
    const turn = await ask();
    expect(turn).toMatchObject({ line: GOOD, source: "model-retry", requests: 3, costNano: 3 * PRICE });
    expect(turn.rejections).toEqual([{ from: "answer", reason: "exclusive", detail: "Alone" }]);
    const retry = provider.requests[2]!;
    expect(retry.messages.at(-1)).toMatchObject({ role: "user" });
    expect(retry.messages.at(-1)!.content).toContain("[Note from the game, not from the detective]");
    expect(retry.messages.at(-1)!.content).toContain("exclusive: Alone");
    // The refused line itself is not sent back.
    expect(provider.bodies[2]).not.toContain("I was in the foyer at 21:00. Alone.");
  });

  it("writes the retry note in Chinese for a Chinese question", async () => {
    const { ask, provider } = setup([recall("t-ada-2100"), answer(["a-ada-foyer-2100"], "我九点在门厅。就我一个。"), answer(["a-ada-foyer-2100"], RENDERED_ZH)]);
    expect(await ask({ question: ZH })).toMatchObject({ source: "model-retry", language: "zh" });
    expect(provider.requests[2]!.messages.at(-1)!.content).toContain("[游戏提示，不是侦探说的话]");
  });

  it("after two refused lines shows the code-rendered sentence, in the player's language", async () => {
    const bad = answer(["a-ada-foyer-2100"], "I was in the foyer at 21:00 with Ben.");
    const { ask, provider } = setup([recall("t-ada-2100"), bad, bad]);
    const turn = await ask();
    expect(turn).toMatchObject({ line: RENDERED_EN, source: "rendered", requests: MAX_TURN_REQUESTS });
    expect(turn.rejections.map((r) => [r.from, r.reason, r.detail])).toEqual([
      ["answer", "uncovered", "ben"],
      ["retry", "uncovered", "ben"],
    ]);
    expect(provider.dispatched).toBe(3);

    const zh = setup([recall("t-ada-2100"), bad, bad]);
    expect(await zh.ask({ question: ZH })).toMatchObject({ line: RENDERED_ZH, source: "rendered", language: "zh" });
  });

  it("refuses a reply that claims a statement recall did not return", async () => {
    const { ask } = setup([recall("t-ada-2100"), answer(["a-ada-foyer-2100", "a-ada-archive-2100"], GOOD), answer(["a-ada-foyer-2100"], GOOD)]);
    const turn = await ask();
    expect(turn.rejections).toEqual([{ from: "answer", reason: "unknown-claim", detail: "a-ada-archive-2100" }]);
    expect(turn.source).toBe("model-retry");
  });

  it("refuses a reply that is not the object asked for", async () => {
    for (const broken of ["not json", "[]", '{"assertions":"a","line":"x"}', '{"assertions":[]}']) {
      const { ask } = setup([recall("t-ada-2100"), text(broken), text(broken)]);
      const turn = await ask();
      expect(turn.rejections.map((r) => r.reason), broken).toEqual(["malformed", "malformed"]);
      expect(turn).toMatchObject({ line: RENDERED_EN, source: "rendered" });
    }
  });

  it("does not retry a reply that was cut off at the output limit", async () => {
    const { ask, provider } = setup([recall("t-ada-2100"), cutOff(), answer(["a-ada-foyer-2100"], GOOD)]);
    const turn = await ask();
    expect(turn).toMatchObject({ line: RENDERED_EN, source: "rendered", requests: 2 });
    expect(turn.rejections).toEqual([{ from: "answer", reason: "truncated", detail: "" }]);
    expect(provider.dispatched).toBe(2);
  });

  it("keeps the turn's statements whatever the model wrote", async () => {
    const dodge = answer([], "I would rather not say.");
    const { ask } = setup([recall("t-ada-2100"), dodge, dodge]);
    const turn = await ask();
    // The topic was asked, so its statement is in the notebook, and the shown line says it.
    expect(turn.statements.map((s) => s.assertion)).toEqual(["a-ada-foyer-2100"]);
    expect(turn.rejections.map((r) => r.reason)).toEqual(["omits", "omits"]);
    expect(turn.line).toBe(RENDERED_EN);
  });
});

describe("a suspect turn: when no topic fits", () => {
  it("shows the model's deflection and records no statement", async () => {
    const { ask } = setup([recall("none"), answer([], "I don't know who did it. Stop rushing me.")]);
    expect(await ask({ question: "Who killed Mr. Shen?" })).toMatchObject({ topic: null, statements: [], line: "I don't know who did it. Stop rushing me.", source: "model", requests: 2 });
  });

  it("replaces a deflection that names anyone or anything with a fixed line", async () => {
    const blame = answer([], "Ask Ben. He was in the foyer.");
    const { ask } = setup([recall("none"), blame, blame]);
    const turn = await ask({ question: "Who killed Mr. Shen?" });
    expect(turn).toMatchObject({ statements: [], line: DEFLECTION.en, source: "deflection", requests: 3 });
    const zh = setup([recall("none"), blame, blame]);
    expect(await zh.ask({ question: "是谁杀了沈先生？" })).toMatchObject({ line: DEFLECTION.zh, source: "deflection" });
  });

  it("treats a topic that is not on this suspect's menu as no topic", async () => {
    for (const topic of ["t-ben-2100", "t-made-up"]) {
      const { ask, provider } = setup([recall(topic), answer([], "I can't help you there.")]);
      expect(await ask(), topic).toMatchObject({ topic: null, statements: [], source: "model" });
      expect(provider.requests[1]!.messages.at(-1)!.content, topic).toBe('{"topic":"none","statements":[]}');
    }
  });

  it("treats a locked topic exactly like one that does not exist, until it is unlocked", async () => {
    const gated: Case = { ...c, actions: { ...c.actions, topics: c.actions.topics.map((t) => (t.id === "t-ada-2100" ? { ...t, requires: ["e-attendance-log"] } : t)) } };
    const locked = setup([recall("t-ada-2100"), answer([], "I can't help you there.")]);
    expect(await locked.ask({ c: gated })).toMatchObject({ topic: null, statements: [] });
    expect(locked.provider.bodies.join("\n")).not.toContain("a-ada-foyer-2100");

    const open = setup([recall("t-ada-2100"), answer(["a-ada-foyer-2100"], GOOD)]);
    expect(await open.ask({ c: gated, held: new Set([...startingHeld(gated), "e-attendance-log"]) })).toMatchObject({ topic: "t-ada-2100", source: "model" });
  });

  it("takes text sent instead of a tool call as a line that may state nothing", async () => {
    const plain = setup([text("I have nothing to say to you.")]);
    expect(await plain.ask()).toMatchObject({ topic: null, statements: [], line: "I have nothing to say to you.", source: "model", requests: 1 });

    // The model stated a fact without calling recall: the fact is not in the notebook and the line is not shown.
    const fact = setup([text("I was in the foyer at 21:00.")]);
    const turn = await fact.ask();
    expect(turn).toMatchObject({ statements: [], line: DEFLECTION.en, source: "deflection", requests: 1 });
    expect(turn.rejections).toEqual([{ from: "recall", reason: "uncovered", detail: "foyer, time 9:00" }]);
  });

  it("falls back when the topic request is cut off", async () => {
    const { ask } = setup([cutOff()]);
    const turn = await ask();
    expect(turn).toMatchObject({ statements: [], line: DEFLECTION.en, source: "deflection", requests: 1 });
    expect(turn.rejections).toEqual([{ from: "recall", reason: "truncated", detail: "" }]);
  });
});

describe("a suspect turn: a topic picked from the menu", () => {
  it("skips the topic request and still yields the topic's statements", async () => {
    const { ask, provider, trace } = setup([answer(["a-ada-foyer-2100"], GOOD)]);
    const turn = await ask({ topic: "t-ada-2100" });
    expect(turn).toMatchObject({ topic: "t-ada-2100", topicGiven: true, line: GOOD, source: "model", requests: 1, costNano: PRICE });
    expect(turn.statements.map((s) => s.assertion)).toEqual(["a-ada-foyer-2100"]);
    expect(trace.map((t) => t.attemptId)).toEqual(["s1:1:answer"]);
    const sent = provider.requests[0]!;
    expect(sent.messages[3]).toMatchObject({ role: "assistant", toolCalls: [{ id: "call_topic", name: "recall", arguments: '{"topic":"t-ada-2100"}' }] });
    expect(sent.messages[4]).toMatchObject({ role: "tool", toolCallId: "call_topic" });
  });

  it("still allows only one retry", async () => {
    const bad = answer(["a-ada-foyer-2100"], "I was in the foyer at 21:00 with Ben.");
    const { ask, provider } = setup([bad, bad, answer(["a-ada-foyer-2100"], GOOD)]);
    const turn = await ask({ topic: "t-ada-2100" });
    expect(turn).toMatchObject({ line: RENDERED_EN, source: "rendered", requests: 2 });
    expect(turn.problem).toBeUndefined();
    expect(provider.dispatched).toBe(2);
  });

  it("refuses a topic that is not open for that suspect", async () => {
    const { ask, provider } = setup([answer([], "x")]);
    await expect(ask({ topic: "t-ben-2100" })).rejects.toThrow("not open");
    await expect(ask({ topic: "none" })).rejects.toThrow("not open");
    await expect(ask({ suspect: "s-nobody" })).rejects.toThrow("no such suspect");
    expect(provider.dispatched).toBe(0);
  });
});

describe("a suspect turn: when a request is refused or fails", () => {
  it("with a known topic, sends nothing and still gives the statement, worded by code", async () => {
    const { ask, provider } = setup([answer(["a-ada-foyer-2100"], GOOD)], { killSwitch: () => true });
    const turn = await ask({ topic: "t-ada-2100" });
    expect(turn).toMatchObject({ line: RENDERED_EN, source: "rendered", requests: 0, costNano: 0, problem: "refused:kill-switch" });
    expect(turn.statements.map((s) => s.assertion)).toEqual(["a-ada-foyer-2100"]);
    expect(provider.dispatched).toBe(0);
  });

  it("with no topic yet, gives the fixed line and no statement", async () => {
    const { ask, provider } = setup([recall("t-ada-2100")], { killSwitch: () => true });
    expect(await ask()).toMatchObject({ statements: [], line: DEFLECTION.en, source: "deflection", requests: 0, problem: "refused:kill-switch" });
    expect(provider.dispatched).toBe(0);
  });

  it("after a failed answer request, sends no more and words the statement by code", async () => {
    const { ask, provider } = setup([recall("t-ada-2100"), new Error("socket closed"), answer(["a-ada-foyer-2100"], GOOD)]);
    const turn = await ask();
    expect(turn).toMatchObject({ line: RENDERED_EN, source: "rendered", requests: 2, costNano: PRICE, problem: "failed:outcome-unknown" });
    expect(turn.statements.map((s) => s.assertion)).toEqual(["a-ada-foyer-2100"]);
    expect(provider.dispatched).toBe(2);
  });

  it("a turn delivered twice is not sent twice", async () => {
    const { ask, provider } = setup([answer(["a-ada-foyer-2100"], GOOD)]);
    await ask({ topic: "t-ada-2100" });
    const again = await ask({ topic: "t-ada-2100" });
    expect(provider.dispatched).toBe(1);
    expect(again).toMatchObject({ source: "rendered", requests: 0, problem: "refused:duplicate-attempt" });
    expect(again.statements.map((s) => s.assertion)).toEqual(["a-ada-foyer-2100"]);
  });
});
