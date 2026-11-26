import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMetered, type TraceEvent } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderRequest, ProviderResponse } from "../src/provider/types";
import { parseRunArgs } from "../src/run-args";
import { usdToNano } from "../src/spend/pricing";
import { memoryRunLock } from "../src/spend/run-lock";
import { MemorySpendStore } from "../src/spend/store";
import { lighthousePeople, lighthouseSkeleton } from "../src/writer/fixtures/lighthouse";
import type { PilotConfig } from "../src/writer/pilot";
import { pilotCli, type PilotRuntime } from "../src/writer/pilot-cli";
import type { StoredAttempt } from "../src/writer/trial";

const usage = { inputTokens: 1_000, cachedTokens: 0, outputTokens: 500 };
const done = (value: unknown): ProviderResponse => ({ text: JSON.stringify(value), toolCalls: [], usage, finishReason: "stop" });
const names = (list: string) => list.split(/, | and /).map((n) => n.trim()).filter(Boolean);

/** A detective that reads only what it is shown: hear the keeper, inspect every record, accuse citing everything. */
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

/** The command line with only its runtime replaced: a fake provider behind the real spend guard, and a record of every call. */
async function setup(options: { envelope?: string; paid?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pilot-cli-"));
  const config: Omit<PilotConfig, "game"> = { attempts: [1, 2].map((n) => ({ id: `p-${n}`, theme: `theme ${n}` })), suspects: 20, rooms: 5, dir, maxTurns: 27 };
  const provider = new FakeProvider((request) => (request.responseSchema?.name === "case_skeleton" ? done(lighthouseSkeleton) : request.responseSchema?.name === "case_people" ? done(lighthousePeople) : readingDetective(request)));
  const store = new MemorySpendStore();
  const envelope = options.envelope ?? "local";
  if (options.paid !== false) await store.allowPaid({ envelope, note: "test" });
  const trace: TraceEvent[] = [];
  const metered = createMetered({ inputBound: { tokensPerByte: 100 }, provider, store, envelope, limitNano: usdToNano(5), trace: (e) => trace.push(e) });
  const attempts = (): StoredAttempt[] => trace.filter((e) => ["settled", "retained", "settle-pending"].includes(e.outcome)).map((e) => ({ attemptId: e.attemptId, state: e.outcome === "settled" ? "settled" : "retained" }));
  const calls = { opened: 0, closed: 0 };
  const lock = memoryRunLock();
  const runtime = async (): Promise<PilotRuntime> => {
    calls.opened++;
    return { metered, store: { attempts: async () => attempts(), totals: (e) => store.totals(e) }, runLock: lock, config: { envelope }, close: async () => void calls.closed++ };
  };
  const cli = async (...argv: string[]) => {
    const lines: string[] = [];
    const code = await pilotCli(argv, { config, envelope: "local", runtime, print: (line) => lines.push(line) });
    return { code, out: lines.join("\n") };
  };
  const withIds = (...ids: string[]) => pilotCli([], { config: { ...config, attempts: ids.map((id) => ({ id, theme: "x" })) }, envelope: "local", runtime, print: () => undefined });
  const sentIds = () => attempts().map((a) => a.attemptId);
  return { dir, provider, calls, cli, sentIds, withIds };
}

describe("reading the arguments of a script that can spend", () => {
  const read = (...argv: string[]) => parseRunArgs(argv, { allowGame: true });

  it("reads the forms it knows", () => {
    expect(read()).toEqual({ ok: true, plan: false, game: 1 });
    expect(read("--plan")).toEqual({ ok: true, plan: true, game: 1 });
    expect(read("--game", "2")).toEqual({ ok: true, plan: false, game: 2 });
    expect(read("--game=2")).toEqual({ ok: true, plan: false, game: 2 });
    expect(read("--plan", "--game=12")).toEqual({ ok: true, plan: true, game: 12 });
    expect(read("--game", "3", "--plan")).toEqual({ ok: true, plan: true, game: 3 });
  });

  it("refuses everything else: unknown, mistyped, repeated, or a value it cannot read", () => {
    const bad: string[][] = [
      ["--plans"],
      ["-plan"],
      ["plan"],
      ["--Plan"],
      ["--plan=1"],
      ["--plan", "--plan"],
      ["--game"],
      ["--game="],
      ["--game", "--plan"],
      ["--game", "0"],
      ["--game", "-2"],
      ["--game", "02"],
      ["--game", "2.0"],
      ["--game", "1e1"],
      ["--game", " 2"],
      ["--game", "two"],
      ["--game", "9999999"],
      ["--game=2x"],
      ["--game", "1", "--game", "2"],
      ["--game=2", "--game=2"],
      ["--game", "2", "--game=3"],
      ["--games", "2"],
      ["--game2"],
      ["--game", "2", "extra"],
      ["2"],
      [""],
    ];
    for (const argv of bad) expect(read(...argv), argv.join(" ")).toMatchObject({ ok: false });
    // A script with no numbered games does not take the flag at all.
    expect(parseRunArgs(["--game", "2"], { allowGame: false })).toMatchObject({ ok: false });
    expect(parseRunArgs(["--game=2"], { allowGame: false })).toMatchObject({ ok: false });
    expect(parseRunArgs(["--plan"], { allowGame: false })).toEqual({ ok: true, plan: true, game: 1 });
  });
});

describe("the pilot's command line", () => {
  it("an argument it cannot read ends it before anything is connected, planned or sent", async () => {
    const t = await setup();
    for (const argv of [["--plans"], ["--game=x"], ["--game", "1", "--game", "2"], ["--game", "2", "--plans"], ["--plan", "--plan"], ["--game"], ["--game", "0"], ["extra"]]) {
      const r = await t.cli(...argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.out, argv.join(" ")).toContain("Nothing was sent");
    }
    expect(t.calls).toEqual({ opened: 0, closed: 0 });
    expect(t.provider.dispatched).toBe(0);
    expect(readdirSync(t.dir)).toEqual([]);
  });

  it("a config whose attempt names could collide is refused before anything is connected", async () => {
    const t = await setup();
    await expect(t.withIds("case", "case.g2")).rejects.toThrow(RangeError);
    await expect(t.withIds("case", "case:g2")).rejects.toThrow(RangeError);
    await expect(t.withIds("case", "case")).rejects.toThrow(/share the id/);
    expect(t.calls).toEqual({ opened: 0, closed: 0 });
    expect(t.provider.dispatched).toBe(0);
  });

  it("--game=2 means game 2: with no saved case it sends nothing, and never writes one", async () => {
    for (const argv of [["--game=2"], ["--game", "2"]]) {
      const t = await setup();
      const r = await t.cli(...argv);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Game 2 of 2 saved cases. No case is written.");
      expect(r.out).toContain("A run now would send at most 0 request(s).");
      expect(t.provider.dispatched).toBe(0);
      expect(t.calls).toEqual({ opened: 1, closed: 1 });
    }
  });

  it("runs game 1, then game 2 on the saved cases with detective requests only", async () => {
    const t = await setup();
    const dry = await t.cli("--plan");
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("A run now would send at most 58 request(s).");
    expect(t.provider.dispatched).toBe(0);

    const first = await t.cli();
    expect(first.code).toBe(0);
    expect(first.out).toContain("THIS RUN ONLY: wrote 2, of which accepted 2; played 2, of which solved 2.");
    expect(t.provider.dispatched).toBe(2 * (2 + 7));
    const afterFirst = t.sentIds();

    // A mistyped dry run of game 2 sends nothing. Before, it ran.
    const typo = await t.cli("--game", "2", "--plans");
    expect(typo.code).toBe(1);
    expect(t.provider.dispatched).toBe(18);
    // The dry run, spelled right, sends nothing either and says what a run would send.
    const plan = await t.cli("--game", "2", "--plan");
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("A run now would send at most 54 request(s).");
    expect(t.provider.dispatched).toBe(18);

    const second = await t.cli("--game=2");
    expect(second.code).toBe(0);
    expect(second.out).toContain("THE PILOT SO FAR, GAME 2");
    expect(second.out).toContain("played 2, solved 2");
    const turns = (id: string) => [1, 2, 3, 4, 5, 6, 7].map((n) => `${id}:g2:d${n}`);
    expect(t.sentIds().slice(afterFirst.length)).toEqual([...turns("p-1"), ...turns("p-2")]);
    expect(t.provider.requests.slice(18).every((r) => r.responseSchema?.name === "detective_action")).toBe(true);

    // Each game once: both again send nothing.
    expect((await t.cli()).code).toBe(0);
    expect((await t.cli("--game", "2")).code).toBe(0);
    expect(t.provider.dispatched).toBe(18 + 14);
    // Every time it connected, it closed.
    expect(t.calls.opened).toBe(t.calls.closed);
  });

  it("sends nothing on another envelope, or without paid requests authorized", async () => {
    const other = await setup({ envelope: "deployed" });
    const wrong = await other.cli();
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain('uses the "local" envelope only');
    expect(other.provider.dispatched).toBe(0);
    expect(other.calls).toEqual({ opened: 1, closed: 1 });

    const shut = await setup({ paid: false });
    const refused = await shut.cli();
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("Paid requests are not authorized on this envelope. Nothing was sent.");
    expect((await shut.cli("--plan")).code).toBe(0);
    expect(shut.provider.dispatched).toBe(0);
    expect(shut.calls).toEqual({ opened: 2, closed: 2 });
  });
});
