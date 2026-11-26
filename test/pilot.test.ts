import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DetectiveReply } from "../src/agents/detective";
import { createMetered, type TraceEvent } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderRequest, ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore } from "../src/spend/store";
import { lighthousePeople, lighthouseSkeleton } from "../src/writer/fixtures/lighthouse";
import { detectivePath, gamePath, pilotCounts, planPilot, runPilot, type PilotConfig } from "../src/writer/pilot";
import type { StoredAttempt } from "../src/writer/trial";

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
    expect(pilotCounts(run)).toEqual({ attempted: 2, accepted: 2, played: 2, solved: 2 });
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
    const counts = pilotCounts(run);
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
    expect(pilotCounts(run)).toEqual({ attempted: 1, accepted: 1, played: 0, solved: 0 });
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

  it("does not take a saved case at its word: it must be this attempt's and pass the gate again", async () => {
    // As above: the first case is written and saved, and no game request goes out.
    let sent = 0;
    const t = setup({ killSwitch: () => sent >= 2 });
    const original = t.provider.send.bind(t.provider);
    t.provider.send = async (body: string) => {
      sent++;
      return original(body);
    };
    await runPilot(t.config, { metered: t.metered, stored: t.stored() });
    expect(shape(t.config, t.stored())[0]).toBe("closed+play=27");

    const path = `${t.dir}/p-1.json`;
    const good = readFileSync(path, "utf8");
    const saved = JSON.parse(good) as { accepted: boolean; case: { id: string; culprit: { suspect: string }; suspects: { id: string }[] } };
    const tamper = (change: (file: typeof saved) => void) => {
      const copy = JSON.parse(good) as typeof saved;
      change(copy);
      writeFileSync(path, JSON.stringify(copy));
      return shape(t.config, t.stored())[0];
    };
    // Another attempt's case, a case whose answer no longer fits the truth, a file that says it was not accepted, a torn file.
    expect(tamper((f) => (f.case.id = "p-2"))).toBe("closed+closed=0");
    expect(tamper((f) => (f.case.culprit.suspect = f.case.suspects.find((x) => x.id !== f.case.culprit.suspect)!.id))).toBe("closed+closed=0");
    expect(tamper((f) => (f.accepted = false))).toBe("closed+closed=0");
    writeFileSync(path, good.slice(0, 500));
    expect(shape(t.config, t.stored())[0]).toBe("closed+closed=0");
    // Put back, it is playable again.
    writeFileSync(path, good);
    expect(shape(t.config, t.stored())[0]).toBe("closed+play=27");
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
    expect(pilotCounts(run)).toEqual({ attempted: 2, accepted: 0, played: 0, solved: 0 });
    expect(run.entries.every((e) => e.writer!.failedAt === "gate" && e.game === undefined)).toBe(true);
    expect(provider.dispatched).toBe(4);
    expect(shape(t.config, t.stored())).toEqual(["closed+closed=0", "closed+closed=0"]);
  });
});
