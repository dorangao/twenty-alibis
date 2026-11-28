import { describe, expect, it } from "vitest";
import { GOSSIP_OUTPUT_TOKENS, GOSSIP_PROMPT_ID, gossipMessages } from "../src/agents/gossip-turn";
import { archivePass } from "../src/case/fixtures/archive";
import { isOpen } from "../src/case/access";
import type { Case } from "../src/case/schema";
import { solve } from "../src/case/solver";
import { validateCase } from "../src/case/validate";
import { GOSSIP_CANDIDATES, GOSSIP_EVERY, GOSSIP_ROUNDS, GOSSIP_SPEAKERS, GOSSIP_WAVE, hearsayId, planRound, type GossipRound } from "../src/game/gossip";
import { accuse, ask, gossipDue, gossipRound, heldBy, inspect, notebook, reveal, SessionError, startSession, topicMenu, type Session } from "../src/game/session";
import { createGame, noModel } from "../src/game/terminal";
import { createMetered, type Metered } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderRequest, ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore } from "../src/spend/store";
import { compilePlot } from "../src/writer/compile";
import { lighthousePeople, lighthouseSkeleton } from "../src/writer/fixtures/lighthouse";

/** Twenty people, one topic each. s-02's statement opens the scene's record (i-01); s-03 is the culprit and the one liar. */
const c: Case = (() => {
  const result = compilePlot("lighthouse", lighthouseSkeleton, lighthousePeople);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.case;
})();
const WITNESS = "s-02";
const LIAR = "s-03";
const idx = (id: string): number => c.suspects.findIndex((s) => s.id === id);
const name = (id: string) => c.suspects.find((s) => s.id === id)!.name;

/** A model that must never be reached. */
const never: Metered = async () => {
  throw new Error("a request was made");
};

const usage = { inputTokens: 600, cachedTokens: 0, outputTokens: 40 };
const PRICE = 600 * 100 + 40 * 500;
const letter = (to: string): ProviderResponse => ({ text: JSON.stringify({ to }), toolCalls: [], usage, finishReason: "stop" });
/** The envelope is large: four requests in flight each hold a full worst case, and these tests are not about running out. */
function fake(handler: (request: ProviderRequest, index: number) => ProviderResponse | Promise<ProviderResponse>, options: { killSwitch?: () => boolean } = {}) {
  const provider = new FakeProvider(handler);
  const metered = createMetered({ inputBound: { tokensPerByte: 100 }, provider, store: new MemorySpendStore(), envelope: "e", limitNano: usdToNano(100), ...(options.killSwitch ? { killSwitch: options.killSwitch } : {}) });
  return { provider, metered };
}

/** Use `count` actions that send nothing: inspections first (unless `topicsOnly`), then topics, none of them the witness's or the liar's. */
async function spend(session: Session, count: number, topicsOnly = false): Promise<Session> {
  let s = session;
  for (let used = 0; used < count; used++) {
    const open = topicsOnly ? undefined : c.actions.inspections.find((i) => isOpen(i, heldBy(s)) && !s.inspections.includes(i.id) && i.id !== "i-01");
    if (open) s = inspect(c, s, open.id).session;
    else {
      const topic = c.actions.topics.find((t) => ![WITNESS, LIAR].includes(t.suspect) && !s.turns.some((r) => r.turn.topic === t.id))!;
      s = (await ask(noModel, c, s, { suspect: topic.suspect, topic: topic.id })).session;
    }
  }
  return s;
}
const round = (events: GossipRound["events"], n = 1): GossipRound => ({ n, at: GOSSIP_EVERY * n, events, chosenBy: "code", speakers: events.length, calls: 0, requests: 0, costNano: 0 });
const code = (s: Session) => gossipRound(never, c, s, { model: false });
const errorCode = async (run: () => unknown): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof SessionError) return error.code;
    throw error;
  }
  return "no error";
};

describe("when a gossip round is due", () => {
  it("never is, in a session started without gossip", async () => {
    let s = startSession(c, "plain");
    expect(s.gossip).toBeUndefined();
    s = await spend(s, 9);
    expect(gossipDue(c, s)).toBe(false);
    expect(await errorCode(() => code(s))).toBe("not-available");
    // And such a session's menus hold only the case's own topics.
    expect(c.suspects.flatMap((p) => topicMenu(c, s, p.id)).every((t) => t.gossip === undefined)).toBe(true);
  });

  it("is after every fourth action, and holds a new question or inspection until it has run", async () => {
    let s = await spend(startSession(c, "g", { gossip: true }), GOSSIP_EVERY - 1, true);
    expect(gossipDue(c, s)).toBe(false);
    s = await spend(s, 1, true);
    expect(gossipDue(c, s)).toBe(true);

    const fresh = c.actions.topics.find((t) => t.suspect === "s-20")!;
    expect(await errorCode(() => ask(never, c, s, { suspect: fresh.suspect, topic: fresh.id }))).toBe("gossip-due");
    expect(await errorCode(() => ask(never, c, s, { suspect: fresh.suspect, question: "Where were you?" }))).toBe("gossip-due");
    expect(await errorCode(() => inspect(c, s, "i-05"))).toBe("gossip-due");
    // What is already in the notebook can still be looked at again, for nothing.
    const saved = s.turns[0]!.turn;
    expect(await ask(never, c, s, { suspect: saved.suspect, topic: saved.topic! })).toMatchObject({ replayed: true, session: s });
    // And the game can still be ended.
    expect(accuse(c, s, { suspect: LIAR, evidence: [] }).verdict.outcome).toBe("right-but-unproven");

    const done = await code(s);
    expect(done.round).toMatchObject({ n: 1, at: GOSSIP_EVERY, chosenBy: "code", requests: 0, costNano: 0 });
    expect(gossipDue(c, done.session)).toBe(false);
    expect(inspect(c, done.session, "i-05").repeated).toBe(false);
    // The round does not use an action.
    expect(done.session.actions).toBe(s.actions);
  });

  it("has at most three rounds, none after the accusation, and none when no action is left", async () => {
    let s = startSession(c, "g", { gossip: true });
    for (let n = 1; n <= GOSSIP_ROUNDS; n++) {
      s = await spend(s, GOSSIP_EVERY);
      expect(gossipDue(c, s)).toBe(true);
      s = (await code(s)).session;
    }
    s = await spend(s, GOSSIP_EVERY);
    expect(gossipDue(c, s)).toBe(false);
    expect(s.gossip!.rounds.map((r) => r.n)).toEqual([1, 2, 3]);

    const accused = accuse(c, await spend(startSession(c, "g2", { gossip: true }), GOSSIP_EVERY), { suspect: LIAR, evidence: [] }).session;
    expect(gossipDue(c, accused)).toBe(false);
    expect(await errorCode(() => code(accused))).toBe("over");

    const small: Case = { ...c, sessionCap: GOSSIP_EVERY };
    const spent = { ...(await spend(startSession(c, "g3", { gossip: true }), GOSSIP_EVERY)), caseId: small.id };
    expect(gossipDue(small, spent)).toBe(false);
  });
});

describe("who speaks, what they pass on, and to whom", () => {
  const start = startSession(c, "g", { gossip: true });

  it("is fixed by the case and the session: eight speakers in order, one open topic of their own each, up to four others to choose from", () => {
    const plans = planRound(c, start.gossip!, heldBy(start), 1);
    expect(plans).toEqual(planRound(c, start.gossip!, heldBy(start), 1));
    expect(plans.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(plans).toHaveLength(GOSSIP_SPEAKERS);
    for (const plan of plans) {
      expect(c.actions.topics.find((t) => t.id === plan.topic)!.suspect).toBe(plan.speaker);
      expect(plan.candidates).toHaveLength(GOSSIP_CANDIDATES);
      expect(new Set(plan.candidates).size).toBe(GOSSIP_CANDIDATES);
      expect(plan.candidates).not.toContain(plan.speaker);
    }
    // The next round starts where this one stopped, so everyone gets a turn.
    expect(planRound(c, start.gossip!, heldBy(start), 2).map((p) => p.index)).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
    expect(planRound(c, start.gossip!, heldBy(start), 3).map((p) => p.index)).toEqual([16, 17, 18, 19, 0, 1, 2, 3]);
  });

  it("never offers someone who has already heard it from that speaker", () => {
    const first = planRound(c, start.gossip!, heldBy(start), 1)[0]!;
    const told = { rounds: [round(first.candidates.map((to) => ({ from: first.speaker, to, topic: first.topic })))] };
    const again = planRound(c, told, heldBy(start), 1).find((p) => p.speaker === first.speaker)!;
    for (const to of first.candidates) expect(again.candidates).not.toContain(to);
    // Once everyone has heard it, the speaker has nothing left to tell and is passed over.
    const all = { rounds: [round(c.suspects.filter((p) => p.id !== first.speaker).map((p) => ({ from: first.speaker, to: p.id, topic: first.topic })))] };
    expect(planRound(c, all, heldBy(start), 1).some((p) => p.speaker === first.speaker)).toBe(false);
  });

  it("never passes on a topic that is not open to the player", () => {
    // Ada's topic is locked behind the door log in this copy of the handwritten case.
    const locked: Case = { ...archivePass, actions: { ...archivePass.actions, topics: archivePass.actions.topics.map((t) => (t.suspect === archivePass.suspects[0]!.id ? { ...t, requires: [archivePass.actions.inspections[0]!.yields[0]!] } : t)) } };
    expect(validateCase(locked).ok).toBe(true);
    const ada = locked.suspects[0]!.id;
    const before = startSession(locked, "a", { gossip: true });
    expect(planRound(locked, before.gossip!, heldBy(before), 1).some((p) => p.speaker === ada)).toBe(false);
    const after = inspect(locked, before, locked.actions.inspections[0]!.id).session;
    expect(planRound(locked, after.gossip!, heldBy(after), 1).some((p) => p.speaker === ada)).toBe(true);
  });

  it("with the model off, tells the first candidate and sends nothing", async () => {
    const s = await spend(start, GOSSIP_EVERY);
    const plans = planRound(c, s.gossip!, heldBy(s), 1);
    const done = await code(s);
    expect(done.round.events).toEqual(plans.map((p) => ({ from: p.speaker, to: p.candidates[0], topic: p.topic })));
    expect(done.round).toMatchObject({ speakers: 8, calls: 0, requests: 0, costNano: 0 });
    expect(done.round.problem).toBeUndefined();
  });
});

describe("what a listener can then be asked", () => {
  const listener = "s-07";
  /** The witness told s-07; the liar told s-07 too. */
  const told = (id: string): Session => ({
    ...startSession(c, id, { gossip: true }),
    gossip: {
      rounds: [
        round([
          { from: WITNESS, to: listener, topic: "t-02" },
          { from: LIAR, to: listener, topic: "t-03" },
        ]),
      ],
    },
  });

  it("is on the listener's menu and nobody else's, after their own topics", () => {
    const s = told("h");
    expect(topicMenu(c, s, listener)).toEqual([
      { id: "t-07", label: c.actions.topics.find((t) => t.id === "t-07")!.label, heard: false },
      { id: hearsayId(1, idx(WITNESS)), label: { en: `What did ${name(WITNESS).en} tell you?`, zh: `${name(WITNESS).zh}跟你说了什么？` }, heard: false, gossip: 1 },
      { id: hearsayId(1, idx(LIAR)), label: { en: `What did ${name(LIAR).en} tell you?`, zh: `${name(LIAR).zh}跟你说了什么？` }, heard: false, gossip: 1 },
    ]);
    expect(topicMenu(c, s, "s-08")).toHaveLength(1);
  });

  it("costs one action, sends nothing, and gives the speaker's statement, attributed and worded by code", async () => {
    const s = told("h");
    const own = (await ask(noModel, c, startSession(c, "own"), { suspect: WITNESS, topic: "t-02" })).turn.statements[0]!;
    const result = await ask(never, c, s, { suspect: listener, topic: hearsayId(1, idx(WITNESS)), language: "zh" });
    expect(result).toMatchObject({ replayed: false, recorded: true });
    expect(result.session.actions).toBe(1);
    expect(result.turn).toMatchObject({ suspect: listener, topic: hearsayId(1, idx(WITNESS)), topicGiven: true, language: "zh", source: "rendered", requests: 0, costNano: 0 });
    expect(result.turn.statements).toEqual([{ assertion: "a-02-says", en: `${name(WITNESS).en} told me: “${own.en}”`, zh: `${name(WITNESS).zh}跟我说：“${own.zh}”`, source: WITNESS }]);
    expect(result.turn.line).toBe(result.turn.statements[0]!.zh);

    // Asked again, it is the saved turn: no action, and the other language on request.
    const again = await ask(never, c, result.session, { suspect: listener, topic: hearsayId(1, idx(WITNESS)), language: "en" });
    expect(again).toMatchObject({ replayed: true });
    expect(again.session).toBe(result.session);
    expect(again.turn.line).toBe(result.turn.statements[0]!.en);
    expect(topicMenu(c, result.session, listener).find((t) => t.id === hearsayId(1, idx(WITNESS)))!.heard).toBe(true);
  });

  it("gives the player the same statement ids as asking the speaker would, so it opens what they open", async () => {
    const s = told("h");
    expect(await errorCode(() => inspect(c, s, "i-01"))).toBe("not-available");
    const heard = (await ask(never, c, s, { suspect: listener, topic: hearsayId(1, idx(WITNESS)) })).session;
    expect(heldBy(heard).has("a-02-says")).toBe(true);
    expect(inspect(c, heard, "i-01").repeated).toBe(false);
  });

  it("waits like any new question while a later round is due", async () => {
    const s: Session = { ...(await spend(told("h"), GOSSIP_EVERY * 2)) };
    expect(gossipDue(c, s)).toBe(true);
    expect(await errorCode(() => ask(never, c, s, { suspect: listener, topic: hearsayId(1, idx(WITNESS)) }))).toBe("gossip-due");
    const after = (await code(s)).session;
    expect((await ask(never, c, after, { suspect: listener, topic: hearsayId(1, idx(WITNESS)) })).recorded).toBe(true);
  });

  it("is refused for anyone it was not told to, and for an event that never happened", async () => {
    const s = told("h");
    expect(await errorCode(() => ask(never, c, s, { suspect: "s-08", topic: hearsayId(1, idx(WITNESS)) }))).toBe("not-available");
    expect(await errorCode(() => ask(never, c, s, { suspect: listener, topic: hearsayId(2, idx(WITNESS)) }))).toBe("not-available");
    expect(await errorCode(() => ask(never, c, s, { suspect: listener, topic: hearsayId(1, idx("s-09")) }))).toBe("not-available");
    expect(await errorCode(() => ask(never, c, startSession(c, "plain"), { suspect: listener, topic: hearsayId(1, idx(WITNESS)) }))).toBe("not-available");
    for (const id of ["~g0-1", "~g1-", "~g1-01", "~g1-1x", "~g", "~g1-999999"]) expect(await errorCode(() => ask(never, c, s, { suspect: listener, topic: id })), id).toBe("not-available");
  });

  it("is still not evidence, but a record can contradict it, and the lie then counts as heard and caught", async () => {
    let s = told("h");
    s = (await ask(never, c, s, { suspect: listener, topic: hearsayId(1, idx(LIAR)) })).session;
    expect(notebook(c, s).statements).toEqual([expect.objectContaining({ suspect: listener, source: LIAR, assertion: "a-03-says" })]);
    expect(notebook(c, s).contradictions).toEqual([]);
    // The liar was never spoken to. The proof's own records are gathered; one of them places the liar elsewhere.
    s = (await ask(never, c, s, { suspect: listener, topic: hearsayId(1, idx(WITNESS)) })).session;
    for (const id of ["i-01", "i-02", "i-05", "i-04"]) s = inspect(c, s, id).session;
    const book = notebook(c, s);
    expect(book.contradictions).toEqual([expect.objectContaining({ suspect: listener, source: LIAR, assertion: "a-03-says" })]);
    // A statement cannot be cited, at first hand or second.
    expect(await errorCode(() => accuse(c, s, { suspect: LIAR, evidence: ["a-03-says"] }))).toBe("not-held");
    const done = accuse(c, s, { suspect: LIAR, evidence: book.evidence.map((e) => e.id) }).session;
    expect(done.verdict!.outcome).toBe("solved");
    expect(reveal(c, done).lies).toEqual([{ suspect: LIAR, assertion: "a-03-says", heard: true, caught: true }]);
  });
});

describe("gossip never takes a proof away", () => {
  it("the solver's own proof still solves the case with rounds running, whoever is told", async () => {
    for (const pick of [0, 1, 2, 3]) {
      let s = startSession(c, `p${pick}`, { gossip: true });
      const { metered } = fake((request) => letter((request.responseSchema!.schema as { properties: { to: { enum: string[] } } }).properties.to.enum[pick]!));
      const before = new Set<string>();
      for (const action of solve(c).proof!.actions) {
        if (gossipDue(c, s)) s = (await gossipRound(metered, c, s, { model: true })).session;
        s = action.type === "topic" ? (await ask(noModel, c, s, { suspect: c.actions.topics.find((t) => t.id === action.id)!.suspect, topic: action.id })).session : inspect(c, s, action.id).session;
        for (const id of heldBy(s)) before.add(id);
      }
      expect(s.gossip!.rounds).toHaveLength(1);
      expect(accuse(c, s, { suspect: c.culprit.suspect, evidence: s.evidence }).verdict.outcome).toBe("solved");
    }
  });

  it("every statement that hearsay can deliver was open to the player when the round ran", async () => {
    let s = await spend(startSession(c, "open", { gossip: true }), GOSSIP_EVERY);
    const held = heldBy(s);
    s = (await code(s)).session;
    for (const event of s.gossip!.rounds[0]!.events) {
      const topic = c.actions.topics.find((t) => t.id === event.topic)!;
      expect(topic.suspect).toBe(event.from);
      expect(isOpen(topic, held)).toBe(true);
    }
  });
});

describe("a round with the model on", () => {
  const due = () => spend(startSession(c, "m", { gossip: true }), GOSSIP_EVERY);
  const lettersOf = (request: ProviderRequest): string[] => (request.responseSchema!.schema as { properties: { to: { enum: string[] } } }).properties.to.enum;

  it("asks each speaker once, at minimal effort, for one letter, and tells whoever was picked", async () => {
    const s = await due();
    const plans = planRound(c, s.gossip!, heldBy(s), 1);
    const { provider, metered } = fake((request) => letter(lettersOf(request)[2]!));
    const trace: string[] = [];
    const watched: Metered = (request) => {
      trace.push(`${request.attemptId} ${request.step} ${request.promptId} ${request.reasoningEffort} ${request.maxOutputTokens} ${request.cacheKey}`);
      return metered(request);
    };
    const done = await gossipRound(watched, c, s, { model: true, cacheKey: "gossip:lighthouse" });
    expect(trace.sort()).toEqual(plans.map((p) => `m:g1:${p.index} gossip.tell ${GOSSIP_PROMPT_ID} minimal ${GOSSIP_OUTPUT_TOKENS} gossip:lighthouse`).sort());
    expect(provider.dispatched).toBe(8);
    expect(done.round).toMatchObject({ n: 1, chosenBy: "model", speakers: 8, calls: 8, requests: 8, costNano: 8 * PRICE });
    expect(done.round.events).toEqual(plans.map((p) => ({ from: p.speaker, to: p.candidates[2], topic: p.topic })));
    for (const request of provider.requests) {
      expect(lettersOf(request)).toEqual(["a", "b", "c", "d"]);
      expect(request.tools).toBeUndefined();
    }
  });

  it("shows the model the public case, the speaker's voice, its own claim and the candidates, and nothing of the hidden truth", async () => {
    const s = await due();
    const liar = planRound(c, s.gossip!, heldBy(s), 1).find((p) => p.speaker === LIAR)!;
    const text = gossipMessages(c, liar)
      .messages.map((m) => m.content)
      .join("\n");
    const claim = (await ask(noModel, c, startSession(c, "own"), { suspect: LIAR, topic: "t-03" })).turn.statements[0]!;
    expect(text).toContain(claim.en);
    expect(text).toContain(claim.zh);
    for (const id of liar.candidates) expect(text).toContain(name(id).en);
    // No motive, no means, no record the player has not been given, and no word of the liar's being a liar.
    for (const motive of c.motives) expect(text).not.toContain(motive.text.en);
    for (const means of c.means) expect(text).not.toContain(means.name.en);
    for (const e of c.evidence) if (!c.briefing.evidence.includes(e.id)) expect(text).not.toContain(e.text.en);
    expect(text).not.toMatch(/\blie\b|\blying\b|culprit|撒谎|凶手/i);
    // The case's ids stay out too: candidates are letters.
    for (const p of c.suspects) expect(text).not.toContain(p.id);
    expect(text).not.toContain("t-03");
  });

  it("keeps at most four requests in flight", async () => {
    const s = await due();
    let flying = 0;
    let most = 0;
    const { metered } = fake(async (request) => {
      flying++;
      most = Math.max(most, flying);
      await new Promise((resolve) => setTimeout(resolve, 5));
      flying--;
      return letter(lettersOf(request)[0]!);
    });
    const done = await gossipRound(metered, c, s, { model: true });
    expect(done.round.requests).toBe(8);
    expect(most).toBe(GOSSIP_WAVE);
  });

  it("makes no event of a reply that is not exactly one of the letters, or that was cut off, and keeps its cost", async () => {
    const s = await due();
    const plans = planRound(c, s.gossip!, heldBy(s), 1);
    const bad: ProviderResponse[] = [
      letter("e"),
      letter("A"),
      { ...letter("a"), text: '{"to":"a","also":"b"}' },
      { ...letter("a"), text: '["a"]' },
      { ...letter("a"), text: "a" },
      { ...letter("a"), text: null },
      { ...letter("a"), finishReason: "length" },
    ];
    const { metered } = fake((request, index) => (index < bad.length ? bad[index]! : letter(lettersOf(request)[1]!)));
    const done = await gossipRound(metered, c, s, { model: true });
    expect(done.round).toMatchObject({ speakers: 8, calls: 8, requests: 8, costNano: 8 * PRICE });
    expect(done.round.problem).toBeUndefined();
    expect(done.round.events).toHaveLength(1);
    const kept = done.round.events[0]!;
    expect(kept.to).toBe(plans.find((p) => p.speaker === kept.from)!.candidates[1]);
  });

  it("does not act on a reply whose cost was not confirmed, and sends no further wave", async () => {
    const s = await due();
    const { metered } = fake((request) => letter(lettersOf(request)[0]!));
    let n = 0;
    // The second reply comes back with its settlement unconfirmed.
    const shaky: Metered = async (request) => {
      const mine = ++n;
      const result = await metered(request);
      return mine === 2 && result.ok ? { ...result, settled: false } : result;
    };
    const done = await gossipRound(shaky, c, s, { model: true });
    expect(n).toBe(GOSSIP_WAVE);
    expect(done.round).toMatchObject({ requests: GOSSIP_WAVE, costNano: (GOSSIP_WAVE - 1) * PRICE, problem: "unconfirmed:not-settled" });
    expect(done.round.events).toHaveLength(GOSSIP_WAVE - 1);
  });

  it("does not act on a reply that suspended the envelope", async () => {
    const s = await due();
    const { metered } = fake((request) => letter(lettersOf(request)[0]!));
    let n = 0;
    const breaching: Metered = async (request) => {
      const mine = ++n;
      const result = await metered(request);
      return mine === 1 && result.ok ? { ...result, breached: true } : result;
    };
    const done = await gossipRound(breaching, c, s, { model: true });
    expect(n).toBe(GOSSIP_WAVE);
    expect(done.round).toMatchObject({ requests: GOSSIP_WAVE, problem: "envelope-suspended" });
    expect(done.round.events).toHaveLength(GOSSIP_WAVE - 1);
    expect(done.round.events.map((e) => e.from)).not.toContain(planRound(c, s.gossip!, heldBy(s), 1)[0]!.speaker);
  });

  it("sends no further wave after a refusal, and tells nobody the model was to pick for", async () => {
    const s = await due();
    let sent = 0;
    // The switch is thrown once two requests have been handed to the guard.
    const { provider, metered } = fake((request) => letter(lettersOf(request)[0]!), { killSwitch: () => sent > 2 });
    const counting: Metered = (request) => {
      sent++;
      return metered(request);
    };
    const done = await gossipRound(counting, c, s, { model: true });
    // The first wave of four went to the guard; nothing of the second did.
    expect(sent).toBe(GOSSIP_WAVE);
    expect(provider.dispatched).toBe(done.round.requests);
    expect(done.round.requests).toBeLessThan(GOSSIP_WAVE);
    expect(done.round.problem).toBe("refused:kill-switch");
    expect(done.round.events).toHaveLength(done.round.requests);
    expect(done.round).toMatchObject({ speakers: 8, calls: 8, chosenBy: "model" });
    // The round is closed all the same: the game goes on.
    expect(gossipDue(c, done.session)).toBe(false);
  });

  it("does not ask the model when there is only one person left to tell", async () => {
    // Everyone but s-20 has heard the first speaker's statement already.
    const s = await due();
    const first = planRound(c, s.gossip!, heldBy(s), 1)[0]!;
    const most = c.suspects.filter((p) => p.id !== first.speaker && p.id !== "s-20").map((p) => ({ from: first.speaker, to: p.id, topic: first.topic }));
    // The third round comes back round to the first speaker.
    const withHistory: Session = { ...s, gossip: { rounds: [round(most, 1), round([], 2)] }, actions: GOSSIP_EVERY * 3 };
    const { provider, metered } = fake((request) => letter(lettersOf(request)[0]!));
    const done = await gossipRound(metered, c, withHistory, { model: true });
    const plans = planRound(c, withHistory.gossip!, heldBy(withHistory), 3);
    const single = plans.filter((p) => p.candidates.length === 1);
    expect(single.map((p) => p.speaker)).toContain(first.speaker);
    expect(done.round.calls).toBe(plans.length - single.length);
    expect(provider.dispatched).toBe(done.round.calls);
    expect(done.round.events).toContainEqual({ from: first.speaker, to: "s-20", topic: first.topic });
  });
});

describe("gossip in the terminal game", () => {
  it("runs a round by itself when one is due and says who spoke with whom, not what was said", async () => {
    const game = createGame(c, never, "t", { modelOff: true, gossip: true });
    const out: string[] = [];
    for (const command of ["inspect 1", "inspect 2", "inspect 3"]) out.push(...(await game.handle(command)));
    expect(out.join("\n")).not.toContain("talked among themselves");
    const fourth = await game.handle("inspect 4");
    const text = fourth.join("\n");
    expect(text).toContain("While you were busy, the people in the house talked among themselves.");
    expect(text).toContain("Code chose who was told; nothing was sent.");
    const first = game.session().gossip!.rounds[0]!.events[0]!;
    expect(text).toContain(`${name(first.from).en} spoke with ${name(first.to).en}`);
    // The statement itself is not given away: it has to be asked for.
    const claim = (await ask(noModel, c, startSession(c, "own"), { suspect: first.from, topic: first.topic })).turn.statements[0]!.en;
    expect(text).not.toContain(claim);

    const menu = (await game.handle(`topics ${idx(first.to) + 1}`)).join("\n");
    expect(menu).toContain(`What did ${name(first.from).en} tell you?  (new, from gossip)`);
    const said = (await game.handle(`ask ${idx(first.to) + 1} 2`)).join("\n");
    expect(said).toContain(`${name(first.from).en} told me: “${claim}”`);
    expect((await game.handle("talk")).join("\n")).toContain(`Round 1, after 4 actions:`);
  });

  it("has no rounds unless asked for", async () => {
    const game = createGame(c, never, "t", { modelOff: true });
    for (const command of ["inspect 1", "inspect 2", "inspect 3", "inspect 4", "inspect 1"]) await game.handle(command);
    expect(game.session().gossip).toBeUndefined();
    expect((await game.handle("talk")).join("\n")).toBe("This game has no gossip rounds.");
  });
});

describe("a case's own topics", () => {
  it("may not use the ids the game gives to hearsay", () => {
    const taken = { ...archivePass, actions: { ...archivePass.actions, topics: archivePass.actions.topics.map((t, i) => (i === 0 ? { ...t, id: "~g1-0" } : t)) } };
    const result = validateCase(taken);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("reserved-id");
  });
});
