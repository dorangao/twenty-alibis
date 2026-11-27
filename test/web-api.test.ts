import { describe, expect, it } from "vitest";
import { archivePass } from "../src/case/fixtures/archive";
import type { Case } from "../src/case/schema";
import { solve } from "../src/case/solver";
import { inspectionMenu, topicMenu, type Session } from "../src/game/session";
import { noModel } from "../src/game/terminal";
import { createMetered, type Metered } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderRequest, ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore } from "../src/spend/store";
import { handle, MAX_BODY_BYTES, type ApiDeps, type ApiError, type CasesReply, type ViewReply } from "../src/web/api";
import { memorySessions, type SessionStore } from "../src/web/sessions";
import type { View } from "../src/web/view";
import { compilePlot } from "../src/writer/compile";
import { lighthousePeople, lighthouseSkeleton } from "../src/writer/fixtures/lighthouse";

const built = compilePlot("lighthouse", lighthouseSkeleton, lighthousePeople);
if (!built.ok) throw new Error(built.problems.join("; "));
const lighthouse: Case = built.case;
const usage = { inputTokens: 1_000, cachedTokens: 0, outputTokens: 60 };

/** A stand-in suspect: it picks the first topic on its menu and repeats the statements it is given. */
function wellBehaved(request: ProviderRequest): ProviderResponse {
  if (request.tools?.length) {
    const menu = (request.tools[0]!.parameters as { properties: { topic: { enum: string[] } } }).properties.topic.enum;
    return { text: null, toolCalls: [{ id: "call_1", name: "recall", arguments: JSON.stringify({ topic: menu[0] }) }], usage, finishReason: "tool_calls" };
  }
  const recalled = JSON.parse(request.messages.find((m) => m.role === "tool")!.content) as { statements: { id: string; en: string; zh: string }[] };
  return { text: JSON.stringify({ assertions: recalled.statements.map((s) => s.id), line: `${recalled.statements.map((s) => s.en).join(" ")} Now leave me be.`, language: "en" }), toolCalls: [], usage, finishReason: "stop" };
}

function server(options: { cases?: Case[]; metered?: Metered; modelOff?: boolean; sessions?: SessionStore } = {}) {
  let made = 0;
  const deps: ApiDeps = {
    cases: options.cases ?? [archivePass, lighthouse],
    sessions: options.sessions ?? memorySessions(),
    metered: options.metered ?? noModel,
    modelOff: options.modelOff ?? true,
    newId: () => `00000000-0000-4000-8000-${String(++made).padStart(12, "0")}`,
  };
  const call = async <T = ViewReply>(method: string, path: string, body?: unknown) => {
    const response = await handle(new Request(`http://game.test${path}`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }), deps);
    const raw = await response.text();
    return { status: response.status, raw, body: JSON.parse(raw) as T, headers: response.headers };
  };
  const start = async (caseId: string): Promise<View> => (await call("POST", "/api/sessions", { caseId })).body.view;
  return { deps, call, start };
}
const live = (handler: (request: ProviderRequest) => ProviderResponse = wellBehaved, killSwitch?: () => boolean) => {
  const provider = new FakeProvider(handler);
  const metered = createMetered({ inputBound: { tokensPerByte: 100 }, provider, store: new MemorySpendStore(), envelope: "e", limitNano: usdToNano(1), ...(killSwitch ? { killSwitch } : {}) });
  return { provider, metered };
};

/**
 * Everything in a case that a player has not been given: it must not be in any answer before
 * the verdict. What the player holds is read from the stored session through the game's own
 * functions, never from the view being checked.
 */
function hidden(c: Case, s: Session): string[] {
  const held = new Set(s.evidence);
  const openTopics = new Set(c.suspects.flatMap((x) => topicMenu(c, s, x.id).map((t) => t.id)));
  const openInspections = new Set(inspectionMenu(c, s).map((i) => i.id));
  return [
    // No assertion id at all: the page has no use for one.
    ...c.assertions.map((a) => a.id),
    // Evidence not held: its id and its words.
    ...c.evidence.filter((e) => !held.has(e.id)).flatMap((e) => [e.id, e.text.en, e.text.zh]),
    // Topics and inspections that are still locked.
    // A locked topic's id, and its words unless an open topic is worded the same (every "Where were you at …?" is).
    ...c.actions.topics.filter((t) => !openTopics.has(t.id)).flatMap((t) => [`"${t.id}"`, ...(c.actions.topics.some((o) => openTopics.has(o.id) && o.label.en === t.label.en) ? [] : [t.label.en, t.label.zh])]),
    ...c.actions.inspections.filter((i) => !openInspections.has(i.id)).flatMap((i) => [i.id, i.label.en, i.label.zh]),
    // Motive and means ids, and the motives' words unless a held item quotes them.
    ...c.motives.map((m) => `"${m.id}"`),
    ...c.means.map((m) => `"${m.id}"`),
    ...c.locations.map((l) => `"${l.id}"`),
  ];
}
const HIDDEN_KEYS = ["culprit", "whereabouts", "motives", "means", "lies", "assertions", "assertion", "proves", "yields", "requires", "briefing", "reveal", "verdict", "adjacent", "authoritative"];
async function expectNothingHidden(deps: ApiDeps, c: Case, raw: string, view: View, where: string) {
  const session = await deps.sessions.read(view.session);
  if (!session) throw new Error(`no stored session for ${where}`);
  for (const secret of hidden(c, session)) expect(raw, `${where}: ${secret}`).not.toContain(secret);
  for (const key of HIDDEN_KEYS) expect(raw, `${where}: key ${key}`).not.toContain(`"${key}":`);
  // And the view shows exactly what the session holds and offers, no more and no less.
  expect(view.evidence.map((e) => e.id), where).toEqual(session.evidence);
  expect(view.topics.map((t) => `${t.suspect} ${t.id} ${t.heard}`).sort(), where).toEqual(c.suspects.flatMap((x) => topicMenu(c, session, x.id).map((t) => `${x.id} ${t.id} ${t.heard}`)).sort());
  expect(view.inspections.map((i) => i.id), where).toEqual(inspectionMenu(c, session).map((i) => i.id));
}

describe("the game over HTTP, with the model off", () => {
  it("lists the library with public facts only", async () => {
    const { call } = server();
    const r = await call<CasesReply>("GET", "/api/cases");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toEqual({
      model: "off",
      cases: [
        { id: archivePass.id, title: archivePass.title, setting: archivePass.setting, suspects: archivePass.suspects.length, rooms: archivePass.locations.length, actions: archivePass.sessionCap },
        { id: lighthouse.id, title: lighthouse.title, setting: lighthouse.setting, suspects: 20, rooms: lighthouse.locations.length, actions: lighthouse.sessionCap },
      ],
    });
  });

  it("opens a case on the public briefing: the rules, the people, what is held, and what can be done now", async () => {
    const { call, deps } = server();
    const r = await call("POST", "/api/sessions", { caseId: lighthouse.id });
    expect(r.status).toBe(201);
    const view = r.body.view;
    expect(view).toMatchObject({ session: "00000000-0000-4000-8000-000000000001", caseId: lighthouse.id, title: lighthouse.title, model: "off", over: false, cost: { requests: 0, nano: 0 } });
    expect(view.actions).toEqual({ used: 0, cap: lighthouse.sessionCap, left: lighthouse.sessionCap });
    expect(view.people).toHaveLength(20);
    expect(view.people[0]).toEqual({ id: lighthouse.suspects[0]!.id, name: lighthouse.suspects[0]!.name, role: lighthouse.suspects[0]!.role, persona: lighthouse.suspects[0]!.persona });
    expect(view.rules).toHaveLength(4);
    expect(view.rules[3]!.zh).toContain("房间记录只列出在那里被看到的人");
    expect(view.evidence.map((e) => e.id)).toEqual(lighthouse.briefing.evidence);
    // The keeper's note is marked as a note, and it is the only one.
    expect(view.evidence.filter((e) => e.note)).toHaveLength(1);
    expect(view.statements).toEqual([]);
    expect(view.transcript).toEqual([]);
    expect(view.verdict).toBeUndefined();
    expect(view.reveal).toBeUndefined();
    await expectNothingHidden(deps, lighthouse, r.raw, view, "opening");
    // The view is an allow-list. A field that is not named here is not sent: adding one means changing this test.
    expect(Object.keys(view).sort()).toEqual(
      ["actions", "caseId", "cost", "evidence", "inspections", "model", "noteMark", "over", "people", "rooms", "rules", "session", "setting", "slots", "statements", "title", "topics", "transcript", "victim"].sort(),
    );
    expect(Object.keys(view.people[0]!).sort()).toEqual(["id", "name", "persona", "role"]);
    expect(Object.keys(view.evidence[0]!).sort()).toEqual(["id", "note", "text"]);
    expect(Object.keys(view.topics[0]!).sort()).toEqual(["heard", "id", "label", "suspect"]);
    expect(Object.keys(view.inspections[0]!).sort()).toEqual(["done", "id", "label"]);
    expect(Object.keys(view.victim).sort()).toEqual(["cause", "died", "found", "name"]);
    // The same view again by GET.
    expect((await call("GET", `/api/sessions/${view.session}`)).body.view).toEqual(view);
  });

  for (const c of [archivePass, lighthouse]) {
    it(`plays ${c.id} along the solver's own proof to a solved case, and nothing hidden is sent on the way`, async () => {
      const { call, start, deps } = server();
      let view = await start(c.id);
      const proof = solve(c).proof!;
      for (const step of proof.actions) {
        const r =
          step.type === "inspection"
            ? await call("POST", `/api/sessions/${view.session}/inspect`, { inspection: step.id })
            : await call("POST", `/api/sessions/${view.session}/ask`, { suspect: c.actions.topics.find((t) => t.id === step.id)!.suspect, topic: step.id, language: "zh" });
        expect(r.status, `${step.type} ${step.id}`).toBe(200);
        view = r.body.view;
        await expectNothingHidden(deps, c, r.raw, view, `${step.type} ${step.id}`);
      }
      expect(view.actions.used).toBe(proof.actions.length);
      // With the model off every line is worded by code, in the language asked, and costs nothing.
      expect(view.transcript.every((t) => t.source === "rendered" && t.language === "zh")).toBe(true);
      expect(view.cost).toEqual({ requests: 0, nano: 0 });

      const accused = await call("POST", `/api/sessions/${view.session}/accuse`, { suspect: c.culprit.suspect, evidence: view.evidence.map((e) => e.id) });
      expect(accused.status).toBe(200);
      const end = accused.body.view;
      expect(end.over).toBe(true);
      expect(end.verdict).toMatchObject({ accused: c.culprit.suspect, outcome: "solved", missing: [], open: [], accusedRuledOut: false });
      // The truth is sent now, and only now: in words, not in the case file's ids.
      expect(end.reveal!.culprit).toBe(c.culprit.suspect);
      expect(end.reveal!.motive).toEqual(c.motives.find((m) => m.id === c.culprit.motive)!.text);
      expect(end.reveal!.timeline).toHaveLength(c.suspects.length);
      expect(end.reveal!.timeline[0]!.at.map((x) => x.slot)).toEqual(c.slots);
      expect(end.reveal!.lies).toHaveLength(c.suspects.reduce((n, s) => n + s.lies.length, 0));
      for (const a of c.assertions) expect(accused.raw).not.toContain(`"${a.id}"`);
      // And the game is over.
      expect((await call<ApiError>("POST", `/api/sessions/${view.session}/inspect`, { inspection: c.actions.inspections[0]!.id })).body.error.code).toBe("over");
      expect((await call<ApiError>("POST", `/api/sessions/${view.session}/accuse`, { suspect: c.culprit.suspect, evidence: [] })).body.error.code).toBe("over");
    });
  }

  it("shows a contradiction on the statement it is against, by the evidence that is held", async () => {
    const { call, start } = server();
    let view = await start(archivePass.id);
    const caught = solve(archivePass).caughtLies[0]!;
    for (const step of solve(archivePass).proof!.actions) {
      const path = step.type === "inspection" ? "inspect" : "ask";
      const body = step.type === "inspection" ? { inspection: step.id } : { suspect: archivePass.actions.topics.find((t) => t.id === step.id)!.suspect, topic: step.id };
      view = (await call("POST", `/api/sessions/${view.session}/${path}`, body)).body.view;
    }
    // Hear the lie, if the proof did not already.
    const lieTopic = archivePass.actions.topics.find((t) => t.suspect === caught.suspect && t.yields.includes(caught.assertion))!;
    view = (await call("POST", `/api/sessions/${view.session}/ask`, { suspect: caught.suspect, topic: lieTopic.id })).body.view;
    const against = view.statements.filter((s) => s.contradictedBy.length > 0);
    expect(against.length).toBeGreaterThan(0);
    expect(against[0]!.suspect).toBe(caught.suspect);
    for (const id of against[0]!.contradictedBy) expect(view.evidence.map((e) => e.id)).toContain(id);
  });

  it("a right name without the proof is right but unproven, and a wrong name is wrong: the scorer decides", async () => {
    const { call, start } = server();
    const a = await start(lighthouse.id);
    const early = (await call("POST", `/api/sessions/${a.session}/accuse`, { suspect: lighthouse.culprit.suspect, evidence: a.evidence.map((e) => e.id) })).body.view;
    expect(early.verdict!.outcome).toBe("right-but-unproven");
    expect(early.verdict!.open.length).toBeGreaterThan(0);
    const b = await start(lighthouse.id);
    const other = lighthouse.suspects.find((s) => s.id !== lighthouse.culprit.suspect)!.id;
    const wrong = (await call("POST", `/api/sessions/${b.session}/accuse`, { suspect: other, evidence: [] })).body.view;
    expect(wrong.verdict!.outcome).toBe("wrong");
    // The reveal is the same truth either way.
    expect(wrong.reveal!.culprit).toBe(lighthouse.culprit.suspect);
  });

  it("a question in the player's own words is not asked, and uses nothing", async () => {
    const { call, start } = server();
    const view = await start(archivePass.id);
    const r = await call<ApiError>("POST", `/api/sessions/${view.session}/ask`, { suspect: archivePass.suspects[0]!.id, question: "Where were you?" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("model-off");
    expect((await call("GET", `/api/sessions/${view.session}`)).body.view).toEqual(view);
  });

  it("keeps sessions apart", async () => {
    const { call, start } = server();
    const a = await start(lighthouse.id);
    const b = await start(lighthouse.id);
    expect(a.session).not.toBe(b.session);
    await call("POST", `/api/sessions/${a.session}/inspect`, { inspection: a.inspections[0]!.id });
    expect((await call("GET", `/api/sessions/${a.session}`)).body.view.actions.used).toBe(1);
    expect((await call("GET", `/api/sessions/${b.session}`)).body.view).toEqual(b);
  });
});

describe("what the server says when it cannot do what was asked", () => {
  it("answers with a fixed code and a fixed sentence in both languages, and nothing else", async () => {
    const { call, start } = server();
    const view = await start(lighthouse.id);
    const at = `/api/sessions/${view.session}`;
    const locked = lighthouse.actions.inspections.find((i) => !view.inspections.some((open) => open.id === i.id))!;
    const cases: [string, string, unknown, number, string][] = [
      ["GET", "/nothing", undefined, 404, "not-found"],
      ["GET", "/api/nothing", undefined, 404, "not-found"],
      ["POST", "/api/cases", {}, 405, "method"],
      ["GET", "/api/sessions", undefined, 405, "method"],
      ["DELETE", at, undefined, 405, "method"],
      ["GET", `${at}/ask`, undefined, 405, "method"],
      ["POST", `${at}/reveal`, {}, 404, "not-found"],
      ["POST", "/api/sessions", "not json", 400, "bad-request"],
      ["POST", "/api/sessions", [], 400, "bad-request"],
      ["POST", "/api/sessions", {}, 400, "bad-request"],
      ["POST", "/api/sessions", { caseId: 7 }, 400, "bad-request"],
      ["POST", "/api/sessions", { caseId: "no-such-case" }, 404, "not-found"],
      ["POST", "/api/sessions", { caseId: "x".repeat(MAX_BODY_BYTES) }, 400, "bad-request"],
      // A body that is too large is not read, even when what it asks for is well formed.
      ["POST", "/api/sessions", { caseId: lighthouse.id, pad: "x".repeat(MAX_BODY_BYTES) }, 400, "bad-request"],
      ["GET", "/api/sessions/00000000-0000-4000-8000-999999999999", undefined, 404, "not-found"],
      ["GET", "/api/sessions/not-an-id", undefined, 404, "not-found"],
      ["POST", "/api/sessions/00000000-0000-4000-8000-999999999999/inspect", { inspection: "i-01" }, 404, "not-found"],
      ["POST", `${at}/inspect`, {}, 400, "bad-request"],
      ["POST", `${at}/inspect`, { inspection: "no-such-thing" }, 404, "not-available"],
      ["POST", `${at}/inspect`, { inspection: locked.id }, 404, "not-available"],
      ["POST", `${at}/ask`, { suspect: "nobody", topic: "t-01" }, 404, "not-available"],
      ["POST", `${at}/ask`, { suspect: lighthouse.suspects[0]!.id, topic: "no-such-topic" }, 404, "not-available"],
      ["POST", `${at}/ask`, { suspect: lighthouse.suspects[0]!.id }, 400, "bad-request"],
      ["POST", `${at}/accuse`, { suspect: lighthouse.suspects[0]!.id }, 400, "bad-request"],
      ["POST", `${at}/accuse`, { suspect: lighthouse.suspects[0]!.id, evidence: "all" }, 400, "bad-request"],
      ["POST", `${at}/accuse`, { suspect: lighthouse.suspects[0]!.id, evidence: [7] }, 400, "bad-request"],
      ["POST", `${at}/accuse`, { suspect: "nobody", evidence: [] }, 404, "not-available"],
      ["POST", `${at}/accuse`, { suspect: lighthouse.suspects[0]!.id, evidence: [locked.yields[0]] }, 400, "not-held"],
    ];
    for (const [method, path, body, status, code] of cases) {
      const r = await call<ApiError>(method, path, body);
      const what = `${method} ${path} ${JSON.stringify(body)?.slice(0, 40)}`;
      expect(r.status, what).toBe(status);
      expect(r.body.error.code, what).toBe(code);
      expect(Object.keys(r.body), what).toEqual(["error"]);
      expect(Object.keys(r.body.error), what).toEqual(["code", "text"]);
      expect(r.body.error.text.en, what).not.toMatch(/[一-鿿]/);
      expect(r.body.error.text.zh, what).toMatch(/[一-鿿]/);
      // Nothing of the case is in an error.
      for (const s of lighthouse.suspects) expect(r.raw, what).not.toContain(s.id);
      for (const e of lighthouse.evidence) expect(r.raw, what).not.toContain(e.id);
    }
    // None of it changed the session.
    expect((await call("GET", at)).body.view).toEqual(view);
  });

  it("a locked thing and a thing that does not exist get the very same answer", async () => {
    const { call, start } = server();
    const view = await start(lighthouse.id);
    const at = `/api/sessions/${view.session}`;
    const locked = lighthouse.actions.inspections.find((i) => !view.inspections.some((open) => open.id === i.id))!;
    const a = await call("POST", `${at}/inspect`, { inspection: locked.id });
    const b = await call("POST", `${at}/inspect`, { inspection: "i-99" });
    expect(a.status).toBe(b.status);
    expect(a.raw).toBe(b.raw);
    const unknown = await call("GET", "/api/sessions/00000000-0000-4000-8000-999999999999");
    const malformed = await call("GET", "/api/sessions/whatever");
    expect(unknown.raw).toBe(malformed.raw);
  });

  it("a topic that is still locked is not shown, cannot be asked, and opens when what it needs is held", async () => {
    // The last person's topic now needs the scene's record, which the player does not hold at the start.
    const scene = lighthouse.actions.inspections.find((i) => i.requires?.length)!;
    const gated = lighthouse.actions.topics.at(-1)!;
    const c: Case = { ...lighthouse, actions: { ...lighthouse.actions, topics: lighthouse.actions.topics.map((t) => (t.id === gated.id ? { ...t, requires: [scene.yields[0]!] } : t)) } };
    const { call, start, deps } = server({ cases: [c] });
    const opening = await call("POST", "/api/sessions", { caseId: c.id });
    let view = opening.body.view;
    expect(view.topics).toHaveLength(c.actions.topics.length - 1);
    expect(view.topics.some((t) => t.id === gated.id)).toBe(false);
    await expectNothingHidden(deps, c, opening.raw, view, "opening with a locked topic");
    const at = `/api/sessions/${view.session}`;
    const locked = await call("POST", `${at}/ask`, { suspect: gated.suspect, topic: gated.id });
    const missing = await call("POST", `${at}/ask`, { suspect: gated.suspect, topic: "t-99" });
    expect(locked.status).toBe(404);
    expect(locked.raw).toBe(missing.raw);
    // Hear the keeper, read the scene: the topic opens.
    const keeper = c.actions.topics.find((t) => scene.requires!.some((need) => t.yields.includes(need)))!;
    await call("POST", `${at}/ask`, { suspect: keeper.suspect, topic: keeper.id });
    const after = await call("POST", `${at}/inspect`, { inspection: scene.id });
    view = after.body.view;
    expect(view.topics.find((t) => t.id === gated.id)).toMatchObject({ suspect: gated.suspect, heard: false });
    expect(view.topics.find((t) => t.id === keeper.id)).toMatchObject({ heard: true });
    await expectNothingHidden(deps, c, after.raw, view, "after the scene");
    expect((await call("POST", `${at}/ask`, { suspect: gated.suspect, topic: gated.id })).status).toBe(200);
  });

  it("stops at the action cap, and still lets the player accuse", async () => {
    const short = { ...archivePass, sessionCap: 1 };
    const { call, start } = server({ cases: [short] });
    const view = await start(short.id);
    const at = `/api/sessions/${view.session}`;
    expect((await call("POST", `${at}/inspect`, { inspection: view.inspections[0]!.id })).body.view.actions.left).toBe(0);
    const topic = view.topics[0]!;
    const refused = await call<ApiError>("POST", `${at}/ask`, { suspect: topic.suspect, topic: topic.id });
    expect([refused.status, refused.body.error.code]).toEqual([409, "cap"]);
    expect((await call("POST", `${at}/accuse`, { suspect: short.suspects[0]!.id, evidence: [] })).body.view.over).toBe(true);
  });

  it("says nothing of what went wrong inside when the server itself fails", async () => {
    const broken: SessionStore = {
      create: async () => {
        throw new Error(`cannot store the case whose culprit is ${lighthouse.culprit.suspect}`);
      },
      read: async () => {
        throw new Error("redis is down at 10.0.0.7");
      },
      update: async () => {
        throw new Error("boom");
      },
    };
    const { call } = server({ sessions: broken });
    for (const [method, path, body] of [
      ["POST", "/api/sessions", { caseId: lighthouse.id }],
      ["GET", "/api/sessions/00000000-0000-4000-8000-000000000001", undefined],
      ["POST", "/api/sessions/00000000-0000-4000-8000-000000000001/inspect", { inspection: "i-01" }],
    ] as const) {
      const r = await call<ApiError>(method, path, body);
      expect(r.status).toBe(500);
      expect(r.body).toEqual({ error: { code: "server", text: { en: "Something went wrong on the server. Nothing was changed.", zh: "服务器出了问题。没有做任何改动。" } } });
    }
  });
});

describe("the game over HTTP, with a model", () => {
  it("shows the suspect's own line for a typed question, notes the statement, and counts the cost", async () => {
    const { provider, metered } = live();
    const { call, start, deps } = server({ metered, modelOff: false });
    const view = await start(archivePass.id);
    expect(view.model).toBe("on");
    const suspect = archivePass.suspects[0]!.id;
    const r = await call("POST", `/api/sessions/${view.session}/ask`, { suspect, question: "Where were you at nine?" });
    expect(r.status).toBe(200);
    expect(r.body.ask).toEqual({ replayed: false, recorded: true });
    const turn = r.body.view.transcript[0]!;
    expect(turn).toMatchObject({ n: 1, suspect, question: "Where were you at nine?", source: "model", language: "en" });
    expect(turn.line).toContain("Now leave me be.");
    expect(turn.noted).toBeGreaterThan(0);
    expect(Object.keys(turn).sort()).toEqual(["language", "line", "n", "noted", "question", "source", "suspect"]);
    expect(Object.keys(r.body.view.statements[0]!).sort()).toEqual(["contradictedBy", "key", "suspect", "text", "turn"]);
    expect(r.body.view.statements).toHaveLength(turn.noted);
    expect(provider.dispatched).toBe(2);
    expect(r.body.view.cost.requests).toBe(2);
    expect(r.body.view.cost.nano).toBeGreaterThan(0);
    expect(r.body.view.actions.used).toBe(1);
    await expectNothingHidden(deps, archivePass, r.raw, r.body.view, "typed question");
    // The model's rejected lines, if any, and its raw replies are never part of a view.
    expect(r.raw).not.toContain("rejections");
    expect(r.raw).not.toContain("call_1");
    // The same question again is the saved turn: nothing is sent and nothing is used.
    const again = await call("POST", `/api/sessions/${view.session}/ask`, { suspect, question: "Where were you at nine?" });
    expect(again.body.ask).toMatchObject({ replayed: true, recorded: true });
    expect(provider.dispatched).toBe(2);
    expect(again.body.view.actions.used).toBe(1);
  });

  it("refuses a question with no words or too many, before anything is sent", async () => {
    const { provider, metered } = live();
    const { call, start } = server({ metered, modelOff: false });
    const view = await start(archivePass.id);
    const at = `/api/sessions/${view.session}/ask`;
    const suspect = archivePass.suspects[0]!.id;
    expect((await call<ApiError>("POST", at, { suspect, question: "   " })).body.error.code).toBe("bad-question");
    expect((await call<ApiError>("POST", at, { suspect, question: "x".repeat(301) })).body.error.code).toBe("bad-question");
    expect(provider.dispatched).toBe(0);
  });

  it("when the spend guard refuses, a typed question is not asked and a menu topic is worded by code; the player is told which", async () => {
    let closed = false;
    const { provider, metered } = live(wellBehaved, () => closed);
    const { call, start } = server({ metered, modelOff: false });
    const view = await start(archivePass.id);
    const at = `/api/sessions/${view.session}/ask`;
    const suspect = archivePass.suspects[0]!.id;
    closed = true;
    const typed = await call("POST", at, { suspect, question: "Where were you at nine?" });
    expect(typed.status).toBe(200);
    expect(typed.body.ask).toMatchObject({ replayed: false, recorded: false, notice: { code: "not-asked" } });
    expect(typed.body.view.actions.used).toBe(0);
    expect(typed.body.view.transcript).toEqual([]);
    const topic = view.topics.find((t) => t.suspect === suspect)!;
    const menu = await call("POST", at, { suspect, topic: topic.id });
    expect(menu.body.ask).toMatchObject({ replayed: false, recorded: true, notice: { code: "worded-by-code" } });
    expect(menu.body.view.transcript[0]).toMatchObject({ source: "rendered" });
    expect(menu.body.view.actions.used).toBe(1);
    expect(provider.dispatched).toBe(0);
    // The notices are fixed sentences: they do not carry the guard's reason.
    expect(typed.raw).not.toContain("kill-switch");
    expect(menu.raw).not.toContain("kill-switch");
    expect(menu.raw).not.toContain("refused");
  });

  it("one request at a time for a session: a second that arrives during the first is refused, and nothing is sent twice", async () => {
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    const { provider, metered: inner } = live();
    // Holds the first request of the question until released.
    let held = false;
    const metered: Metered = async (request) => {
      if (!held) {
        held = true;
        arrived();
        await gate;
      }
      return inner(request);
    };
    const { call, start } = server({ metered, modelOff: false });
    const view = await start(archivePass.id);
    const at = `/api/sessions/${view.session}`;
    const suspect = archivePass.suspects[0]!.id;

    const first = call("POST", `${at}/ask`, { suspect, question: "Where were you at nine?" });
    await reached;
    // The same question again, another question, an inspection and an accusation: all refused, none acted on.
    for (const [path, body] of [
      ["ask", { suspect, question: "Where were you at nine?" }],
      ["ask", { suspect, topic: view.topics.find((t) => t.suspect === suspect)!.id }],
      ["inspect", { inspection: view.inspections[0]!.id }],
      ["accuse", { suspect, evidence: [] }],
    ] as const) {
      const r = await call<ApiError>("POST", `${at}/${path}`, body);
      expect([r.status, r.body.error.code], path).toEqual([409, "busy"]);
    }
    // Reading is not blocked, and shows the session as it stood.
    expect((await call("GET", at)).body.view).toEqual(view);
    // Another session is not held up.
    const other = await start(archivePass.id);
    expect((await call("POST", `/api/sessions/${other.session}/inspect`, { inspection: other.inspections[0]!.id })).status).toBe(200);

    release();
    const done = await first;
    expect(done.status).toBe(200);
    expect(done.body.view.transcript).toHaveLength(1);
    expect(done.body.view.actions.used).toBe(1);
    expect(done.body.view.over).toBe(false);
    expect(provider.dispatched).toBe(2);
    // Free again.
    expect((await call("POST", `${at}/inspect`, { inspection: view.inspections[0]!.id })).status).toBe(200);
  });
});

describe("sessions in memory", () => {
  const blank = (id: string) => ({ id, caseId: "c", actions: 0, evidence: [], inspections: [], asked: 0, turns: [] });

  it("keeps what the work returns, keeps nothing when it throws, and lets go either way", async () => {
    const store = memorySessions();
    await store.create(blank("a"));
    expect(await store.update("a", async (s) => ({ session: { ...s, actions: 1 }, value: "done" }))).toEqual({ ok: true, value: "done" });
    expect((await store.read("a"))!.actions).toBe(1);
    await expect(store.update("a", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect((await store.read("a"))!.actions).toBe(1);
    expect(await store.update("a", async (s) => ({ session: s, value: 1 }))).toEqual({ ok: true, value: 1 });
    expect(await store.update("nobody", async (s) => ({ session: s, value: 1 }))).toEqual({ ok: false, why: "missing" });
    expect(await store.read("nobody")).toBeNull();
  });

  it("makes room by dropping the oldest session that is not at work", async () => {
    const store = memorySessions({ max: 2 });
    await store.create(blank("a"));
    await store.create(blank("b"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // "a" is the oldest, and it is at work: "b" goes instead.
    const working = store.update("a", async (s) => {
      await gate;
      return { session: { ...s, actions: 5 }, value: null };
    });
    await store.create(blank("c"));
    expect(await store.read("a")).not.toBeNull();
    expect(await store.read("b")).toBeNull();
    expect(await store.read("c")).not.toBeNull();
    release();
    await working;
    expect((await store.read("a"))!.actions).toBe(5);
    // Now "a" is idle and the oldest.
    await store.create(blank("d"));
    expect(await store.read("a")).toBeNull();
  });
});
