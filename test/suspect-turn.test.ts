import { describe, expect, it } from "vitest";
import { guardLine } from "../src/agents/line-guard";
import { deflection, DEFLECTIONS, MAX_TURN_REQUESTS, suspectTurn, type SuspectTurnArgs } from "../src/agents/suspect-turn";
import { startingHeld } from "../src/case/access";
import { archivePass } from "../src/case/fixtures/archive";
import type { Case } from "../src/case/schema";
import { createMetered, type TraceEvent } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore, type SpendStore } from "../src/spend/store";

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

function setup(replies: (ProviderResponse | Error)[], options: { killSwitch?: () => boolean; store?: SpendStore } = {}) {
  const provider = new FakeProvider((_request, index) => {
    const reply = replies[Math.min(index, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const trace: TraceEvent[] = [];
  const metered = createMetered({
    inputBound: { tokensPerByte: 100 },
    provider,
    store: options.store ?? new MemorySpendStore(),
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
    // The retry has the same shape as the answer request: the note rides inside the tool result.
    expect(retry.messages.map((m) => m.role)).toEqual(provider.requests[1]!.messages.map((m) => m.role));
    expect(retry.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call_1" });
    const result = JSON.parse(retry.messages.at(-1)!.content) as { topic: string; statements: { id: string }[]; note: string };
    expect(result.topic).toBe("t-ada-2100");
    expect(result.statements.map((s) => s.id)).toEqual(["a-ada-foyer-2100"]);
    expect(result.note).toContain("[Note from the game, not from the detective]");
    expect(result.note).toContain("exclusive: Alone");
    // The first answer request carries no note.
    expect(provider.requests[1]!.messages.at(-1)!.content).not.toContain("note");
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

describe("a suspect turn: when there is nothing to state", () => {
  it("gives a fixed line and does not ask the model for one", async () => {
    const { ask, provider } = setup([recall("none"), answer([], "I signed for a parcel.")]);
    const turn = await ask({ question: "Who killed Mr. Shen?" });
    expect(turn).toMatchObject({ topic: null, statements: [], source: "deflection", requests: 1, costNano: PRICE });
    expect(DEFLECTIONS.en).toContain(turn.line);
    expect(turn.problem).toBeUndefined();
    // One request: the topic. No answer request follows.
    expect(provider.dispatched).toBe(1);

    const zh = setup([recall("none")]);
    const zhTurn = await zh.ask({ question: "是谁杀了沈先生？" });
    expect(DEFLECTIONS.zh).toContain(zhTurn.line);
    expect(zhTurn.language).toBe("zh");
  });

  it("treats a topic that is not on this suspect's menu as no topic", async () => {
    for (const topic of ["t-ben-2100", "t-made-up"]) {
      const { ask, provider } = setup([recall(topic), answer([], "I can't help you there.")]);
      expect(await ask(), topic).toMatchObject({ topic: null, statements: [], source: "deflection", requests: 1 });
      expect(provider.dispatched, topic).toBe(1);
    }
  });

  it("treats a locked topic exactly like one that does not exist, until it is unlocked", async () => {
    const gated: Case = { ...c, actions: { ...c.actions, topics: c.actions.topics.map((t) => (t.id === "t-ada-2100" ? { ...t, requires: ["e-attendance-log"] } : t)) } };
    const locked = setup([recall("t-ada-2100"), answer([], "I can't help you there.")]);
    expect(await locked.ask({ c: gated })).toMatchObject({ topic: null, statements: [], source: "deflection", requests: 1 });
    expect(locked.provider.bodies.join("\n")).not.toContain("a-ada-foyer-2100");

    const open = setup([recall("t-ada-2100"), answer(["a-ada-foyer-2100"], GOOD)]);
    expect(await open.ask({ c: gated, held: new Set([...startingHeld(gated), "e-attendance-log"]) })).toMatchObject({ topic: "t-ada-2100", source: "model" });
  });

  it("never shows text the model sent instead of calling recall, however harmless it looks", async () => {
    for (const line of ["I have nothing to say to you.", "I signed for a parcel.", "I was in the foyer at 21:00."]) {
      const { ask, provider } = setup([text(line)]);
      const turn = await ask();
      expect(turn, line).toMatchObject({ topic: null, statements: [], source: "deflection", requests: 1 });
      expect(turn.rejections, line).toEqual([{ from: "recall", reason: "no-recall", detail: "" }]);
      expect(JSON.stringify(turn), line).not.toContain(line);
      expect(provider.dispatched, line).toBe(1);
    }
  });

  it("never shows text that came with a call to some other tool", async () => {
    const other: ProviderResponse = { text: "Internal draft.", toolCalls: [{ id: "x", name: "other_tool", arguments: "{}" }], usage, finishReason: "tool_calls" };
    const { ask, provider } = setup([other]);
    const turn = await ask();
    expect(turn).toMatchObject({ topic: null, statements: [], source: "deflection", requests: 1 });
    expect(turn.rejections).toEqual([{ from: "recall", reason: "no-recall", detail: "other_tool" }]);
    expect(JSON.stringify(turn)).not.toContain("Internal draft");
    expect(provider.dispatched).toBe(1);
  });

  it("falls back when the topic request is cut off", async () => {
    const { ask } = setup([cutOff()]);
    const turn = await ask();
    expect(turn).toMatchObject({ statements: [], source: "deflection", requests: 1 });
    expect(turn.rejections).toEqual([{ from: "recall", reason: "truncated", detail: "" }]);
  });

  it("picks the fixed line from the turn id alone, so a turn always gets the same one", () => {
    expect(deflection("en", "s1:1")).toBe(deflection("en", "s1:1"));
    expect(DEFLECTIONS.en.indexOf(deflection("en", "s1:1"))).toBe(DEFLECTIONS.zh.indexOf(deflection("zh", "s1:1")));
    const seen = new Set(["s1:1", "s1:2", "s1:3", "s1:4", "s1:5", "s1:6"].map((id) => deflection("en", id)));
    expect(seen.size).toBe(DEFLECTIONS.en.length);
    // Every fixed line passes the guard as a line that states nothing.
    for (const lang of ["en", "zh"] as const) for (const line of DEFLECTIONS[lang]) expect(guardLine(c, "s-ada", [], line, lang), line).toEqual({ ok: true });
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
    const turn = await ask();
    expect(turn).toMatchObject({ statements: [], source: "deflection", requests: 0, problem: "refused:kill-switch" });
    expect(DEFLECTIONS.en).toContain(turn.line);
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

describe("a suspect turn: when a reply comes back but its cost is not confirmed", () => {
  /** A store whose first settlement fails after the reply has arrived. */
  const pendingFirst = () => {
    const store = new MemorySpendStore();
    const settle = store.settle.bind(store);
    let first = true;
    store.settle = async (settleArgs) => {
      if (first) {
        first = false;
        throw new Error("settlement acknowledgement unavailable");
      }
      return settle(settleArgs);
    };
    return store;
  };

  it("an unsettled topic request ends the turn: no answer is asked for, and no cost is reported as confirmed", async () => {
    const { ask, provider } = setup([recall("t-ada-2100"), answer(["a-ada-foyer-2100"], GOOD)], { store: pendingFirst() });
    const turn = await ask();
    expect(turn).toMatchObject({ topic: "t-ada-2100", line: RENDERED_EN, source: "rendered", requests: 1, costNano: 0, problem: "unconfirmed:not-settled" });
    expect(turn.statements.map((s) => s.assertion)).toEqual(["a-ada-foyer-2100"]);
    expect(provider.dispatched).toBe(1);
  });

  it("an unsettled answer may still be shown, but it is not retried", async () => {
    const good = setup([answer(["a-ada-foyer-2100"], GOOD)], { store: pendingFirst() });
    expect(await good.ask({ topic: "t-ada-2100" })).toMatchObject({ line: GOOD, source: "model", requests: 1, costNano: 0, problem: "unconfirmed:not-settled" });

    const bad = setup([answer(["a-ada-foyer-2100"], "I was in the foyer at 21:00 with Ben."), answer(["a-ada-foyer-2100"], GOOD)], { store: pendingFirst() });
    const turn = await bad.ask({ topic: "t-ada-2100" });
    expect(turn).toMatchObject({ line: RENDERED_EN, source: "rendered", requests: 1, problem: "unconfirmed:not-settled" });
    expect(bad.provider.dispatched).toBe(1);
  });

  it("a reply that suspends the envelope ends the turn", async () => {
    // The reply bills more output than the request's limit allows: the guard suspends the envelope.
    const overLimit: ProviderResponse = { ...recall("t-ada-2100"), usage: { inputTokens: 1_000, cachedTokens: 0, outputTokens: 5_000 } };
    const { ask, provider } = setup([overLimit, answer(["a-ada-foyer-2100"], GOOD)]);
    const turn = await ask();
    expect(turn).toMatchObject({ line: RENDERED_EN, source: "rendered", requests: 1, costNano: 0, problem: "unconfirmed:envelope-suspended" });
    expect(provider.dispatched).toBe(1);
  });
});
