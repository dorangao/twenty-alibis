import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMetered, type TraceEvent } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderRequest, ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore } from "../src/spend/store";
import { lighthousePeople, lighthouseSkeleton } from "../src/writer/fixtures/lighthouse";
import { planTrial, replyPath, reportPath, runTrial, savedSkeleton, writeWhole, type SavedReply, type StoredAttempt, type TrialConfig } from "../src/writer/trial";

const usage = { inputTokens: 800, cachedTokens: 0, outputTokens: 4_000 };
const skeletonText = JSON.stringify(lighthouseSkeleton);
const peopleText = JSON.stringify(lighthousePeople);
const done = (text: string | null, finishReason = "stop"): ProviderResponse => ({ text, toolCalls: [], usage, finishReason });

/** A fresh folder and a spend guard over a fake model. `stored` is what the spend store would list. */
function setup(reply: (request: ProviderRequest, index: number) => ProviderResponse, options: { killSwitch?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "writer-trial-"));
  const config: TrialConfig = { attempts: [1, 2, 3].map((n) => ({ id: `w-${n}`, theme: `theme ${n}` })), suspects: 20, rooms: 5, dir };
  const provider = new FakeProvider(reply);
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
  /** The store's durable records, as the real store would list them. */
  const stored = (): StoredAttempt[] => trace.filter((e) => e.outcome === "settled" || e.outcome === "retained" || e.outcome === "settle-pending").map((e) => ({ attemptId: e.attemptId, state: e.outcome === "settled" ? "settled" : "retained" }));
  const saved = (id: string, stage: "skeleton" | "people") => JSON.parse(readFileSync(replyPath(config, id, stage), "utf8")) as SavedReply;
  return { dir, config, provider, metered, stored, saved };
}
/** Answers a skeleton request with the handwritten skeleton and a people request with the handwritten plot. */
const good = (request: ProviderRequest): ProviderResponse => done(request.responseSchema?.name === "case_skeleton" ? skeletonText : peopleText);
const standings = (config: TrialConfig, stored: StoredAttempt[]) => planTrial(config, stored).rows.map((r) => (r.standing.kind === "closed" ? `closed: ${r.standing.why[0]}` : r.standing.kind));

describe("a writer trial: the plan and the run agree", () => {
  it("runs three fresh attempts with six requests, and afterwards has nothing left to send", async () => {
    const t = setup(good);
    expect(planTrial(t.config, t.stored())).toMatchObject({ most: 6, unresolved: [] });
    expect(standings(t.config, t.stored())).toEqual(["fresh", "fresh", "fresh"]);

    const run = await runTrial(t.config, { metered: t.metered, stored: t.stored() });
    expect(run.blocked).toBe(false);
    expect(run.stoppedBy).toBeUndefined();
    expect(run.reports.map((r) => [r.attempt.id, r.resumed, r.report.accepted, r.report.requests])).toEqual([
      ["w-1", false, true, 2],
      ["w-2", false, true, 2],
      ["w-3", false, true, 2],
    ]);
    expect(t.provider.dispatched).toBe(6);

    expect(planTrial(t.config, t.stored()).most).toBe(0);
    expect(standings(t.config, t.stored())).toEqual(Array(3).fill("closed: both requests have gone out"));
    // Run again: nothing is sent.
    expect((await runTrial(t.config, { metered: t.metered, stored: t.stored() })).reports).toEqual([]);
    expect(t.provider.dispatched).toBe(6);
  });

  it("saves each reply exactly as it arrived, with how it ended and what it answered", async () => {
    const t = setup(good);
    await runTrial(t.config, { metered: t.metered, stored: t.stored() });
    const skeleton = t.saved("w-2", "skeleton");
    expect(skeleton).toEqual({ attemptId: "w-2:skeleton", stage: "skeleton", text: skeletonText, finishReason: "stop", usage, settled: true, breached: false, salt: expect.any(String) as string, brief: { theme: "theme 2", suspects: 20, rooms: 5 }, shuffleVersion: 1 });
    const people = t.saved("w-2", "people");
    expect(people).toMatchObject({ attemptId: "w-2:people", stage: "people", text: peopleText, settled: true, shuffleVersion: 1 });
    // One attempt, one private salt, saved with both replies and with the report, and not inside the case.
    expect(skeleton.salt.length).toBeGreaterThan(20);
    expect(people.salt).toBe(skeleton.salt);
    // The people reply is saved with the order its request showed the people in: all twenty, not in the skeleton's order.
    expect([...people.shown!].sort()).toEqual(lighthouseSkeleton.suspects.map((x) => x.name.en).sort());
    expect(people.shown).not.toEqual(lighthouseSkeleton.suspects.map((x) => x.name.en));
    const whole = JSON.parse(readFileSync(reportPath(t.config, "w-2"), "utf8")) as { salt: string; case: unknown };
    expect(whole.salt).toBe(skeleton.salt);
    expect(JSON.stringify(whole.case)).not.toContain(skeleton.salt);
    // Different attempts get different salts.
    expect(t.saved("w-1", "skeleton").salt).not.toBe(skeleton.salt);
    const report = JSON.parse(readFileSync(reportPath(t.config, "w-2"), "utf8")) as { accepted: boolean; case: { suspects: unknown[] } };
    expect(report.accepted).toBe(true);
    expect(report.case.suspects).toHaveLength(20);
    // Nothing half-written is left behind.
    expect(readdirSync(t.dir).sort()).toEqual(["w-1", "w-2", "w-3"].flatMap((id) => [`${id}.json`, `${id}.people.json`, `${id}.skeleton.json`]));
  });

  it("saves a reply that was cut off, is not JSON, or is JSON null, and goes on to the next attempt", async () => {
    const replies = [done('{"suspects":', "length"), done("not json"), done("null")];
    const t = setup((_request, index) => replies[index]!);
    const run = await runTrial(t.config, { metered: t.metered, stored: t.stored() });
    expect(run.reports.map((r) => [r.report.failedAt, r.report.requests, r.report.reasons[0]])).toEqual([
      ["skeleton", 1, "the skeleton reply was cut off at the output limit"],
      ["skeleton", 1, "the skeleton reply is not JSON"],
      ["skeleton", 1, "skeleton: (the whole reply): Invalid input: expected object, received null"],
    ]);
    expect(t.saved("w-1", "skeleton")).toMatchObject({ text: '{"suspects":', finishReason: "length", settled: true });
    expect(t.saved("w-2", "skeleton")).toMatchObject({ text: "not json", finishReason: "stop" });
    expect(t.saved("w-3", "skeleton")).toMatchObject({ text: "null" });
    expect(t.provider.dispatched).toBe(3);
    // None of these can be resumed, and the plan says why for each.
    expect(standings(t.config, t.stored())).toEqual(["closed: the saved skeleton was cut off", "closed: the saved skeleton is not JSON", "closed: the saved skeleton is refused by the skeleton check: skeleton: (the whole reply): Invalid input: expected object, received null"]);
    expect(planTrial(t.config, t.stored()).most).toBe(0);
  });

  it("stops at a request that does not come back, and starts no further attempt", async () => {
    const t = setup((request, index) => {
      if (index === 1) throw new Error("socket closed");
      return good(request);
    });
    const run = await runTrial(t.config, { metered: t.metered, stored: t.stored() });
    expect(run.stoppedBy).toBe("failed:outcome-unknown");
    expect(run.reports.map((r) => r.attempt.id)).toEqual(["w-1"]);
    expect(t.provider.dispatched).toBe(2);
    // The failed request is unresolved, so nothing more is sent until it is reconciled.
    const plan = planTrial(t.config, t.stored());
    expect(plan.unresolved).toEqual([{ attemptId: "w-1:people", state: "retained" }]);
    expect(plan.most).toBe(0);
    expect(await runTrial(t.config, { metered: t.metered, stored: t.stored() })).toEqual({ reports: [], blocked: true });
    expect(t.provider.dispatched).toBe(2);
  });
});

describe("a writer trial: picking an attempt up from its saved skeleton", () => {
  /** The first run sends w-1's skeleton, then the spend guard refuses everything. */
  async function interrupted() {
    let off = false;
    const t = setup(
      (request) => {
        off = true;
        return good(request);
      },
      { killSwitch: () => off },
    );
    const first = await runTrial(t.config, { metered: t.metered, stored: t.stored() });
    expect(first.stoppedBy).toBe("refused:kill-switch");
    expect(first.reports[0]!.report).toMatchObject({ failedAt: "people", requests: 1 });
    expect(t.provider.dispatched).toBe(1);
    return { ...t, resume: () => (off = false) };
  }

  it("spends only the people request, and the plan said so", async () => {
    const t = await interrupted();
    expect(standings(t.config, t.stored())).toEqual(["resume", "fresh", "fresh"]);
    expect(planTrial(t.config, t.stored()).most).toBe(5);

    t.resume();
    // From here the guard stays open: answer every request.
    const metered = createMetered({ inputBound: { tokensPerByte: 100 }, provider: t.provider, store: new MemorySpendStore(), envelope: "e2", limitNano: usdToNano(5) });
    const run = await runTrial(t.config, { metered, stored: t.stored() });
    expect(run.reports.map((r) => [r.attempt.id, r.resumed, r.report.accepted, r.report.requests])).toEqual([
      ["w-1", true, true, 1],
      ["w-2", false, true, 2],
      ["w-3", false, true, 2],
    ]);
    expect(t.provider.dispatched).toBe(1 + 5);
    expect(run.reports[0]!.report.usage.map((u) => u.step)).toEqual(["writer.people"]);
    // The resumed attempt kept the salt its skeleton was saved with.
    expect(t.saved("w-1", "people").salt).toBe(t.saved("w-1", "skeleton").salt);
    expect(run.reports[0]!.report.salt).toBe(t.saved("w-1", "skeleton").salt);
  });

  it("refuses to resume from a file that is damaged, another attempt's, unconfirmed or no longer passes, and says which", async () => {
    const brief = { theme: "theme 1", suspects: 20, rooms: 5 };
    const record: SavedReply = { attemptId: "w-1:skeleton", stage: "skeleton", text: skeletonText, finishReason: "stop", usage, settled: true, breached: false, salt: "a-private-salt", brief, shuffleVersion: 1 };
    const why = (text: string | null) => {
      const result = savedSkeleton(text, "w-1", brief);
      return result.ok ? "ok" : result.why[0];
    };
    expect(why(JSON.stringify(record))).toBe("ok");
    expect(why(null)).toBe("the skeleton went out but its reply was not saved");
    expect(why(JSON.stringify(record).slice(0, 200))).toBe("the saved skeleton file is damaged");
    expect(why("[]")).toBe("the saved skeleton file is damaged");
    expect(why(JSON.stringify({ ...record, attemptId: "w-2:skeleton" }))).toBe("the saved skeleton belongs to another attempt");
    expect(why(JSON.stringify({ ...record, brief: { ...brief, theme: "theme 2" } }))).toBe("the saved skeleton belongs to another attempt");
    expect(why(JSON.stringify({ ...record, stage: "people" }))).toBe("the saved skeleton belongs to another attempt");
    expect(why(JSON.stringify({ ...record, settled: false }))).toBe("the saved skeleton's cost was not confirmed");
    expect(why(JSON.stringify({ ...record, breached: true }))).toBe("the saved skeleton's cost was not confirmed");
    expect(why(JSON.stringify({ ...record, finishReason: "length" }))).toBe("the saved skeleton was cut off");
    expect(why(JSON.stringify({ ...record, text: null }))).toBe("the saved skeleton was cut off");
    expect(why(JSON.stringify({ ...record, finishReason: "content_filter" }))).toBe("the saved skeleton did not end normally");
    expect(why(JSON.stringify({ ...record, finishReason: undefined }))).toBe("the saved skeleton did not end normally");
    expect(why(JSON.stringify({ ...record, text: "not json" }))).toBe("the saved skeleton is not JSON");
    const fewer = JSON.stringify({ ...lighthouseSkeleton, suspects: lighthouseSkeleton.suspects.slice(0, 19) });
    expect(why(JSON.stringify({ ...record, text: fewer }))).toBe("the saved skeleton is refused by the skeleton check: the skeleton has 19 suspects; 20 were asked for");
  });

  it("does not let one bad saved file stop the other attempts, or promise a request it will not send", async () => {
    const t = await interrupted();
    // The saved skeleton of w-1 is torn in half on disk.
    const path = replyPath(t.config, "w-1", "skeleton");
    writeFileSync(path, readFileSync(path, "utf8").slice(0, 300));
    expect(standings(t.config, t.stored())).toEqual(["closed: the saved skeleton file is damaged", "fresh", "fresh"]);
    expect(planTrial(t.config, t.stored()).most).toBe(4);

    t.resume();
    const metered = createMetered({ inputBound: { tokensPerByte: 100 }, provider: t.provider, store: new MemorySpendStore(), envelope: "e2", limitNano: usdToNano(5) });
    const run = await runTrial(t.config, { metered, stored: t.stored() });
    expect(run.reports.map((r) => [r.attempt.id, r.report.accepted])).toEqual([
      ["w-2", true],
      ["w-3", true],
    ]);
    expect(t.provider.dispatched).toBe(1 + 4);
  });

  it("does not resume from another seed's skeleton copied into place", async () => {
    const t = await interrupted();
    const other: SavedReply = { ...t.saved("w-1", "skeleton"), attemptId: "w-2:skeleton", brief: { theme: "theme 2", suspects: 20, rooms: 5 } };
    writeWhole(replyPath(t.config, "w-1", "skeleton"), JSON.stringify(other));
    expect(standings(t.config, t.stored())[0]).toBe("closed: the saved skeleton belongs to another attempt");
  });
});

describe("writing a file whole", () => {
  it("replaces the file and leaves no temporary file", () => {
    const dir = mkdtempSync(join(tmpdir(), "writer-whole-"));
    writeWhole(`${dir}/deep/a.json`, "one");
    writeWhole(`${dir}/deep/a.json`, "two");
    expect(readFileSync(`${dir}/deep/a.json`, "utf8")).toBe("two");
    expect(readdirSync(`${dir}/deep`)).toEqual(["a.json"]);
  });
});
