import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DetectiveReply } from "../src/agents/detective";
import { archivePass } from "../src/case/fixtures/archive";
import { createMetered, type TraceEvent } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderRequest, ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore } from "../src/spend/store";
import { lighthousePeople, lighthouseSkeleton } from "../src/writer/fixtures/lighthouse";
import { detectivePath, gamePath, pilotTotals, planPilot, runCounts, runPilot, savedCase, savedGame, type PilotConfig } from "../src/writer/pilot";
import type { SavedReply, StoredAttempt } from "../src/writer/trial";

const usage = { inputTokens: 1_000, cachedTokens: 0, outputTokens: 500 };
const done = (value: unknown): ProviderResponse => ({ text: JSON.stringify(value), toolCalls: [], usage, finishReason: "stop" });
const names = (list: string) => list.split(/, | and /).map((n) => n.trim()).filter(Boolean);

/**
 * A detective that reads only what it is shown, the way a careful player would: hear the
 * keeper named in the note, inspect every record, then accuse the one person who was at the
 * scene, holds the means and has a motive, citing everything. It uses no knowledge of the
 * case beyond the text of its two messages.
 */
function readingDetective(request: ProviderRequest): ProviderResponse {
  const brief = request.messages[0]!.content.split("\n");
  const lines = request.messages[1]!.content.split("\n");
  const act = (a: Record<string, unknown>) => done({ action: "accuse", topic: "none", inspection: "none", person: "none", cite: [], ...a });
  const note = lines.find((l) => l.includes(" is kept by "))!;
  const keeper = /is kept by (.+?)\. Hear/.exec(note)![1]!;
  const topic = lines.find((l) => /^- T\d+: ask /.test(l) && l.includes(`ask ${keeper}:`));
  if (topic) return act({ action: "ask", topic: topic.slice(2, topic.indexOf(":")) });
  const inspection = lines.find((l) => /^- I\d+: /.test(l));
  if (inspection) return act({ action: "inspect", inspection: inspection.slice(2, inspection.indexOf(":")) });

  const records = lines.filter((l) => /^- R\d+: /.test(l));
  const scene = /who was in the (.+?) is kept by/.exec(note)![1]!;
  const present = names(/\d\d:\d\d: (.+?) (?:was|were) here\./.exec(records.find((l) => l.toLowerCase().includes(`: ${scene}, `) && l.includes("here."))!)![1]!);
  const holders = names(/held by (.+?)\. Nobody else/.exec(records.find((l) => l.includes("held by"))!)![1]!);
  const motivated = records.filter((l) => l.includes("This is true of ")).flatMap((l) => names(/This is true of (.+?)\.$/.exec(l)![1]!));
  const culprit = present.filter((n) => holders.includes(n) && motivated.includes(n));
  const person = brief.find((l) => /^- P\d+: /.test(l) && l.includes(`: ${culprit[0]},`))!;
  return act({ action: "accuse", person: person.slice(2, person.indexOf(":")), cite: records.map((l) => l.slice(2, l.indexOf(":"))) });
}

function setup(options: { detective?: (request: ProviderRequest) => ProviderResponse; fail?: (request: ProviderRequest, index: number) => boolean; killSwitch?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pilot-"));
  const config: PilotConfig = { attempts: [1, 2].map((n) => ({ id: `p-${n}`, theme: `theme ${n}` })), suspects: 20, rooms: 5, dir, maxTurns: 27 };
  const provider = new FakeProvider((request, index) => {
    if (options.fail?.(request, index)) throw new Error("socket closed");
    if (request.responseSchema?.name === "case_skeleton") return done(lighthouseSkeleton);
    if (request.responseSchema?.name === "case_people") return done(lighthousePeople);
    return (options.detective ?? readingDetective)(request);
  });
  const trace: TraceEvent[] = [];
  const metered = createMetered({
    inputBound: { tokensPerByte: 100 },
    provider,
    store: new MemorySpendStore(),
    envelope: "e",
    limitNano: usdToNano(5),
    trace: (e) => trace.push(e),
    ...(options.killSwitch ? { killSwitch: options.killSwitch } : {}),
  });
  const stored = (): StoredAttempt[] => trace.filter((e) => ["settled", "retained", "settle-pending"].includes(e.outcome)).map((e) => ({ attemptId: e.attemptId, state: e.outcome === "settled" ? "settled" : "retained" }));
  return { dir, config, provider, metered, stored, trace };
}
const shape = (config: PilotConfig, stored: StoredAttempt[]) => planPilot(config, stored).rows.map((r) => `${r.writer.kind}+${r.game.kind}=${r.most}`);

describe("a pilot: write a case, then let the detective play it", () => {
  it("writes two cases and solves both, reading only what a player is shown", async () => {
    const t = setup();
    expect(planPilot(t.config, t.stored())).toMatchObject({ most: 2 * (2 + 27), unresolved: [] });
    expect(shape(t.config, t.stored())).toEqual(["fresh+play=29", "fresh+play=29"]);

    const run = await runPilot(t.config, { metered: t.metered, stored: t.stored() });
    expect(run.blocked).toBe(false);
    expect(run.stoppedBy).toBeUndefined();
    expect(runCounts(run)).toEqual({ attempted: 2, accepted: 2, played: 2, solved: 2 });
    for (const entry of run.entries) {
      expect(entry.writer).toMatchObject({ accepted: true, requests: 2 });
      // Hear the keeper, inspect the five rooms, accuse: seven turns.
      expect(entry.game).toMatchObject({ outcome: "solved", turns: 7, actions: 6, requests: 7 });
      expect(entry.game!.verdict).toMatchObject({ outcome: "solved", missing: [], open: [] });
    }
    expect(t.provider.dispatched).toBe(2 * (2 + 7));
    // The detective's request ids are the game's.
    expect(t.trace.filter((e) => e.attemptId.startsWith("p-1:d")).map((e) => e.attemptId)).toEqual(["p-1:d1", "p-1:d2", "p-1:d3", "p-1:d4", "p-1:d5", "p-1:d6", "p-1:d7"]);

    // Afterwards nothing is left to send, and a second run sends nothing.
    expect(planPilot(t.config, t.stored()).most).toBe(0);
    expect(shape(t.config, t.stored())).toEqual(["closed+closed=0", "closed+closed=0"]);
    expect((await runPilot(t.config, { metered: t.metered, stored: t.stored() })).entries).toEqual([]);
    expect(t.provider.dispatched).toBe(18);
  });

  it("saves every reply of the writer and the detective, and what each game came to", async () => {
    const t = setup();
    await runPilot(t.config, { metered: t.metered, stored: t.stored() });
    expect(readdirSync(t.dir).sort()).toEqual(["p-1", "p-2"].flatMap((id) => [`${id}.detective.json`, `${id}.game.json`, `${id}.json`, `${id}.people.json`, `${id}.skeleton.json`]));
    const replies = JSON.parse(readFileSync(detectivePath(t.config, "p-1"), "utf8")) as DetectiveReply[];
    expect(replies.map((r) => [r.attemptId, r.turn, r.finishReason, r.settled])).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => [`p-1:d${n}`, n, "stop", true]));
    expect(JSON.parse(replies[0]!.text!)).toMatchObject({ action: "ask" });
    expect(JSON.parse(replies[6]!.text!)).toMatchObject({ action: "accuse" });
    const game = JSON.parse(readFileSync(gamePath(t.config, "p-1"), "utf8")) as { outcome: string; turns: number; steps: unknown[] };
    expect(game).toMatchObject({ outcome: "solved", turns: 7 });
    expect(game.steps).toHaveLength(7);
  });

  it("keeps the four counts apart: a case that is accepted and played is not thereby solved", async () => {
    // A detective that accuses the first person at once, citing nothing.
    const hasty = (): ProviderResponse => done({ action: "accuse", topic: "none", inspection: "none", person: "P1", cite: [] });
    const t = setup({ detective: hasty });
    const run = await runPilot(t.config, { metered: t.metered, stored: t.stored() });
    const counts = runCounts(run);
    expect(counts).toMatchObject({ attempted: 2, accepted: 2, played: 2 });
    expect(counts.solved).toBe(0);
    expect(run.entries.map((e) => e.game!.outcome).every((o) => o === "wrong" || o === "right-but-unproven")).toBe(true);
  });

  it("stops at a detective request that does not come back, and blocks until it is reconciled", async () => {
    // The third detective request of the first game fails.
    let detectiveRequests = 0;
    const t = setup({ fail: (request) => request.responseSchema?.name === "detective_action" && ++detectiveRequests === 3 });
    const run = await runPilot(t.config, { metered: t.metered, stored: t.stored() });
    expect(run.stoppedBy).toBe("failed:outcome-unknown");
    expect(run.entries.map((e) => e.attempt.id)).toEqual(["p-1"]);
    expect(run.entries[0]!.game).toMatchObject({ outcome: "no-accusation", turns: 3, problem: "failed:outcome-unknown" });
    // A game that ended on a problem is not counted as played.
    expect(runCounts(run)).toEqual({ attempted: 1, accepted: 1, played: 0, solved: 0 });
    expect(t.provider.dispatched).toBe(2 + 3);
    const plan = planPilot(t.config, t.stored());
    expect(plan.unresolved).toEqual([{ attemptId: "p-1:d3", state: "retained" }]);
    expect(plan.most).toBe(0);
    expect(await runPilot(t.config, { metered: t.metered, stored: t.stored() })).toEqual({ entries: [], blocked: true });
    expect(t.provider.dispatched).toBe(5);
  });

  it("plays a saved accepted case in a later run, and never starts a game twice", async () => {
    // The first run is cut short by the spend guard right after the first case is written.
    let sent = 0;
    const t = setup({ killSwitch: () => sent >= 2 });
    const original = t.provider.send.bind(t.provider);
    t.provider.send = async (body: string) => {
      sent++;
      return original(body);
    };
    const first = await runPilot(t.config, { metered: t.metered, stored: t.stored() });
    expect(first.stoppedBy).toBe("refused:kill-switch");
    expect(first.entries[0]).toMatchObject({ writer: { accepted: true }, game: { outcome: "no-accusation", requests: 0 } });
    expect(t.provider.dispatched).toBe(2);
    // The case is saved and accepted, and no game request went out: the plan offers the game, with no writer request.
    expect(shape(t.config, t.stored())).toEqual(["closed+play=27", "fresh+play=29"]);

    const open = createMetered({ inputBound: { tokensPerByte: 100 }, provider: t.provider, store: new MemorySpendStore(), envelope: "e2", limitNano: usdToNano(5), trace: (e) => t.trace.push(e) });
    const second = await runPilot(t.config, { metered: open, stored: t.stored() });
    expect(second.entries.map((e) => [e.attempt.id, e.writer?.requests ?? 0, e.game?.outcome])).toEqual([
      ["p-1", 0, "solved"],
      ["p-2", 2, "solved"],
    ]);
    // Both games have now been started: neither can be started again.
    expect(shape(t.config, t.stored())).toEqual(["closed+closed=0", "closed+closed=0"]);
  });

  it("does not take any saved file at its word: a case is made again from the saved replies, and only if the store shows both were settled", async () => {
    // The first case is written and saved, and no game request goes out.
    let sent = 0;
    const t = setup({ killSwitch: () => sent >= 2 });
    const original = t.provider.send.bind(t.provider);
    t.provider.send = async (body: string) => {
      sent++;
      return original(body);
    };
    await runPilot(t.config, { metered: t.metered, stored: t.stored() });
    const stored = t.stored();
    expect(shape(t.config, stored)[0]).toBe("closed+play=27");
    const attempt = t.config.attempts[0]!;
    const why = (records: StoredAttempt[] = stored) => {
      const saved = savedCase(t.config, attempt, records);
      return saved.ok ? "ok" : saved.why;
    };
    expect(why()).toBe("ok");

    // The report file is a convenience. A valid case of entirely different people planted in it changes nothing.
    const reportFile = `${t.dir}/p-1.json`;
    const report = readFileSync(reportFile, "utf8");
    writeFileSync(reportFile, JSON.stringify({ accepted: true, case: { ...archivePass, id: "p-1" } }));
    const rebuilt = savedCase(t.config, attempt, stored);
    expect(rebuilt.ok && rebuilt.c.suspects).toHaveLength(20);
    expect(rebuilt.ok && rebuilt.c.title.en).toBe("The Lamp Went Out");
    writeFileSync(reportFile, report);

    // The store must show both requests settled. With only the skeleton, or only the people request, there is no case.
    expect(why(stored.filter((a) => a.attemptId !== "p-1:people"))).toBe("the store has no settled people request for this attempt");
    expect(why(stored.filter((a) => a.attemptId !== "p-1:skeleton"))).toBe("the store has no settled skeleton request for this attempt");
    expect(why(stored.map((a) => (a.attemptId === "p-1:people" ? { ...a, state: "retained" } : a)))).toBe("the store has no settled people request for this attempt");
    // With the skeleton saved and the people request never sent, the honest next step is to send the people request.
    expect(shape(t.config, [{ attemptId: "p-1:skeleton", state: "settled" }])[0]).toBe("resume+play=28");
    // The case that was reported: a folder holding nothing but a planted report, and a store that shows a skeleton
    // request. No reply is saved, so there is nothing to make a case from, and no game is offered. The same with
    // both writer requests in the store, or only the people request.
    const planted = setup();
    writeFileSync(`${planted.dir}/p-1.json`, JSON.stringify({ accepted: true, case: { ...archivePass, id: "p-1" } }));
    for (const ids of [["p-1:skeleton"], ["p-1:skeleton", "p-1:people"], ["p-1:people"]]) {
      const records = ids.map((attemptId) => ({ attemptId, state: "settled" }));
      expect(shape(planted.config, records)[0], ids.join("+")).toBe("closed+closed=0");
      expect(await pilotTotals(planted.config, records), ids.join("+")).toMatchObject({ accepted: 0, played: 0, solved: 0 });
    }

    // Each saved reply is checked, and the two must belong together.
    const tamper = (stage: "skeleton" | "people", change: (reply: SavedReply) => void) => {
      const path = `${t.dir}/p-1.${stage}.json`;
      const good = readFileSync(path, "utf8");
      const copy = JSON.parse(good) as SavedReply;
      change(copy);
      writeFileSync(path, JSON.stringify(copy));
      const result = why();
      writeFileSync(path, good);
      return result;
    };
    expect(tamper("people", (r) => (r.attemptId = "p-2:people"))).toBe("the saved people reply belongs to another attempt");
    expect(tamper("people", (r) => (r.settled = false))).toBe("the saved people reply's cost was not confirmed");
    expect(tamper("people", (r) => (r.finishReason = "content_filter"))).toBe("the saved people reply did not end normally");
    expect(tamper("people", (r) => (r.salt = "another-salt"))).toBe("the two saved replies do not carry the same salt");
    expect(tamper("skeleton", (r) => (r.salt = "another-salt"))).toBe("the two saved replies do not carry the same salt");
    expect(tamper("people", (r) => (r.shown = [...r.shown!].reverse()))).toBe("the saved people reply was not written against this skeleton's order");
    expect(tamper("people", (r) => (r.shuffleVersion = 0))).toBe("the saved replies were written under another reordering rule");
    // A people reply that no longer gives a fair case: put a second person with means and motive at the scene.
    expect(
      tamper("people", (r) => {
        const people = JSON.parse(r.text!) as { suspects: { id: string; whereabouts: unknown }[] };
        people.suspects.find((s) => s.id === "s-01")!.whereabouts = people.suspects.find((s) => s.id === "s-03")!.whereabouts;
        r.text = JSON.stringify(people);
      }),
    ).toMatch(/^rebuilt from the saved replies, the case is refused at gate: /);
    writeFileSync(`${t.dir}/p-1.people.json`, readFileSync(`${t.dir}/p-1.people.json`, "utf8").slice(0, 300));
    expect(why()).toBe("the saved people reply file is damaged");
  });

  it("two runs at once cannot send a request twice, and the one that lost writes over nothing", async () => {
    const t = setup();
    // The winner runs to the end.
    const winner = await runPilot(t.config, { metered: t.metered, stored: [] });
    expect(runCounts(winner)).toEqual({ attempted: 2, accepted: 2, played: 2, solved: 2 });
    const files = () => Object.fromEntries(readdirSync(t.dir).sort().map((name) => [name, readFileSync(`${t.dir}/${name}`, "utf8")]));
    const before = files();
    const sentBefore = t.provider.dispatched;

    // The loser made its plan before the winner had sent anything, so it believes everything is still to do.
    const loser = await runPilot(t.config, { metered: t.metered, stored: [] });
    expect(loser.stoppedBy).toBe("refused:duplicate-attempt");
    expect(t.provider.dispatched).toBe(sentBefore);
    expect(runCounts(loser)).toEqual({ attempted: 0, accepted: 0, played: 0, solved: 0 });
    // Not one saved file changed: not the reports, not the replies.
    expect(files()).toEqual(before);
    expect(await pilotTotals(t.config, t.stored())).toMatchObject({ attempted: 2, accepted: 2, played: 2, solved: 2 });

    // The same holds when the loser is refused at the game: it believes the cases are written and the games are not.
    const writersOnly = t.stored().filter((a) => !a.attemptId.includes(":d"));
    const late = await runPilot(t.config, { metered: t.metered, stored: writersOnly });
    expect(late.stoppedBy).toBe("refused:duplicate-attempt");
    expect(late.entries[0]!.game).toMatchObject({ outcome: "no-accusation", requests: 0 });
    expect(t.provider.dispatched).toBe(sentBefore);
    expect(files()).toEqual(before);
  });

  it("gives the same totals for the pilot whichever run asks, rebuilt from the saved replies and the store", async () => {
    // Nothing sent yet, and a run that is refused before anything is sent.
    const closed = setup({ killSwitch: () => true });
    expect(await pilotTotals(closed.config, closed.stored())).toMatchObject({ attempted: 0, accepted: 0, played: 0, solved: 0 });
    const refused = await runPilot(closed.config, { metered: closed.metered, stored: closed.stored() });
    expect(refused.stoppedBy).toBe("refused:kill-switch");
    expect(runCounts(refused)).toEqual({ attempted: 0, accepted: 0, played: 0, solved: 0 });
    expect(readdirSync(closed.dir)).toEqual([]);
    expect(await pilotTotals(closed.config, closed.stored())).toMatchObject({ attempted: 0, accepted: 0, played: 0, solved: 0 });

    // A first run is cut short after the first case is written; a second run plays that case and does the rest.
    let sent = 0;
    const t = setup({ killSwitch: () => sent >= 2 });
    const original = t.provider.send.bind(t.provider);
    t.provider.send = async (body: string) => {
      sent++;
      return original(body);
    };
    const first = await runPilot(t.config, { metered: t.metered, stored: t.stored() });
    expect(runCounts(first)).toEqual({ attempted: 1, accepted: 1, played: 0, solved: 0 });
    expect(await pilotTotals(t.config, t.stored())).toMatchObject({ attempted: 1, accepted: 1, played: 0, solved: 0 });

    const open = createMetered({ inputBound: { tokensPerByte: 100 }, provider: t.provider, store: new MemorySpendStore(), envelope: "e2", limitNano: usdToNano(5), trace: (e) => t.trace.push(e) });
    const second = await runPilot(t.config, { metered: open, stored: t.stored() });
    // What the second run did: one case written, two games played. It did not write the first case.
    expect(runCounts(second)).toEqual({ attempted: 1, accepted: 1, played: 2, solved: 2 });
    // What the pilot stands at, after both runs.
    const totals = await pilotTotals(t.config, t.stored());
    expect(totals).toMatchObject({ attempted: 2, accepted: 2, played: 2, solved: 2 });
    expect(totals.rows.map((r) => [r.id, r.game, r.turns])).toEqual([
      ["p-1", "solved", 7],
      ["p-2", "solved", 7],
    ]);
    // A third run sends nothing and the totals do not move.
    expect((await runPilot(t.config, { metered: open, stored: t.stored() })).entries).toEqual([]);
    expect(await pilotTotals(t.config, t.stored())).toMatchObject({ attempted: 2, accepted: 2, played: 2, solved: 2 });
  });

  it("works a game's result out again from the saved detective replies, not from the game's report", async () => {
    const t = setup();
    await runPilot(t.config, { metered: t.metered, stored: t.stored() });
    const stored = t.stored();
    const attempt = t.config.attempts[0]!;
    const c = savedCase(t.config, attempt, stored);
    if (!c.ok) throw new Error(c.why);
    const again = await savedGame(t.config, attempt, c.c, stored);
    expect(again.ok && again.game).toMatchObject({ outcome: "solved", turns: 7, actions: 6 });

    // A report file that claims a win it did not earn is not read at all.
    writeFileSync(gamePath(t.config, "p-2"), JSON.stringify({ outcome: "solved" }));
    const path = detectivePath(t.config, "p-2");
    const good = readFileSync(path, "utf8");
    const replies = JSON.parse(good) as DetectiveReply[];
    const state = async (change: (list: DetectiveReply[]) => DetectiveReply[], records = stored) => {
      writeFileSync(path, JSON.stringify(change(JSON.parse(good) as DetectiveReply[])));
      const totals = await pilotTotals(t.config, records);
      writeFileSync(path, good);
      const row = totals.rows.find((r) => r.id === "p-2")!;
      return `${row.game}: ${row.note}`;
    };
    expect(await state((list) => list)).toBe("solved: ");
    // The last reply changed to accuse someone else: the scorer, run again, does not say solved.
    expect(await state((list) => [...list.slice(0, -1), { ...list.at(-1)!, text: JSON.stringify({ ...(JSON.parse(list.at(-1)!.text!) as object), person: "P1", cite: [] }) }])).toMatch(/^(wrong|right-but-unproven): $/);
    // Replies missing, out of order, another game's, or unconfirmed: the game is not counted.
    expect(await state((list) => list.slice(0, 3))).toBe("not played: the store knows of a later turn whose reply was not saved");
    expect(await state((list) => [list[1]!, list[0]!, ...list.slice(2)])).toBe("not played: saved detective reply 1 is not this game's turn 1");
    expect(await state((list) => list.map((r) => ({ ...r, attemptId: r.attemptId.replace("p-2", "p-1") })))).toBe("not played: saved detective reply 1 is not this game's turn 1");
    expect(await state((list) => list.map((r, i) => (i === 2 ? { ...r, settled: false } : r)))).toBe("not played: the cost of detective reply 3 is not confirmed");
    expect(await state((list) => list, stored.filter((a) => a.attemptId !== "p-2:d4"))).toBe("not played: the cost of detective reply 4 is not confirmed");
    expect(await state(() => [])).toBe("not played: the saved detective replies are damaged");
    expect(replies).toHaveLength(7);
  });

  it("does not play a case the gates refused", async () => {
    const t = setup();
    // The people stage puts a second person with means and motive at the scene: the gate refuses the case.
    const ids = ["s-01", "s-03"];
    const lamp = lighthousePeople.suspects.find((s) => s.id === "s-03")!.whereabouts;
    const twoFit = { ...lighthousePeople, suspects: lighthousePeople.suspects.map((s) => (ids.includes(s.id) ? { ...s, whereabouts: lamp } : s)) };
    const provider = new FakeProvider((request) => (request.responseSchema?.name === "case_skeleton" ? done(lighthouseSkeleton) : request.responseSchema?.name === "case_people" ? done(twoFit) : readingDetective(request)));
    const metered = createMetered({ inputBound: { tokensPerByte: 100 }, provider, store: new MemorySpendStore(), envelope: "e", limitNano: usdToNano(5), trace: (e) => t.trace.push(e) });
    const run = await runPilot(t.config, { metered, stored: [] });
    expect(runCounts(run)).toEqual({ attempted: 2, accepted: 0, played: 0, solved: 0 });
    expect(run.entries.every((e) => e.writer!.failedAt === "gate" && e.game === undefined)).toBe(true);
    expect(provider.dispatched).toBe(4);
    expect(shape(t.config, t.stored())).toEqual(["closed+closed=0", "closed+closed=0"]);
  });
});
