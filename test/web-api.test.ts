import { describe, expect, it } from "vitest";
import { archivePass } from "../src/case/fixtures/archive";
import type { Case } from "../src/case/schema";
import { solve } from "../src/case/solver";
import { inspectionMenu, topicMenu } from "../src/game/session";
import { noModel } from "../src/game/terminal";
import { createMetered, type Metered } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderRequest, ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore } from "../src/spend/store";
import { caseVersion, handleRequest, MAX_BODY_BYTES, VISITOR_COOKIE, type ApiDeps, type ApiError, type CasesReply, type ViewReply } from "../src/web/api";
import { memorySessions, type SessionRecord, type SessionStore } from "../src/web/sessions";
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

type Reply<T> = { status: number; raw: string; body: T; headers: Headers };

function server(options: { cases?: Case[]; metered?: Metered; modelOff?: boolean; sessions?: SessionStore; now?: () => number; origin?: string } = {}) {
  let made = 0;
  let secrets = 0;
  const deps: ApiDeps = {
    cases: options.cases ?? [archivePass, lighthouse],
    sessions: options.sessions ?? memorySessions(options.now ? { now: options.now } : {}),
    metered: options.metered ?? noModel,
    modelOff: options.modelOff ?? true,
    newId: () => `00000000-0000-4000-8000-${String(++made).padStart(12, "0")}`,
    newSecret: () => String(++secrets).padStart(64, "0"),
    ...(options.now ? { now: options.now } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
  };
  /** One browser: it keeps the cookie it is given and sends it back. */
  const visitor = () => {
    let cookie: string | null = null;
    const call = async <T = ViewReply>(method: string, path: string, body?: unknown, extra: { origin?: string | null; https?: boolean; cookie?: string | null } = {}): Promise<Reply<T>> => {
      const sent = extra.cookie === undefined ? cookie : extra.cookie;
      const base = `${extra.https ? "https" : "http"}://game.test`;
      // Like a browser: a page's POST carries the page's origin. `origin: null` leaves it out.
      const origin = extra.origin === undefined ? (method === "GET" ? null : base) : extra.origin;
      const headers: Record<string, string> = { ...(sent ? { cookie: sent } : {}), ...(origin ? { origin } : {}) };
      const response = await handleRequest(new Request(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }), deps);
      const set = response.headers.get("set-cookie");
      if (set && extra.cookie === undefined) cookie = set.split(";")[0]!;
      const raw = await response.text();
      return { status: response.status, raw, body: JSON.parse(raw) as T, headers: response.headers };
    };
    const start = async (caseId: string): Promise<View> => (await call("POST", "/api/sessions", { caseId })).body.view;
    /** Act on the view just shown: its revision goes with the request. */
    const act = <T = ViewReply>(view: View, action: "ask" | "inspect" | "accuse", body: Record<string, unknown>) => call<T>("POST", `/api/sessions/${view.session}/${action}`, { revision: view.revision, ...body });
    return { call, start, act, cookie: () => cookie };
  };
  return { deps, ...visitor(), visitor };
}
const live = (handler: (request: ProviderRequest) => ProviderResponse = wellBehaved, killSwitch?: () => boolean) => {
  const provider = new FakeProvider(handler);
  const metered = createMetered({ inputBound: { tokensPerByte: 100 }, provider, store: new MemorySpendStore(), envelope: "e", limitNano: usdToNano(1), ...(killSwitch ? { killSwitch } : {}) });
  return { provider, metered };
};
const stored = async (deps: ApiDeps, view: View): Promise<SessionRecord> => {
  const record = await deps.sessions.read(view.session);
  if (!record) throw new Error("no stored session");
  return record;
};
/** The page's handle for one of the case's things, read from the stored record: what a test uses to name it. */
const personOf = (c: Case, id: string) => `P${c.suspects.findIndex((s) => s.id === id) + 1}`;
const topicOf = (record: SessionRecord, id: string) => `T${record.topics.indexOf(id) + 1}`;
const inspectionOf = (record: SessionRecord, id: string) => `I${record.inspections.indexOf(id) + 1}`;

/** Every id the case file gives anything. None may reach a page, before the verdict or after. */
const authorIds = (c: Case): string[] => [
  ...c.suspects.map((s) => s.id),
  ...c.assertions.map((a) => a.id),
  ...c.evidence.map((e) => e.id),
  ...c.actions.topics.map((t) => t.id),
  ...c.actions.inspections.map((i) => i.id),
  ...c.motives.map((m) => m.id),
  ...c.means.map((m) => m.id),
  ...c.locations.map((l) => l.id),
];
const HIDDEN_KEYS = ["culprit", "whereabouts", "motives", "means", "lies", "assertions", "assertion", "proves", "yields", "requires", "briefing", "reveal", "verdict", "adjacent", "authoritative", "persona", "owner", "caseVersion", "mode", "suspect", "id"];

/**
 * Nothing the player has not been given is in the answer. What the player holds is read from
 * the stored session through the game's own functions, never from the view being checked.
 */
async function expectNothingHidden(deps: ApiDeps, c: Case, raw: string, view: View, where: string) {
  const record = await stored(deps, view);
  const s = record.session;
  const held = new Set(s.evidence);
  const openTopics = c.suspects.flatMap((x) => topicMenu(c, s, x.id).map((t) => ({ ...t, suspect: x.id })));
  const openInspections = inspectionMenu(c, s);
  const secrets = [
    // The words of evidence not held, and of topics and inspections still locked (unless something open is worded the same).
    ...c.evidence.filter((e) => !held.has(e.id)).flatMap((e) => [e.text.en, e.text.zh]),
    ...c.actions.topics.filter((t) => !openTopics.some((o) => o.id === t.id || o.label.en === t.label.en)).flatMap((t) => [t.label.en, t.label.zh]),
    ...c.actions.inspections.filter((i) => !openInspections.some((o) => o.id === i.id)).flatMap((i) => [i.label.en, i.label.zh]),
    // No id from the case file, quoted as a JSON string value.
    ...authorIds(c).map((id) => `"${id}"`),
    // The hash of the visitor's secret never comes back in a body.
    record.owner,
  ];
  for (const secret of secrets) expect(raw, `${where}: ${secret}`).not.toContain(secret);
  for (const key of HIDDEN_KEYS) expect(raw, `${where}: key ${key}`).not.toContain(`"${key}":`);
  // And the view shows exactly what the session holds and offers, no more and no less, under its own handles.
  expect(view.evidence.map((e) => e.handle), where).toEqual(s.evidence.map((_e, i) => `E${i + 1}`));
  expect(view.evidence.map((e) => e.text), where).toEqual(s.evidence.map((id) => c.evidence.find((e) => e.id === id)!.text));
  expect(view.topics.map((t) => `${t.handle} ${t.person} ${t.heard}`).sort(), where).toEqual(openTopics.map((t) => `${topicOf(record, t.id)} ${personOf(c, t.suspect)} ${t.heard}`).sort());
  expect(view.inspections.map((i) => `${i.handle} ${i.done}`).sort(), where).toEqual(openInspections.map((i) => `${inspectionOf(record, i.id)} ${i.done}`).sort());
  expect(view.revision, where).toBe(record.revision);
}

describe("the game over HTTP, with the model off", () => {
  it("lists the library with public facts only", async () => {
    const { call } = server();
    const r = await call<CasesReply>("GET", "/api/cases");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("set-cookie")).toBeNull();
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
    expect(view).toMatchObject({ session: "00000000-0000-4000-8000-000000000001", revision: 1, caseId: lighthouse.id, title: lighthouse.title, model: "off", over: false, cost: { requests: 0, nano: 0 } });
    expect(view.actions).toEqual({ used: 0, cap: lighthouse.sessionCap, left: lighthouse.sessionCap });
    // People are P1 … in the roster's order, with a name and a role and nothing else.
    expect(view.people).toEqual(lighthouse.suspects.map((s, i) => ({ handle: `P${i + 1}`, name: s.name, role: s.role })));
    expect(view.rules).toHaveLength(4);
    expect(view.rules[3]!.zh).toContain("房间记录只列出在那里被看到的人");
    expect(view.evidence.map((e) => e.handle)).toEqual(lighthouse.briefing.evidence.map((_e, i) => `E${i + 1}`));
    // The keeper's note is marked as a note, and it is the only one.
    expect(view.evidence.filter((e) => e.note)).toHaveLength(1);
    expect(view.statements).toEqual([]);
    expect(view.transcript).toEqual([]);
    expect(view.verdict).toBeUndefined();
    expect(view.reveal).toBeUndefined();
    await expectNothingHidden(deps, lighthouse, r.raw, view, "opening");
    // The view is an allow-list. A field that is not named here is not sent: adding one means changing this test.
    expect(Object.keys(view).sort()).toEqual(
      ["actions", "caseId", "cost", "evidence", "inspections", "model", "noteMark", "over", "people", "revision", "rooms", "rules", "session", "setting", "slots", "statements", "title", "topics", "transcript", "victim"].sort(),
    );
    expect(Object.keys(view.evidence[0]!).sort()).toEqual(["handle", "note", "text"]);
    expect(Object.keys(view.topics[0]!).sort()).toEqual(["handle", "heard", "label", "person"]);
    expect(Object.keys(view.inspections[0]!).sort()).toEqual(["done", "handle", "label"]);
    expect(Object.keys(view.victim).sort()).toEqual(["cause", "died", "found", "name"]);
    // The same view again by GET.
    expect((await call("GET", `/api/sessions/${view.session}`)).body.view).toEqual(view);
  });

  it("opens the same way whoever did it: two cases with the same public facts and different culprits", async () => {
    const a = lighthousePeople.suspects.find((s) => s.id === "s-01")!;
    const b = lighthousePeople.suspects.find((s) => s.id === "s-03")!;
    const swapped = compilePlot("lighthouse", lighthouseSkeleton, {
      culprit: "s-01",
      suspects: lighthousePeople.suspects.map((s) => (s.id === "s-01" ? { ...s, whereabouts: b.whereabouts } : s.id === "s-03" ? { ...s, whereabouts: a.whereabouts } : s)),
    });
    if (!swapped.ok) throw new Error("expected a case");
    expect(swapped.case.culprit.suspect).not.toBe(lighthouse.culprit.suspect);
    const one = server({ cases: [lighthouse] });
    const two = server({ cases: [swapped.case] });
    const first = await one.call("POST", "/api/sessions", { caseId: lighthouse.id });
    const second = await two.call("POST", "/api/sessions", { caseId: lighthouse.id });
    // Byte for byte: every field, key, handle, order and length.
    expect(second.raw).toBe(first.raw);
    // And still the same after the keeper has been heard, in either language.
    const keeper = lighthouse.actions.topics.find((t) => lighthouse.actions.inspections.some((i) => i.requires?.some((need) => t.yields.includes(need))))!;
    const x = await one.act(first.body.view, "ask", { topic: topicOf(await stored(one.deps, first.body.view), keeper.id), language: "zh" });
    const y = await two.act(second.body.view, "ask", { topic: topicOf(await stored(two.deps, second.body.view), keeper.id), language: "zh" });
    expect(x.status).toBe(200);
    expect(y.raw).toBe(x.raw);
  });

  for (const c of [archivePass, lighthouse]) {
    it(`plays ${c.id} along the solver's own proof to a solved case, and nothing hidden is sent on the way`, async () => {
      const { act, start, deps } = server();
      let view = await start(c.id);
      const proof = solve(c).proof!;
      for (const step of proof.actions) {
        const record = await stored(deps, view);
        const r = step.type === "inspection" ? await act(view, "inspect", { inspection: inspectionOf(record, step.id) }) : await act(view, "ask", { topic: topicOf(record, step.id), language: "zh" });
        expect(r.status, `${step.type} ${step.id}`).toBe(200);
        expect(r.body.view.revision).toBe(view.revision + 1);
        view = r.body.view;
        await expectNothingHidden(deps, c, r.raw, view, `${step.type} ${step.id}`);
      }
      expect(view.actions.used).toBe(proof.actions.length);
      // With the model off every line is worded by code, in the language asked, and costs nothing.
      expect(view.transcript.every((t) => t.source === "rendered" && t.language === "zh")).toBe(true);
      expect(view.cost).toEqual({ requests: 0, nano: 0 });

      const accused = await act(view, "accuse", { person: personOf(c, c.culprit.suspect), evidence: view.evidence.map((e) => e.handle) });
      expect(accused.status).toBe(200);
      const end = accused.body.view;
      expect(end.over).toBe(true);
      expect(end.verdict).toMatchObject({ accused: personOf(c, c.culprit.suspect), cited: view.evidence.map((e) => e.handle), outcome: "solved", missing: [], open: [], accusedRuledOut: false });
      // The truth is sent now, and only now: in words and handles, never in the case file's ids.
      expect(end.reveal!.culprit).toBe(personOf(c, c.culprit.suspect));
      expect(end.reveal!.motive).toEqual(c.motives.find((m) => m.id === c.culprit.motive)!.text);
      expect(end.reveal!.timeline.map((row) => row.person)).toEqual(c.suspects.map((_s, i) => `P${i + 1}`));
      expect(end.reveal!.timeline[0]!.at.map((x) => x.slot)).toEqual(c.slots);
      expect(end.reveal!.lies).toHaveLength(c.suspects.reduce((n, s) => n + s.lies.length, 0));
      for (const id of authorIds(c)) expect(accused.raw, id).not.toContain(`"${id}"`);
      // And the game is over.
      expect((await act<ApiError>(end, "inspect", { inspection: "I1" })).body.error.code).toBe("over");
      expect((await act<ApiError>(end, "accuse", { person: "P1", evidence: [] })).body.error.code).toBe("over");
    });
  }

  it("a handle is kept for good: a record that opens later is numbered after the ones already there", async () => {
    const { act, start, deps } = server();
    let view = await start(lighthouse.id);
    const before = view.inspections.map((i) => `${i.handle} ${i.label.en}`);
    const scene = lighthouse.actions.inspections.find((i) => i.requires?.length)!;
    const keeper = lighthouse.actions.topics.find((t) => scene.requires!.some((need) => t.yields.includes(need)))!;
    // The scene's record is first in the case file and is not on the menu yet.
    expect(lighthouse.actions.inspections[0]!.id).toBe(scene.id);
    expect(before).toHaveLength(lighthouse.actions.inspections.length - 1);
    view = (await act(view, "ask", { topic: topicOf(await stored(deps, view), keeper.id) })).body.view;
    // It opens as the last number. Nothing that was there has moved.
    expect(view.inspections.map((i) => `${i.handle} ${i.label.en}`)).toEqual([...before, `I${before.length + 1} ${scene.label.en}`]);
    // An inspection made keeps its handle and is marked done.
    view = (await act(view, "inspect", { inspection: "I1" })).body.view;
    expect(view.inspections[0]).toMatchObject({ handle: "I1", done: true });
    expect(view.evidence.at(-1)!.handle).toBe(`E${lighthouse.briefing.evidence.length + 1}`);
  });

  it("shows a contradiction on the statement it is against, by the evidence that is held", async () => {
    const { act, start, deps } = server();
    let view = await start(archivePass.id);
    const caught = solve(archivePass).caughtLies[0]!;
    for (const step of solve(archivePass).proof!.actions) {
      const record = await stored(deps, view);
      view = (step.type === "inspection" ? await act(view, "inspect", { inspection: inspectionOf(record, step.id) }) : await act(view, "ask", { topic: topicOf(record, step.id) })).body.view;
    }
    // Hear the lie, if the proof did not already.
    const lieTopic = archivePass.actions.topics.find((t) => t.suspect === caught.suspect && t.yields.includes(caught.assertion))!;
    view = (await act(view, "ask", { topic: topicOf(await stored(deps, view), lieTopic.id) })).body.view;
    const against = view.statements.filter((s) => s.contradictedBy.length > 0);
    expect(against.length).toBeGreaterThan(0);
    expect(against[0]!.person).toBe(personOf(archivePass, caught.suspect));
    for (const handle of against[0]!.contradictedBy) expect(view.evidence.map((e) => e.handle)).toContain(handle);
    expect(Object.keys(against[0]!).sort()).toEqual(["contradictedBy", "key", "person", "text", "turn"]);
  });

  it("gives a topic heard before again in the other language, at no cost, and keeps the transcript as it was first heard", async () => {
    const { act, start } = server();
    let view = await start(archivePass.id);
    const first = await act(view, "ask", { topic: "T1", language: "en" });
    view = first.body.view;
    expect(first.body.ask).toMatchObject({ replayed: false, recorded: true, shown: { language: "en", source: "rendered" } });
    expect(first.body.ask!.shown!.line).toBe(view.transcript[0]!.line);
    const again = await act(view, "ask", { topic: "T1", language: "zh" });
    expect(again.status).toBe(200);
    // The answer as shown now is the Chinese one …
    expect(again.body.ask).toMatchObject({ replayed: true, recorded: true, shown: { person: view.transcript[0]!.person, language: "zh" } });
    expect(again.body.ask!.shown!.line).toMatch(/[一-鿿]/);
    expect(again.body.ask!.shown!.line).not.toBe(view.transcript[0]!.line);
    // … nothing was used, nothing changed, and the revision did not move.
    expect(again.body.view).toEqual(view);
  });

  it("a right name without the proof is right but unproven, and a wrong name is wrong: the scorer decides", async () => {
    const { act, start } = server();
    const a = await start(lighthouse.id);
    const early = (await act(a, "accuse", { person: personOf(lighthouse, lighthouse.culprit.suspect), evidence: a.evidence.map((e) => e.handle) })).body.view;
    expect(early.verdict!.outcome).toBe("right-but-unproven");
    expect(early.verdict!.open.length).toBeGreaterThan(0);
    expect(early.verdict!.open.every((p) => /^P\d+$/.test(p))).toBe(true);
    const b = await start(lighthouse.id);
    const other = lighthouse.suspects.find((s) => s.id !== lighthouse.culprit.suspect)!.id;
    const wrong = (await act(b, "accuse", { person: personOf(lighthouse, other), evidence: [] })).body.view;
    expect(wrong.verdict!.outcome).toBe("wrong");
    // The reveal is the same truth either way.
    expect(wrong.reveal!.culprit).toBe(personOf(lighthouse, lighthouse.culprit.suspect));
  });

  it("a question in the player's own words is not asked, and uses nothing", async () => {
    const { act, call, start } = server();
    const view = await start(archivePass.id);
    const r = await act<ApiError>(view, "ask", { person: "P1", question: "Where were you?" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("model-off");
    expect((await call("GET", `/api/sessions/${view.session}`)).body.view).toEqual(view);
  });
});

describe("who may touch a session", () => {
  it("gives a visitor a secret in a cookie the page cannot read, once, and keeps only its hash", async () => {
    const { call, deps } = server();
    const secret = `${"0".repeat(63)}1`;
    const first = await call("POST", "/api/sessions", { caseId: archivePass.id });
    expect(first.headers.get("set-cookie")).toBe(`${VISITOR_COOKIE}=${secret}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=604800`);
    // Over https it is also marked Secure.
    const fresh = server();
    expect((await fresh.call("POST", "/api/sessions", { caseId: archivePass.id }, { https: true })).headers.get("set-cookie")).toMatch(/; Secure$/);
    // A visitor who already has one keeps it, with its term renewed, and owns both sessions.
    const second = await call("POST", "/api/sessions", { caseId: lighthouse.id });
    expect(second.headers.get("set-cookie")).toBe(first.headers.get("set-cookie"));
    const records = [await stored(deps, first.body.view), await stored(deps, second.body.view)];
    expect(records[0]!.owner).toBe(records[1]!.owner);
    // The secret is nowhere in what is kept, nor in any body; nor is its hash in a body.
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(first.raw).not.toContain(secret);
    expect(first.raw).not.toContain(records[0]!.owner);
    // The session's id, which is in the path and the view, is a locator and nothing more.
    expect(records[0]!.session.id).toBe(first.body.view.session);
    expect(first.body.view.session).not.toBe(secret);
  });

  it("a session asked for by anyone else answers exactly like one that does not exist, and is not touched", async () => {
    const { visitor, start, act, call } = server();
    const view = await start(lighthouse.id);
    const at = `/api/sessions/${view.session}`;
    const stranger = visitor();
    await stranger.start(archivePass.id); // The stranger has a cookie of their own.
    const nobody = await stranger.call("GET", "/api/sessions/00000000-0000-4000-8000-999999999999");
    expect(nobody.status).toBe(404);
    for (const r of [
      await stranger.call("GET", at),
      await stranger.call("GET", at, undefined, { cookie: null }),
      await stranger.call("GET", at, undefined, { cookie: `${VISITOR_COOKIE}=not-a-secret` }),
      await stranger.call("GET", at, undefined, { cookie: `${VISITOR_COOKIE}=${"f".repeat(64)}` }),
      await stranger.call("GET", at, undefined, { cookie: `other=${"0".repeat(63)}1` }),
      await stranger.call("POST", `${at}/inspect`, { revision: view.revision, inspection: "I1" }),
      await stranger.call("POST", `${at}/accuse`, { revision: view.revision, person: "P1", evidence: [] }),
      await stranger.call("GET", "/api/sessions/whatever"),
    ]) {
      expect(r.raw).toBe(nobody.raw);
    }
    // The owner's session is as it was, and the owner still plays it.
    expect((await call("GET", at)).body.view).toEqual(view);
    expect((await act(view, "inspect", { inspection: "I1" })).status).toBe(200);
  });

  it("refuses a request to change something that comes from another site's page", async () => {
    const { call, start } = server();
    const view = await start(lighthouse.id);
    const at = `/api/sessions/${view.session}`;
    // Another site, a look-alike, the same host under another scheme or port, no origin at all, and junk.
    for (const origin of ["https://evil.example", "http://game.test.evil.example", "https://game.test", "http://game.test:8080", "http://game.test/", "http://GAME.test", null, "null", "not a url"]) {
      const r = await call<ApiError>("POST", `${at}/inspect`, { revision: view.revision, inspection: "I1" }, { origin });
      expect([r.status, r.body.error.code], String(origin)).toEqual([403, "forbidden"]);
      expect((await call<ApiError>("POST", "/api/sessions", { caseId: lighthouse.id }, { origin })).body.error.code).toBe("forbidden");
    }
    expect((await call("GET", at)).body.view).toEqual(view);
    // The game's own page is let through.
    expect((await call("POST", `${at}/inspect`, { revision: view.revision, inspection: "I1" }, { origin: "http://game.test" })).status).toBe(200);
  });

  it("a deployed server names its one public origin, and the address a request arrived at does not matter", async () => {
    // Behind a proxy the request's own URL may say http and an inner host. Only the public origin counts.
    const { call } = server({ origin: "https://alibis.example" });
    const made = await call("POST", "/api/sessions", { caseId: lighthouse.id }, { origin: "https://alibis.example" });
    expect(made.status).toBe(201);
    // The cookie is marked Secure because the public origin is https, whatever the inner hop was.
    expect(made.headers.get("set-cookie")).toMatch(/; Secure$/);
    for (const origin of ["http://game.test", "http://alibis.example", "https://alibis.example:8443", null]) {
      expect((await call<ApiError>("POST", "/api/sessions", { caseId: lighthouse.id }, { origin })).body.error.code, String(origin)).toBe("forbidden");
    }
  });

  it("reads a request's body no further than the limit, however long it claims or turns out to be", async () => {
    const { deps } = server();
    // A body with no declared length that never ends on its own: 1,000 bytes a chunk.
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1_000).fill(120));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handleRequest(new Request("http://game.test/api/sessions", { method: "POST", headers: { origin: "http://game.test" }, body: endless, duplex: "half" } as RequestInit), deps);
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error.code).toBe("bad-request");
    // It stopped a chunk or two past the 4,000-byte limit, and told the sender to stop.
    expect(pulled).toBeLessThanOrEqual(8);
    expect(cancelled).toBe(true);
    // A body that declares itself too long is refused without being read at all.
    const declared = new Request("http://game.test/api/sessions", { method: "POST", headers: { origin: "http://game.test", "content-length": String(MAX_BODY_BYTES + 1) }, body: JSON.stringify({ caseId: lighthouse.id }) });
    const early = await handleRequest(declared, deps);
    expect(early.status).toBe(400);
    expect(declared.bodyUsed).toBe(false);
  });

  it("a session ends when it is too old, and when its case has changed under it", async () => {
    let clock = 1_000;
    const old = server({ now: () => clock });
    const view = await old.start(lighthouse.id);
    clock += 24 * 60 * 60 * 1_000 - 1;
    expect((await old.call("GET", `/api/sessions/${view.session}`)).status).toBe(200);
    clock += 1;
    expect((await old.call("GET", `/api/sessions/${view.session}`)).status).toBe(404);
    expect((await old.act<ApiError>(view, "inspect", { inspection: "I1" })).status).toBe(404);

    // The library now holds another version of the case the session began on.
    const cases = [lighthouse];
    const moved = server({ cases });
    const begun = await moved.start(lighthouse.id);
    const edited: Case = { ...lighthouse, sessionCap: lighthouse.sessionCap + 1 };
    expect(caseVersion(edited)).not.toBe(caseVersion(lighthouse));
    cases[0] = edited;
    const read = await moved.call<ApiError>("GET", `/api/sessions/${begun.session}`);
    expect([read.status, read.body.error.code]).toEqual([410, "expired"]);
    const acted = await moved.act<ApiError>(begun, "inspect", { inspection: "I1" });
    expect([acted.status, acted.body.error.code]).toEqual([410, "expired"]);
    // A new session on the new version is fine.
    expect((await moved.call("POST", "/api/sessions", { caseId: lighthouse.id })).status).toBe(201);
  });
});

describe("once only", () => {
  it("a request made on a view the session has left behind is refused, and does nothing", async () => {
    const { act, call, start } = server();
    const shown = await start(lighthouse.id);
    const next = (await act(shown, "inspect", { inspection: "I1" })).body.view;
    expect(next.revision).toBe(shown.revision + 1);
    // The same click delivered again, a different action from a tab left open, and a revision from the future.
    for (const [action, body] of [
      ["inspect", { revision: shown.revision, inspection: "I1" }],
      ["inspect", { revision: shown.revision, inspection: "I2" }],
      ["ask", { revision: shown.revision, topic: "T1" }],
      ["accuse", { revision: shown.revision, person: "P1", evidence: [] }],
      ["inspect", { revision: next.revision + 1, inspection: "I2" }],
    ] as const) {
      const r = await call<ApiError>("POST", `/api/sessions/${shown.session}/${action}`, body);
      expect([r.status, r.body.error.code], JSON.stringify(body)).toEqual([409, "stale"]);
    }
    // Nothing was done: one action used, no accusation. The page reads, and goes on from there.
    const now = (await call("GET", `/api/sessions/${shown.session}`)).body.view;
    expect(now).toEqual(next);
    expect((await act(now, "inspect", { inspection: "I2" })).body.view.actions.used).toBe(2);
  });

  it("a request with no revision, or one that is not a whole number, is not read", async () => {
    const { call, start } = server();
    const view = await start(lighthouse.id);
    for (const revision of [undefined, "1", 1.5, null]) {
      const r = await call<ApiError>("POST", `/api/sessions/${view.session}/inspect`, { ...(revision === undefined ? {} : { revision }), inspection: "I1" });
      expect([r.status, r.body.error.code], String(revision)).toEqual([400, "bad-request"]);
    }
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
    const { act, call, start, visitor } = server({ metered, modelOff: false });
    const view = await start(archivePass.id);
    const at = `/api/sessions/${view.session}`;

    const first = act(view, "ask", { person: "P1", question: "Where were you at nine?" });
    await reached;
    // The same question again, another question, an inspection and an accusation: all refused, none acted on.
    for (const [action, body] of [
      ["ask", { person: "P1", question: "Where were you at nine?" }],
      ["ask", { topic: "T1" }],
      ["inspect", { inspection: "I1" }],
      ["accuse", { person: "P1", evidence: [] }],
    ] as const) {
      const r = await act<ApiError>(view, action, body);
      expect([r.status, r.body.error.code], action).toEqual([409, "busy"]);
    }
    // Reading is not blocked, and shows the session as it was last kept.
    expect((await call("GET", at)).body.view).toEqual(view);
    // A stranger cannot tell that this session is at work, or that it exists: the same bytes as for no session.
    const stranger = visitor();
    await stranger.start(archivePass.id);
    const theirs = await stranger.call("POST", `${at}/inspect`, { revision: view.revision, inspection: "I1" });
    const nothing = await stranger.call("POST", "/api/sessions/00000000-0000-4000-8000-999999999999/inspect", { revision: view.revision, inspection: "I1" });
    expect(theirs.status).toBe(404);
    expect(theirs.raw).toBe(nothing.raw);
    // Another session is not held up.
    const other = await start(archivePass.id);
    expect((await act(other, "inspect", { inspection: "I1" })).status).toBe(200);

    release();
    const done = await first;
    expect(done.status).toBe(200);
    expect(done.body.view.transcript).toHaveLength(1);
    expect(done.body.view.actions.used).toBe(1);
    expect(done.body.view.over).toBe(false);
    expect(provider.dispatched).toBe(2);
    // Free again, and a click made on the old view is now stale rather than busy.
    expect((await act<ApiError>(view, "inspect", { inspection: "I1" })).body.error.code).toBe("stale");
    expect((await act(done.body.view, "inspect", { inspection: "I1" })).status).toBe(200);
  });
});

describe("what the server says when it cannot do what was asked", () => {
  it("answers with a fixed code and a fixed sentence in both languages, and nothing else", async () => {
    const { call, start } = server();
    const view = await start(lighthouse.id);
    const at = `/api/sessions/${view.session}`;
    const rev = view.revision;
    const lockedHandle = `I${view.inspections.length + 1}`;
    const cases: [string, string, unknown, number, string][] = [
      ["GET", "/nothing", undefined, 404, "not-found"],
      ["GET", "/api/nothing", undefined, 404, "not-found"],
      ["POST", "/api/cases", {}, 405, "method"],
      ["GET", "/api/sessions", undefined, 405, "method"],
      ["DELETE", at, undefined, 405, "method"],
      ["GET", `${at}/ask`, undefined, 405, "method"],
      ["POST", `${at}/reveal`, { revision: rev }, 404, "not-found"],
      ["POST", "/api/sessions", "not json", 400, "bad-request"],
      ["POST", "/api/sessions", [], 400, "bad-request"],
      ["POST", "/api/sessions", {}, 400, "bad-request"],
      ["POST", "/api/sessions", { caseId: 7 }, 400, "bad-request"],
      ["POST", "/api/sessions", { caseId: "no-such-case" }, 404, "not-found"],
      // A body that is too large is not read, even when what it asks for is well formed.
      ["POST", "/api/sessions", { caseId: lighthouse.id, pad: "x".repeat(MAX_BODY_BYTES) }, 400, "bad-request"],
      ["GET", "/api/sessions/00000000-0000-4000-8000-999999999999", undefined, 404, "not-found"],
      ["GET", "/api/sessions/not-an-id", undefined, 404, "not-found"],
      ["POST", "/api/sessions/00000000-0000-4000-8000-999999999999/inspect", { revision: 1, inspection: "I1" }, 404, "not-found"],
      ["POST", `${at}/inspect`, { revision: rev }, 400, "bad-request"],
      ["POST", `${at}/inspect`, { revision: rev, inspection: 7 }, 400, "bad-request"],
      ["POST", `${at}/inspect`, { revision: rev, inspection: "I99" }, 404, "not-available"],
      ["POST", `${at}/inspect`, { revision: rev, inspection: lockedHandle }, 404, "not-available"],
      // The case file's own ids name nothing here.
      ["POST", `${at}/inspect`, { revision: rev, inspection: lighthouse.actions.inspections[1]!.id }, 404, "not-available"],
      ["POST", `${at}/inspect`, { revision: rev, inspection: "T1" }, 404, "not-available"],
      ["POST", `${at}/ask`, { revision: rev, topic: "T99" }, 404, "not-available"],
      ["POST", `${at}/ask`, { revision: rev, topic: lighthouse.actions.topics[0]!.id }, 404, "not-available"],
      ["POST", `${at}/ask`, { revision: rev }, 400, "bad-request"],
      ["POST", `${at}/ask`, { revision: rev, person: "P99", question: "Hello?" }, 404, "not-available"],
      ["POST", `${at}/accuse`, { revision: rev, person: "P1" }, 400, "bad-request"],
      ["POST", `${at}/accuse`, { revision: rev, person: "P1", evidence: "all" }, 400, "bad-request"],
      ["POST", `${at}/accuse`, { revision: rev, person: "P1", evidence: [7] }, 400, "bad-request"],
      ["POST", `${at}/accuse`, { revision: rev, person: "P99", evidence: [] }, 404, "not-available"],
      ["POST", `${at}/accuse`, { revision: rev, person: lighthouse.suspects[0]!.id, evidence: [] }, 404, "not-available"],
      ["POST", `${at}/accuse`, { revision: rev, person: "P1", evidence: ["E99"] }, 400, "not-held"],
      ["POST", `${at}/accuse`, { revision: rev, person: "P1", evidence: [lighthouse.evidence.at(-1)!.id] }, 400, "not-held"],
    ];
    for (const [method, path, body, status, code] of cases) {
      const r = await call<ApiError>(method, path, body);
      const what = `${method} ${path} ${JSON.stringify(body)?.slice(0, 60)}`;
      expect(r.status, what).toBe(status);
      expect(r.body.error.code, what).toBe(code);
      expect(Object.keys(r.body), what).toEqual(["error"]);
      expect(Object.keys(r.body.error), what).toEqual(["code", "text"]);
      expect(r.body.error.text.en, what).not.toMatch(/[一-鿿]/);
      expect(r.body.error.text.zh, what).toMatch(/[一-鿿]/);
      // Nothing of the case is in an error.
      for (const id of authorIds(lighthouse)) expect(r.raw, what).not.toContain(id);
    }
    // None of it changed the session.
    expect((await call("GET", at)).body.view).toEqual(view);
  });

  it("a locked thing and a thing that does not exist get the very same answer", async () => {
    const { act, start } = server();
    const view = await start(lighthouse.id);
    const a = await act(view, "inspect", { inspection: `I${view.inspections.length + 1}` });
    const b = await act(view, "inspect", { inspection: "I99" });
    expect(a.status).toBe(404);
    expect(a.raw).toBe(b.raw);
  });

  it("a topic that is still locked is not shown, cannot be asked, and opens when what it needs is held", async () => {
    // The last person's topic now needs the scene's record, which the player does not hold at the start.
    const scene = lighthouse.actions.inspections.find((i) => i.requires?.length)!;
    const gated = lighthouse.actions.topics.at(-1)!;
    const c: Case = { ...lighthouse, actions: { ...lighthouse.actions, topics: lighthouse.actions.topics.map((t) => (t.id === gated.id ? { ...t, requires: [scene.yields[0]!] } : t)) } };
    const { act, call, deps } = server({ cases: [c] });
    const opening = await call("POST", "/api/sessions", { caseId: c.id });
    let view = opening.body.view;
    expect(view.topics).toHaveLength(c.actions.topics.length - 1);
    expect(view.topics.some((t) => t.person === personOf(c, gated.suspect))).toBe(false);
    await expectNothingHidden(deps, c, opening.raw, view, "opening with a locked topic");
    // The handle it will get has no meaning yet.
    const future = `T${c.actions.topics.length}`;
    const locked = await act(view, "ask", { topic: future });
    const missing = await act(view, "ask", { topic: "T99" });
    expect(locked.status).toBe(404);
    expect(locked.raw).toBe(missing.raw);
    // Hear the keeper, read the scene: the topic opens, numbered after all the others.
    const keeper = c.actions.topics.find((t) => scene.requires!.some((need) => t.yields.includes(need)))!;
    view = (await act(view, "ask", { topic: topicOf(await stored(deps, view), keeper.id) })).body.view;
    const after = await act(view, "inspect", { inspection: inspectionOf(await stored(deps, view), scene.id) });
    view = after.body.view;
    expect(view.topics.at(-1)).toMatchObject({ handle: future, person: personOf(c, gated.suspect), heard: false });
    await expectNothingHidden(deps, c, after.raw, view, "after the scene");
    expect((await act(view, "ask", { topic: future })).status).toBe(200);
  });

  it("stops at the action cap, and still lets the player accuse", async () => {
    const short = { ...archivePass, sessionCap: 1 };
    const { act, start } = server({ cases: [short] });
    let view = await start(short.id);
    view = (await act(view, "inspect", { inspection: "I1" })).body.view;
    expect(view.actions.left).toBe(0);
    const refused = await act<ApiError>(view, "ask", { topic: "T1" });
    expect([refused.status, refused.body.error.code]).toEqual([409, "cap"]);
    expect((await act(view, "accuse", { person: "P1", evidence: [] })).body.view.over).toBe(true);
  });

  it("says it has no room when the store can keep no more", async () => {
    const full: SessionStore = { ...memorySessions(), create: async () => false };
    const { call } = server({ sessions: full });
    const r = await call<ApiError>("POST", "/api/sessions", { caseId: lighthouse.id });
    expect([r.status, r.body.error.code]).toEqual([503, "full"]);
  });

  it("says nothing of what went wrong inside when the server itself fails, and does not promise that nothing changed", async () => {
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
    const cookie = `${VISITOR_COOKIE}=${"a".repeat(64)}`;
    for (const [method, path, body] of [
      ["POST", "/api/sessions", { caseId: lighthouse.id }],
      ["GET", "/api/sessions/00000000-0000-4000-8000-000000000001", undefined],
      ["POST", "/api/sessions/00000000-0000-4000-8000-000000000001/inspect", { revision: 1, inspection: "I1" }],
    ] as const) {
      const r = await call<ApiError>(method, path, body, { cookie });
      expect(r.status).toBe(500);
      expect(r.body).toEqual({ error: { code: "server", text: { en: "Something went wrong on the server. Reload the page to see where the game stands.", zh: "服务器出了问题。请刷新页面，查看这一局的进展。" } } });
    }
  });
});

describe("the game over HTTP, with a model", () => {
  it("shows the suspect's own line for a typed question, notes the statement, and counts the cost", async () => {
    const { provider, metered } = live();
    const { act, start, deps } = server({ metered, modelOff: false });
    const view = await start(archivePass.id);
    expect(view.model).toBe("on");
    const r = await act(view, "ask", { person: "P1", question: "Where were you at nine?" });
    expect(r.status).toBe(200);
    const turn = r.body.view.transcript[0]!;
    expect(turn).toMatchObject({ n: 1, person: "P1", question: "Where were you at nine?", source: "model", language: "en" });
    expect(turn.line).toContain("Now leave me be.");
    expect(turn.noted).toBeGreaterThan(0);
    expect(Object.keys(turn).sort()).toEqual(["language", "line", "n", "noted", "person", "question", "source"]);
    expect(r.body.ask).toEqual({ replayed: false, recorded: true, shown: { person: "P1", line: turn.line, language: "en", source: "model" } });
    expect(r.body.view.statements).toHaveLength(turn.noted);
    expect(provider.dispatched).toBe(2);
    expect(r.body.view.cost.requests).toBe(2);
    expect(r.body.view.cost.nano).toBeGreaterThan(0);
    expect(r.body.view.actions.used).toBe(1);
    await expectNothingHidden(deps, archivePass, r.raw, r.body.view, "typed question");
    // The model's rejected lines and its raw replies are never part of a view.
    expect(r.raw).not.toContain("rejections");
    expect(r.raw).not.toContain("call_1");
    // The same question again is the saved turn: nothing is sent, nothing is used, the revision stays.
    const again = await act(r.body.view, "ask", { person: "P1", question: "Where were you at nine?" });
    expect(again.body.ask).toMatchObject({ replayed: true, recorded: true });
    expect(provider.dispatched).toBe(2);
    expect(again.body.view).toEqual(r.body.view);
  });

  it("refuses a question with no words or too many, before anything is sent", async () => {
    const { provider, metered } = live();
    const { act, start } = server({ metered, modelOff: false });
    const view = await start(archivePass.id);
    expect((await act<ApiError>(view, "ask", { person: "P1", question: "   " })).body.error.code).toBe("bad-question");
    expect((await act<ApiError>(view, "ask", { person: "P1", question: "x".repeat(301) })).body.error.code).toBe("bad-question");
    expect(provider.dispatched).toBe(0);
  });

  it("when the spend guard refuses, a typed question is not asked and a menu topic is worded by code; the player is told which", async () => {
    let closed = false;
    const { provider, metered } = live(wellBehaved, () => closed);
    const { act, start } = server({ metered, modelOff: false });
    let view = await start(archivePass.id);
    closed = true;
    const typed = await act(view, "ask", { person: "P1", question: "Where were you at nine?" });
    expect(typed.status).toBe(200);
    expect(typed.body.ask).toMatchObject({ replayed: false, recorded: false, notice: { code: "not-asked" } });
    expect(typed.body.ask!.shown).toBeUndefined();
    expect(typed.body.view.actions.used).toBe(0);
    expect(typed.body.view.transcript).toEqual([]);
    view = typed.body.view;
    const menu = await act(view, "ask", { topic: "T1" });
    expect(menu.body.ask).toMatchObject({ replayed: false, recorded: true, shown: { source: "rendered" }, notice: { code: "worded-by-code" } });
    expect(menu.body.view.transcript[0]).toMatchObject({ source: "rendered" });
    expect(menu.body.view.actions.used).toBe(1);
    expect(provider.dispatched).toBe(0);
    // The notices are fixed sentences: they do not carry the guard's reason.
    for (const raw of [typed.raw, menu.raw]) {
      expect(raw).not.toContain("kill-switch");
      expect(raw).not.toContain("refused");
    }
  });

  it("a session that began with the model off stays off, even when the server's model is on later", async () => {
    const { provider, metered } = live();
    const sessions = memorySessions();
    const off = server({ sessions, metered, modelOff: true });
    const view = await off.start(archivePass.id);
    expect(view.model).toBe("off");
    // The same store and the same visitor, behind a server whose model is on.
    const on: ApiDeps = { ...off.deps, modelOff: false };
    const ask = (body: Record<string, unknown>) =>
      handleRequest(new Request(`http://game.test/api/sessions/${view.session}/ask`, { method: "POST", headers: { cookie: off.cookie()!, origin: "http://game.test" }, body: JSON.stringify({ revision: view.revision, ...body }) }), on);
    const typed = await ask({ person: "P1", question: "Where were you at nine?" });
    expect(typed.status).toBe(409);
    expect(((await typed.json()) as ApiError).error.code).toBe("model-off");
    const menu = (await (await ask({ topic: "T1" })).json()) as ViewReply;
    expect(menu.view.model).toBe("off");
    expect(menu.view.transcript[0]!.source).toBe("rendered");
    expect(menu.ask!.notice).toBeUndefined();
    expect(provider.dispatched).toBe(0);
    // And a session that began live is off while the server's model is off.
    const began = server({ sessions, metered, modelOff: false });
    const liveView = await began.start(archivePass.id);
    expect(liveView.model).toBe("on");
    const later = await handleRequest(new Request(`http://game.test/api/sessions/${liveView.session}`, { headers: { cookie: began.cookie()! } }), { ...began.deps, modelOff: true });
    expect(((await later.json()) as ViewReply).view.model).toBe("off");
  });
});

describe("sessions in memory", () => {
  const blank = (id: string, createdAt = 0, over = false): SessionRecord => ({
    session: { id, caseId: "c", actions: 0, evidence: [], inspections: [], asked: 0, turns: [], ...(over ? { verdict: { accused: "s", cited: [], outcome: "wrong" as const, missing: [], open: [], accusedRuledOut: false, actions: 0 } } : {}) },
    owner: "o",
    revision: 1,
    mode: "off",
    caseVersion: "v",
    topics: [],
    inspections: [],
    createdAt,
  });

  it("keeps what the work returns, keeps nothing when it throws, and lets go either way", async () => {
    const store = memorySessions({ now: () => 0 });
    expect(await store.create(blank("a"))).toBe(true);
    expect(await store.update("a", "o", async (r) => ({ record: { ...r, revision: 2 }, value: "done" }))).toEqual({ ok: true, value: "done" });
    expect((await store.read("a"))!.revision).toBe(2);
    await expect(store.update("a", "o", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect((await store.read("a"))!.revision).toBe(2);
    expect(await store.update("a", "o", async (r) => ({ record: r, value: 1 }))).toEqual({ ok: true, value: 1 });
    expect(await store.update("nobody", "o", async (r) => ({ record: r, value: 1 }))).toEqual({ ok: false, why: "missing" });
    expect(await store.read("nobody")).toBeNull();
  });

  it("to anyone but its owner a session is missing, even while it is at work; only the owner hears that it is busy", async () => {
    const store = memorySessions({ now: () => 0 });
    await store.create(blank("a"));
    let ran = false;
    expect(await store.update("a", "someone-else", async (r) => ((ran = true), { record: r, value: 1 }))).toEqual({ ok: false, why: "missing" });
    expect(ran).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const working = store.update("a", "o", async (r) => {
      await gate;
      return { record: r, value: null };
    });
    expect(await store.update("a", "someone-else", async (r) => ({ record: r, value: 1 }))).toEqual({ ok: false, why: "missing" });
    expect(await store.update("a", "o", async (r) => ({ record: r, value: 1 }))).toEqual({ ok: false, why: "busy" });
    release();
    await working;
  });

  it("when full, makes room only from games that are over; a game someone is still playing is never dropped", async () => {
    let clock = 0;
    const store = memorySessions({ max: 2, ttlMs: 1_000, now: () => clock });
    await store.create(blank("a"));
    await store.create(blank("b"));
    // Both are unfinished and unexpired. Nobody is acting on either: their players are thinking. A third is refused.
    expect(await store.create(blank("c"))).toBe(false);
    expect(await store.read("a")).not.toBeNull();
    expect(await store.read("b")).not.toBeNull();
    expect(await store.read("c")).toBeNull();
    // "b" ends with an accusation: it is the one that makes room, though "a" is older.
    await store.update("b", "o", async (r) => ({ record: { ...r, session: blank("b", 0, true).session }, value: null }));
    expect(await store.create(blank("c"))).toBe(true);
    expect(await store.read("a")).not.toBeNull();
    expect(await store.read("b")).toBeNull();
    // Full again with two unfinished games; when "a" expires it makes room.
    expect(await store.create(blank("d", clock))).toBe(false);
    clock = 1_000;
    expect(await store.create(blank("d", clock))).toBe(true);
    expect(await store.read("a")).toBeNull();
    // A finished game that is at work is not dropped out from under its request.
    const two = memorySessions({ max: 1, now: () => 0 });
    await two.create(blank("x", 0, true));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const working = two.update("x", "o", async (r) => {
      await gate;
      return { record: r, value: null };
    });
    expect(await two.create(blank("y"))).toBe(false);
    release();
    await working;
    expect(await two.create(blank("y"))).toBe(true);
  });

  it("forgets a session when its time is up", async () => {
    let clock = 0;
    const store = memorySessions({ ttlMs: 100, now: () => clock });
    await store.create(blank("a", 0));
    clock = 99;
    expect(await store.read("a")).not.toBeNull();
    clock = 100;
    expect(await store.read("a")).toBeNull();
    expect(await store.update("a", "o", async (r) => ({ record: r, value: 1 }))).toEqual({ ok: false, why: "missing" });
  });
});
