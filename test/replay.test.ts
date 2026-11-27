import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { indexText, replayText, writeReplay } from "../scripts/replay-files";
import type { DetectiveReply, Move } from "../src/agents/detective";
import { archiveFailTwin, archivePass } from "../src/case/fixtures/archive";
import type { Case } from "../src/case/schema";
import { solve } from "../src/case/solver";
import { noModel } from "../src/game/terminal";
import { handleRequest, type ApiDeps, type ViewReply } from "../src/web/api";
import { previewReplayFile } from "../src/web/library";
import { cardOf, detectiveMoves, makeReplay, REPLAY_VERSION, solverMoves, type Replay } from "../src/web/replay";
import { memorySessions } from "../src/web/sessions";
import type { View } from "../src/web/view";
import { compilePlot } from "../src/writer/compile";
import { lighthousePeople, lighthouseSkeleton } from "../src/writer/fixtures/lighthouse";
import { cardsOf, replayOf, stepBy } from "../web/src/replay";
import { indexOf, isReplayId } from "../web/src/replay-shape";

const repo = resolve(import.meta.dirname, "..");
const built = compilePlot("lighthouse", lighthouseSkeleton, lighthousePeople);
if (!built.ok) throw new Error(built.problems.join("; "));
const lighthouse: Case = built.case;

const dirs: string[] = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "ta-replay-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const solved = async (c: Case, id = "a-case"): Promise<Replay> => {
  const proof = await solverMoves(c);
  if (!proof.ok) throw new Error("no proof");
  const made = await makeReplay(c, proof.moves, { id, player: { kind: "solver" } });
  if (!made.ok) throw new Error(made.why);
  return made.replay;
};

/** The same moves made through the live API, with the model off: the views a player would really have been sent. */
async function liveViews(c: Case, replay: Replay): Promise<View[]> {
  const deps: ApiDeps = { cases: [c], sessions: memorySessions(), metered: noModel, modelOff: true, newId: () => "00000000-0000-4000-8000-000000000001", newSecret: () => "a".repeat(64) };
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown): Promise<View> => {
    const response = await handleRequest(new Request(`http://game.test${path}`, { method, headers: { origin: "http://game.test", ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), deps);
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    const reply = (await response.json()) as ViewReply;
    if (!reply.view) throw new Error(JSON.stringify(reply));
    return reply.view;
  };
  const views = [await call("POST", "/api/sessions", { caseId: c.id })];
  for (const frame of replay.frames.slice(1)) {
    const at = views.at(-1)!;
    const base = `/api/sessions/${at.session}`;
    const move = frame.move!;
    if (move.kind === "ask") views.push(await call("POST", `${base}/ask`, { revision: at.revision, topic: move.topic, language: "en" }));
    else if (move.kind === "inspect") views.push(await call("POST", `${base}/inspect`, { revision: at.revision, inspection: move.inspection }));
    else views.push(await call("POST", `${base}/accuse`, { revision: at.revision, person: move.person, evidence: move.evidence }));
  }
  return views;
}

describe("a replay is a solved game as the page would have seen it", () => {
  for (const c of [archivePass, lighthouse]) {
    it(`${c.id}: every frame is the view the live game sends after the same move, and nothing else`, async () => {
      const replay = await solved(c);
      const proof = solve(c).proof!;
      expect(replay).toMatchObject({ version: REPLAY_VERSION, id: "a-case", title: c.title, setting: c.setting, suspects: c.suspects.length, actions: proof.actions.length, player: { kind: "solver" } });
      expect(replay.frames).toHaveLength(proof.actions.length + 2);
      expect(Object.keys(replay).sort()).toEqual(["actions", "frames", "id", "player", "setting", "suspects", "title", "version"]);
      const live = await liveViews(c, replay);
      // The session's name is the one thing that differs: a replay's is its own.
      expect(replay.frames.map((f) => ({ ...f.view, session: "x" }))).toEqual(live.map((v) => ({ ...v, session: "x" })));
      expect(new Set(replay.frames.map((f) => f.view.session))).toEqual(new Set(["replay-a-case"]));
      for (const frame of replay.frames) expect(Object.keys(frame).sort()).toEqual(frame.move ? ["move", "view"] : ["view"]);
    });

    it(`${c.id}: the answer is in the last frame only`, async () => {
      const replay = await solved(c);
      const last = replay.frames.at(-1)!;
      expect(last.view.over).toBe(true);
      expect(last.view.verdict).toMatchObject({ outcome: "solved", missing: [], open: [] });
      expect(last.view.reveal).toBeDefined();
      expect(last.move).toMatchObject({ kind: "accuse", person: `P${c.suspects.findIndex((s) => s.id === c.culprit.suspect) + 1}` });
      const before = JSON.stringify(replay.frames.slice(0, -1));
      expect(before).not.toContain('"verdict"');
      expect(before).not.toContain('"reveal"');
      expect(before).not.toContain('"over":true');
      // No id from the case file anywhere, the last frame included: a page is given handles.
      const whole = JSON.stringify(replay.frames);
      for (const id of [...c.suspects.map((s) => s.id), ...c.evidence.map((e) => e.id), ...c.actions.topics.map((t) => t.id), ...c.actions.inspections.map((i) => i.id), ...c.assertions.map((a) => a.id)]) expect(whole, id).not.toContain(`"${id}"`);
      // Evidence that is never gained in this game is not in it at all.
      const held = new Set(last.view.evidence.map((e) => e.text.en));
      for (const e of c.evidence) if (!held.has(e.text.en)) expect(whole, e.id).not.toContain(e.text.en);
    });
  }

  it("says what each move was, in the words and handles the player would have used", async () => {
    const replay = await solved(lighthouse);
    expect(replay.frames[0]!.move).toBeUndefined();
    for (const [i, frame] of replay.frames.entries()) {
      if (i === 0) continue;
      const before = replay.frames[i - 1]!.view;
      const move = frame.move!;
      if (move.kind === "ask") {
        // The topic was on the menu before the move, under this handle, for this person, with this label.
        expect(before.topics.find((t) => t.handle === move.topic)).toMatchObject({ person: move.person, label: move.label, heard: false });
        expect(frame.view.topics.find((t) => t.handle === move.topic)!.heard).toBe(true);
      } else if (move.kind === "inspect") {
        expect(before.inspections.find((x) => x.handle === move.inspection)).toMatchObject({ label: move.label, done: false });
      } else {
        expect(move.evidence).toEqual(before.evidence.map((e) => e.handle));
      }
    }
  });

  it("is not made of a game that cannot be played or is not solved", async () => {
    const c = lighthouse;
    const proof = await solverMoves(c);
    if (!proof.ok) throw new Error("no proof");
    const moves = proof.moves;
    const accusation = moves.at(-1) as Extract<Move, { type: "accuse" }>;
    const player = { kind: "solver" } as const;
    const why = async (m: Move[], id = "x") => {
      const made = await makeReplay(c, m, { id, player });
      return made.ok ? "ok" : made.why;
    };
    expect(await why(moves)).toBe("ok");
    // "index" is the name of the list of replays: a replay called that would be written over it.
    for (const id of ["", "Has Capitals", "a/b", "../x", "-a", "a-", "a--b", "x".repeat(61), "index"]) expect(await why(moves, id), id).toBe("bad-id");
    // No accusation at the end; or one, and something after it.
    expect(await why(moves.slice(0, -1))).toBe("no-accusation");
    expect(await why([])).toBe("no-accusation");
    expect(await why([...moves, moves[0]!])).toBe("illegal-move");
    expect(await why([...moves, accusation])).toBe("illegal-move");
    // A thing that is not in the case, a thing asked twice, a record looked at twice.
    expect(await why([{ type: "ask", topic: "no-such-topic" }, ...moves])).toBe("illegal-move");
    expect(await why([{ type: "inspect", inspection: "no-such-record" }, ...moves])).toBe("illegal-move");
    expect(await why([moves[0]!, moves[0]!, ...moves.slice(1)])).toBe("illegal-move");
    const inspection = moves.find((m) => m.type === "inspect")!;
    const at = moves.indexOf(inspection);
    expect(await why([...moves.slice(0, at + 1), inspection, ...moves.slice(at + 1)])).toBe("illegal-move");
    // A thing that is still locked when it is asked for: the proof's moves out of order.
    const locked = c.actions.inspections.find((i) => (i.requires ?? []).length > 0 && moves.some((m) => m.type === "inspect" && m.inspection === i.id));
    expect(locked).toBeDefined();
    expect(await why([{ type: "inspect", inspection: locked!.id }, ...moves])).toBe("illegal-move");
    // Evidence that is not held.
    expect(await why([...moves.slice(0, -1), { ...accusation, evidence: [...accusation.evidence, c.evidence.find((e) => !accusation.evidence.includes(e.id))!.id] }])).toBe("illegal-move");
    // The wrong person; the right person too early, with the proof not yet in hand.
    const other = c.suspects.find((s) => s.id !== c.culprit.suspect)!.id;
    expect(await why([...moves.slice(0, -1), { ...accusation, suspect: other }])).toBe("not-solved");
    expect(await why([{ type: "accuse", suspect: c.culprit.suspect, evidence: [] }])).toBe("not-solved");
  });

  it("follows the solver's proof, and has none to follow for a case that cannot be solved", async () => {
    const proof = await solverMoves(lighthouse);
    expect(proof.ok).toBe(true);
    if (proof.ok) {
      expect(proof.moves.slice(0, -1)).toEqual(solve(lighthouse).proof!.actions.map((a) => (a.type === "inspection" ? { type: "inspect", inspection: a.id } : { type: "ask", topic: a.id })));
      expect(proof.moves.at(-1)).toMatchObject({ type: "accuse", suspect: lighthouse.culprit.suspect });
    }
    expect(await solverMoves(archiveFailTwin)).toEqual({ ok: false, why: "no-proof" });
  });
});

describe("a replay of a game the detective agent played", () => {
  const usage = { inputTokens: 1_500, cachedTokens: 100, outputTokens: 100 };
  const PRICE = 1_400 * 100 + 100 * 4 + 100 * 500;
  type Action = { action: string; topic?: string; inspection?: string; person?: string; cite?: string[] };
  /** The detective's saved replies for a game, as the pilot saves them. */
  const saved = (script: (Action | string)[], game = "lighthouse:g3"): DetectiveReply[] =>
    script.map((a, i) => ({
      attemptId: `${game}:d${i + 1}`,
      turn: i + 1,
      text: typeof a === "string" ? a : JSON.stringify({ action: a.action, topic: a.topic ?? "none", inspection: a.inspection ?? "none", person: a.person ?? "none", cite: a.cite ?? [] }),
      finishReason: "stop",
      usage,
      settled: true,
      breached: false,
    }));
  // The route of test/detective.test.ts on the lighthouse, with one reply in it that cannot be used.
  const SOLVE: (Action | string)[] = [
    { action: "ask", topic: "T2" },
    "not an action at all",
    { action: "inspect", inspection: "I5" },
    { action: "inspect", inspection: "I1" },
    { action: "inspect", inspection: "I3" },
    { action: "inspect", inspection: "I4" },
    { action: "accuse", person: "P3", cite: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"] },
  ];

  it("reads the moves off the detective's own code, fed the saved replies, and says what they cost", async () => {
    const game = await detectiveMoves(lighthouse, saved(SOLVE));
    expect(game.ok).toBe(true);
    if (!game.ok) return;
    expect(game.moves.map((m) => m.type)).toEqual(["ask", "inspect", "inspect", "inspect", "inspect", "accuse"]);
    expect(game.moves.at(-1)).toMatchObject({ suspect: "s-03" });
    expect(game.player).toEqual({ kind: "detective", model: "muse-ember-1.0", turns: 7, unused: 1, requests: 7, costNano: 7 * PRICE });
    const made = await makeReplay(lighthouse, game.moves, { id: "by-the-detective", player: game.player });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.replay.frames).toHaveLength(7);
    expect(made.replay.frames.at(-1)!.view.verdict).toMatchObject({ outcome: "solved" });
    expect(cardOf(made.replay)).toEqual({ id: "by-the-detective", title: lighthouse.title, setting: lighthouse.setting, suspects: 20, actions: 5, player: game.player });
    // The detective's requests are the player's; the game's own total is the suspects', which were worded by code.
    expect(made.replay.frames.at(-1)!.view.cost).toEqual({ requests: 0, nano: 0, unfinished: 0 });
  });

  it("a game that did not end solved gives moves, and no replay", async () => {
    const early = await detectiveMoves(lighthouse, saved([{ action: "ask", topic: "T2" }, { action: "accuse", person: "P3", cite: ["R1"] }]));
    expect(early.ok).toBe(true);
    if (early.ok) expect(await makeReplay(lighthouse, early.moves, { id: "x", player: early.player })).toEqual({ ok: false, why: "not-solved" });
    const unfinished = await detectiveMoves(lighthouse, saved([{ action: "ask", topic: "T2" }]));
    expect(unfinished.ok).toBe(true);
    if (unfinished.ok) expect(await makeReplay(lighthouse, unfinished.moves, { id: "x", player: unfinished.player })).toEqual({ ok: false, why: "no-accusation" });
  });

  it("refuses saved replies that are not one game's, in order, with their cost confirmed", async () => {
    const good = saved(SOLVE);
    const bad = async (replies: unknown) => expect(await detectiveMoves(lighthouse, replies as DetectiveReply[])).toEqual({ ok: false, why: "bad-replies" });
    await bad([]);
    await bad(good.slice(1));
    await bad([good[1], good[0], ...good.slice(2)]);
    await bad(good.map((r, i) => (i === 3 ? { ...r, attemptId: "lighthouse:g4:d4" } : r)));
    await bad(good.map((r, i) => (i === 3 ? { ...r, turn: 9 } : r)));
    await bad(good.map((r, i) => (i === 2 ? { ...r, settled: false } : r)));
    await bad(good.map((r, i) => (i === 2 ? { ...r, breached: true } : r)));
    await bad(good.map((r, i) => (i === 2 ? { ...r, usage: undefined } : r)));
    await bad(good.map((r, i) => (i === 2 ? { ...r, usage: { inputTokens: 10, cachedTokens: 20, outputTokens: 1 } } : r)));
    await bad([{ ...good[0], attemptId: ":d1" }]);
    await bad([{ ...good[0], attemptId: "lighthouse:g3" }]);
    await bad([null]);
    // Replies saved after the game had already ended are not this game's.
    await bad([...good, { ...good[0], attemptId: "lighthouse:g3:d8", turn: 8 }]);
  });

  it("takes a game only for the case it was a game of: the replay says the detective played this case", async () => {
    // A game is named after its case: the case's id for the first game, and ":g<n>" after it for a later one.
    for (const game of ["lighthouse", "lighthouse:g2", "lighthouse:g17"]) expect((await detectiveMoves(lighthouse, saved(SOLVE, game))).ok, game).toBe(true);
    for (const game of ["pilot-x:g3", "another-case", "lighthouse-2", "lighthouse2", "xlighthouse", "lighthouse:g0", "lighthouse:gx", "lighthouse:g", "lighthouse:g2:x", "lighthouse:h2", "LIGHTHOUSE"]) {
      expect(await detectiveMoves(lighthouse, saved(SOLVE, game)), game).toEqual({ ok: false, why: "another-case" });
    }
    // The same plot under another id and title: every move is still legal in it, and the game is still not its game.
    const renamed: Case = { ...lighthouse, id: "harbour-light", title: { en: "Another Title", zh: "另一个标题" } };
    expect(await detectiveMoves(renamed, saved(SOLVE))).toEqual({ ok: false, why: "another-case" });
    expect((await detectiveMoves(renamed, saved(SOLVE, "harbour-light:g3"))).ok).toBe(true);
  });
});

describe("replay files", () => {
  it("writes a replay one frame to a line, and reads back as the same replay", async () => {
    const replay = await solved(lighthouse, "lighthouse");
    const text = replayText(replay);
    expect(JSON.parse(text)).toEqual(replay);
    expect(text.endsWith("]}\n")).toBe(true);
    expect(text.split("\n")).toHaveLength(replay.frames.length + 3);
    expect(JSON.parse(indexText({ version: 1, replays: [cardOf(replay)] }))).toEqual({ version: 1, replays: [cardOf(replay)] });
  });

  it("puts a replay in a folder: its file and its line in the index, and nothing else is touched", async () => {
    const dir = join(fresh(), "replays");
    const a = await solved(lighthouse, "b-lighthouse");
    const b = await solved(archivePass, "a-archive");
    expect(writeReplay(dir, a)).toEqual({ ok: true, files: [join(dir, "b-lighthouse.json"), join(dir, "index.json")] });
    writeFileSync(join(dir, "notes.txt"), "mine");
    expect(writeReplay(dir, b).ok).toBe(true);
    // Nothing is left behind: no half-written file, no lock.
    expect(readdirSync(dir).sort()).toEqual(["a-archive.json", "b-lighthouse.json", "index.json", "notes.txt"]);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("mine");
    // The index lists both, by name; each file is its replay.
    expect(JSON.parse(readFileSync(join(dir, "index.json"), "utf8"))).toEqual({ version: 1, replays: [cardOf(b), cardOf(a)] });
    expect(JSON.parse(readFileSync(join(dir, "a-archive.json"), "utf8"))).toEqual(b);
    // The same name again replaces it and is listed once.
    const again = { ...a, actions: 99 };
    expect(writeReplay(dir, again).ok).toBe(true);
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { replays: { id: string; actions: number }[] };
    expect(index.replays.map((r) => [r.id, r.actions])).toEqual([["a-archive", b.actions], ["b-lighthouse", 99]]);
    expect(readdirSync(dir).sort()).toEqual(["a-archive.json", "b-lighthouse.json", "index.json", "notes.txt"]);
  });

  /** Everything in a folder, with each file's contents: to show that a refusal changed nothing. */
  const snapshot = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf8")]));

  it("writes nothing into a folder whose index.json is not a list of replays, every card whole", async () => {
    const replay = await solved(lighthouse, "lighthouse");
    const card = cardOf(replay);
    const others = [
      '{"name":"my-app","version":"1.0.0"}',
      "[1,2,3]",
      "{not json",
      '{"version":1}',
      '{"version":2,"replays":[]}',
      "null",
      // A list with something in it that is not a replay card, or a name listed twice.
      JSON.stringify({ version: 1, replays: [{ id: "../x" }] }),
      JSON.stringify({ version: 1, replays: [{ ...card, id: "other" }, { id: "broken" }] }),
      JSON.stringify({ version: 1, replays: [card, card] }),
      JSON.stringify({ version: 1, replays: [], extra: true }),
    ];
    for (const other of others) {
      const dir = fresh();
      writeFileSync(join(dir, "index.json"), other);
      expect(writeReplay(dir, replay), other).toEqual({ ok: false, why: "bad-index" });
      expect(snapshot(dir), other).toEqual({ "index.json": other });
    }
    // An index.json that is a folder, or a link to a file somewhere else.
    const asFolder = fresh();
    mkdirSync(join(asFolder, "index.json"));
    expect(writeReplay(asFolder, replay)).toEqual({ ok: false, why: "bad-index" });
    const elsewhere = fresh();
    writeFileSync(join(elsewhere, "real.json"), indexText({ version: 1, replays: [] }));
    const linked = fresh();
    symlinkSync(join(elsewhere, "real.json"), join(linked, "index.json"));
    expect(writeReplay(linked, replay)).toEqual({ ok: false, why: "bad-index" });
    expect(readFileSync(join(elsewhere, "real.json"), "utf8")).toBe(indexText({ version: 1, replays: [] }));
    expect(readdirSync(linked)).toEqual(["index.json"]);
  });

  it("writes over a file with the replay's name only if it is an earlier version of that replay", async () => {
    const replay = await solved(archivePass, "archive");
    const other = await solved(lighthouse, "lighthouse");
    const victims: [string, string][] = [
      // The case file itself, under the name the replay would take: its answer must not be lost, nor replaced.
      ["the case file", JSON.stringify(archivePass)],
      ["somebody's document", '{"chapter":1,"text":"three days of work"}'],
      ["not json", "{not json"],
      ["another replay under this name", replayText(other)],
      ["an empty file", ""],
    ];
    for (const [what, contents] of victims) {
      const dir = fresh();
      writeFileSync(join(dir, "archive.json"), contents);
      writeFileSync(join(dir, "index.json"), indexText({ version: 1, replays: [cardOf(other)] }));
      const before = snapshot(dir);
      expect(writeReplay(dir, replay), what).toEqual({ ok: false, why: "not-a-replay" });
      expect(snapshot(dir), what).toEqual(before);
    }
    // A link under the replay's name is not written through.
    const elsewhere = fresh();
    writeFileSync(join(elsewhere, "target.json"), replayText(replay));
    const dir = fresh();
    symlinkSync(join(elsewhere, "target.json"), join(dir, "archive.json"));
    expect(writeReplay(dir, { ...replay, actions: 7 })).toEqual({ ok: false, why: "not-a-replay" });
    expect(readFileSync(join(elsewhere, "target.json"), "utf8")).toBe(replayText(replay));
  });

  it("never takes the list's own name, or a replay that is not whole", async () => {
    const replay = await solved(lighthouse, "lighthouse");
    for (const id of ["index", "../x", "Has Capitals", ""]) {
      const dir = fresh();
      expect(writeReplay(dir, { ...replay, id }), id).toEqual({ ok: false, why: "bad-replay" });
      expect(readdirSync(dir)).toEqual([]);
    }
    const dir = fresh();
    expect(writeReplay(dir, { ...replay, frames: replay.frames.slice(0, -1) })).toEqual({ ok: false, why: "bad-replay" });
    expect(writeReplay(dir, { ...replay, title: "plain" } as unknown as Replay)).toEqual({ ok: false, why: "bad-replay" });
    expect(readdirSync(dir)).toEqual([]);
    expect(isReplayId("index")).toBe(false);
    expect(isReplayId("index-2")).toBe(true);
  });

  it("if a write fails half way, no half-written file, no new replay and no lock are left", async () => {
    const replay = await solved(lighthouse, "lighthouse");
    const dir = fresh();
    // The list cannot be prepared: something already sits where its new text would be written.
    mkdirSync(join(dir, `index.json.${process.pid}.part`));
    expect(() => writeReplay(dir, replay)).toThrow();
    // The replay's own text had been prepared by then. It is gone again, and the replay was never put in place.
    expect(readdirSync(dir).filter((name) => name.startsWith("lighthouse"))).toEqual([]);
    expect(readdirSync(dir)).not.toContain(".replays.lock");
    expect(readdirSync(dir)).not.toContain("index.json");
  });

  it("one run at a time writes to a folder: a second is told so and writes nothing", async () => {
    const replay = await solved(lighthouse, "lighthouse");
    const dir = fresh();
    // Another run holds the folder.
    writeFileSync(join(dir, ".replays.lock"), "");
    expect(writeReplay(dir, replay)).toEqual({ ok: false, why: "busy" });
    expect(readdirSync(dir)).toEqual([".replays.lock"]);
    // And when it is done, this one goes through and leaves no lock of its own.
    rmSync(join(dir, ".replays.lock"));
    expect(writeReplay(dir, replay).ok).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["index.json", "lighthouse.json"]);
    // A refusal lets go of the folder too.
    writeFileSync(join(dir, "index.json"), "{}");
    expect(writeReplay(dir, replay)).toEqual({ ok: false, why: "bad-index" });
    expect(readdirSync(dir).sort()).toEqual(["index.json", "lighthouse.json"]);
  });

  it("the replay that ships with the repository is the one the maker makes today", async () => {
    const replay = await solved(lighthouse, "lighthouse");
    expect(readFileSync(join(repo, "web/public/replays/lighthouse.json"), "utf8")).toBe(replayText(replay));
    expect(readFileSync(join(repo, "web/public/replays/index.json"), "utf8")).toBe(indexText({ version: 1, replays: [cardOf(replay)] }));
    // Nothing else is published there: a replay gives away its case, so each one is put there on purpose.
    expect(readdirSync(join(repo, "web/public/replays")).sort()).toEqual(["index.json", "lighthouse.json"]);
  });
});

describe("the replay command", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/make-replay.ts", ...args], { cwd: repo, encoding: "utf8" });

  it("makes a replay of a case file along its solver's proof, into the folder it is given", () => {
    const dir = fresh();
    const file = join(dir, "archive.json");
    writeFileSync(file, JSON.stringify(archivePass));
    const out = join(dir, "out");
    const made = run("--case", file, "--solver", "--id", "the-archive", "--out", out);
    expect(made.status, made.stdout + made.stderr).toBe(0);
    expect(made.stdout).toContain("solved");
    expect(made.stdout).toContain("已破解");
    expect(readdirSync(out).sort()).toEqual(["index.json", "the-archive.json"]);
    const replay = replayOf(JSON.parse(readFileSync(join(out, "the-archive.json"), "utf8")), "the-archive");
    expect(replay?.frames.at(-1)?.view.verdict).toMatchObject({ outcome: "solved" });
  });

  it("refuses what it cannot make a solved replay of, in both languages, and writes nothing", () => {
    const dir = fresh();
    const good = join(dir, "archive.json");
    writeFileSync(good, JSON.stringify(archivePass));
    const twin = join(dir, "twin.json");
    writeFileSync(twin, JSON.stringify(archiveFailTwin));
    const replies = join(dir, "replies.json");
    writeFileSync(replies, JSON.stringify([{ attemptId: "g:d1", turn: 1, text: "{}", finishReason: "stop", usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 }, settled: false, breached: false }]));
    const out = join(dir, "out");
    const cases: string[][] = [
      [],
      ["--builtin", "--solver"],
      ["--builtin", "--builtin"],
      ["--case", good, "--id", "x", "--out", out],
      ["--case", good, "--solver", "--detective", replies, "--id", "x", "--out", out],
      ["--case", good, "--solver", "--id", "x"],
      ["--case", good, "--solver", "--id", "x", "--out", out, "--force"],
      ["--case", good, "--solver", "--id", "Bad Name", "--out", out],
      ["--case", good, "--solver", "--id", "index", "--out", out],
      ["--case", join(dir, "missing.json"), "--solver", "--id", "x", "--out", out],
      ["--case", twin, "--solver", "--id", "x", "--out", out],
      ["--case", good, "--detective", replies, "--id", "x", "--out", out],
      ["--case", good, "--detective", join(dir, "missing.json"), "--id", "x", "--out", out],
    ];
    for (const args of cases) {
      const made = run(...args);
      expect(made.status, args.join(" ")).toBe(1);
      expect(made.stdout, args.join(" ")).toContain("Nothing was written.");
      expect(made.stdout, args.join(" ")).toContain("没有写入任何内容。");
    }
    expect(readdirSync(dir).sort()).toEqual(["archive.json", "replies.json", "twin.json"]);
    // A refused case file is not explained in a way that names anyone.
    const refused = run("--case", twin, "--solver", "--id", "x", "--out", out).stdout;
    for (const s of archiveFailTwin.suspects) expect(refused).not.toContain(s.id);
  }, 60_000);
});

describe("what the page does with a replay file", () => {
  const index = JSON.parse(readFileSync(join(repo, "web/public/replays/index.json"), "utf8")) as unknown;
  const file = () => JSON.parse(readFileSync(join(repo, "web/public/replays/lighthouse.json"), "utf8")) as Replay;

  it("lists the replays of a list file only if every entry is a replay card", () => {
    expect(cardsOf(index, "/replays")).toEqual([{ ...cardOf(file()), base: "/replays" }]);
    const card = cardOf(file());
    const detective = { ...card, id: "by-ember", player: { kind: "detective", model: "muse-ember-1.0", turns: 9, unused: 0, requests: 9, costNano: 5_687_892 } };
    expect(cardsOf({ version: 1, replays: [card, detective] }, "/r").map((c) => c.id)).toEqual(["lighthouse", "by-ember"]);
    expect(indexOf({ version: 1, replays: [] })).toEqual([]);
    for (const data of [null, [], "x", {}, { version: 2, replays: [card] }, { version: 1 }, { version: 1, replays: "x" }, { version: 1, replays: [card], more: 1 }, { version: 1, replays: [card, card] }]) {
      expect(cardsOf(data, "/r")).toEqual([]);
      expect(indexOf(data)).toBeNull();
    }
    const bad = [
      null,
      {},
      { ...card, id: "../secret" },
      { ...card, id: "Has Capitals" },
      { ...card, id: "index" },
      { ...card, title: "plain text" },
      { ...card, setting: { en: "only english" } },
      { ...card, setting: undefined },
      { ...card, suspects: "20" },
      { ...card, actions: -1 },
      { ...card, player: { kind: "someone" } },
      { ...card, player: { kind: "detective", model: "m" } },
      { ...card, player: { kind: "solver", costNano: 1 } },
      { ...card, player: undefined },
      { ...card, frames: [] },
    ];
    for (const [i, entry] of bad.entries()) expect(cardsOf({ version: 1, replays: [card, entry] }, "/r"), String(i)).toEqual([]);
  });

  /** Every place in a JSON value, as the list of keys that leads to it. */
  const places = (x: unknown, at: (string | number)[] = []): (string | number)[][] =>
    Array.isArray(x) ? x.flatMap((v, i) => [[...at, i], ...places(v, [...at, i])]) : typeof x === "object" && x !== null ? Object.entries(x).flatMap(([k, v]) => [[...at, k], ...places(v, [...at, k])]) : [];
  /** A copy of `x` with the value at `path` changed by `change`, or removed when it returns the `GONE` mark. */
  const GONE = Symbol("gone");
  const altered = (x: unknown, path: (string | number)[], change: (v: unknown) => unknown): unknown => {
    const copy = JSON.parse(JSON.stringify(x)) as unknown;
    let parent = copy as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
    const last = path.at(-1)!;
    const next = change(parent[last]);
    if (next === GONE) delete parent[last];
    else parent[last] = next;
    return copy;
  };

  it("takes a replay file only if it is the replay that was asked for, whole and in order", () => {
    const good = file();
    expect(replayOf(good, "lighthouse")).toEqual(good);
    expect(replayOf(good, "another")).toBeNull();
    const frames = good.frames;
    const view = frames[1]!.view;
    const end = frames.at(-1)!;
    const broken: unknown[] = [
      null,
      "text",
      [],
      { ...good, version: 2 },
      { ...good, frames: undefined },
      { ...good, frames: [] },
      { ...good, frames: [frames[0]] },
      { ...good, frames: [frames[0], null, ...frames.slice(2)] },
      // The game over in the middle, or not over at the end; an answer before the end; an end that is not solved.
      { ...good, frames: [frames[0], end, ...frames.slice(2)] },
      { ...good, frames: frames.slice(0, -1) },
      { ...good, frames: [frames[0], { ...frames[1], view: { ...view, verdict: end.view.verdict } }, ...frames.slice(2)] },
      { ...good, frames: [frames[0], { ...frames[1], view: { ...view, reveal: end.view.reveal } }, ...frames.slice(2)] },
      { ...good, frames: [...frames.slice(0, -1), { ...end, view: { ...end.view, verdict: { ...end.view.verdict, outcome: "wrong" } } }] },
      { ...good, frames: [...frames.slice(0, -1), { ...end, view: { ...end.view, verdict: { ...end.view.verdict, outcome: "right-but-unproven" } } }] },
      // A first frame with a move; a later one without, or with one of no known kind, or about someone who is not there.
      { ...good, frames: [{ ...frames[0], move: frames[1]!.move }, ...frames.slice(1)] },
      { ...good, frames: [frames[0], { view }, ...frames.slice(2)] },
      { ...good, frames: [frames[0], { view, move: { kind: "dance" } }, ...frames.slice(2)] },
      { ...good, frames: [frames[0], { view, move: { ...frames[1]!.move, person: "P99" } }, ...frames.slice(2)] },
      // A view that claims the model is on: a replay is never that.
      { ...good, frames: [{ view: { ...frames[0]!.view, model: "on" } }, ...frames.slice(1)] },
      { ...good, title: "plain" },
      { ...good, player: { kind: "nobody" } },
      { ...good, id: "index" },
    ];
    for (const [i, data] of broken.entries()) expect(replayOf(data, "lighthouse"), String(i)).toBeNull();
    expect(replayOf({ ...good, id: "index" }, "index")).toBeNull();
  });

  it("reads nothing it has not checked: with any one part of the file missing, of another kind, or added, it is not a replay", () => {
    const good = file();
    const all = places(good);
    expect(all.length).toBeGreaterThan(2_000);
    for (const path of all) {
      const where = path.join(".");
      // Taken away. (An item taken out of a list leaves a shorter list, which can still be a replay: lists are checked item by item.)
      if (typeof path.at(-1) === "string") expect(replayOf(altered(good, path, () => GONE), "lighthouse"), `without ${where}`).toBeNull();
      // Of another kind.
      expect(replayOf(altered(good, path, (v) => (typeof v === "number" ? "7" : typeof v === "string" ? 7 : typeof v === "boolean" ? "true" : null)), "lighthouse"), `wrong kind at ${where}`).toBeNull();
    }
    // A part that no replay has, in every object of the file.
    const objects = [[] as (string | number)[], ...all].filter((path) => {
      const target = path.reduce<unknown>((x, key) => (x as Record<string | number, unknown>)[key], good);
      return typeof target === "object" && target !== null && !Array.isArray(target);
    });
    expect(objects.length).toBeGreaterThan(500);
    for (const path of objects) {
      const copy = JSON.parse(JSON.stringify(good)) as unknown;
      (path.reduce<unknown>((x, key) => (x as Record<string | number, unknown>)[key], copy) as Record<string, unknown>).culprit = "s-03";
      expect(replayOf(copy, "lighthouse"), `added at ${path.join(".")}`).toBeNull();
    }
  });

  it("steps stay inside the replay", () => {
    const replay = file();
    const last = replay.frames.length - 1;
    expect(stepBy(replay, 0, 1)).toBe(1);
    expect(stepBy(replay, 0, -1)).toBe(0);
    expect(stepBy(replay, last, 1)).toBe(last);
    expect(stepBy(replay, last, -1)).toBe(last - 1);
    expect(stepBy(replay, 2, 100)).toBe(last);
    expect(stepBy(replay, 2, -100)).toBe(0);
  });
});

describe("replays that wait to be looked at", () => {
  it("are handed out only if they are replays the folder's own list names, by plain file name, as ordinary files", async () => {
    const listed = await solved(lighthouse, "pilot-a-1");
    const unlisted = await solved(archivePass, "not-listed");
    const dir = fresh();
    const folder = join(dir, "replays");
    mkdirSync(folder);
    const list = { version: 1 as const, replays: [cardOf(listed), { ...cardOf(unlisted), id: "a-case-file" }, { ...cardOf(unlisted), id: "damaged" }, { ...cardOf(unlisted), id: "linked" }, { ...cardOf(unlisted), id: "wrong-name" }] };
    writeFileSync(join(folder, "index.json"), indexText(list));
    writeFileSync(join(folder, "pilot-a-1.json"), replayText(listed));
    // A whole replay that the list does not name.
    writeFileSync(join(folder, "not-listed.json"), replayText(unlisted));
    // Named by the list, and not replays: a case file copied here by mistake, a damaged file, a replay under another name.
    writeFileSync(join(folder, "a-case-file.json"), JSON.stringify(archivePass));
    writeFileSync(join(folder, "damaged.json"), replayText(unlisted).slice(0, 500));
    writeFileSync(join(folder, "wrong-name.json"), replayText(unlisted));
    // Named by the list, and a link to a whole replay somewhere else.
    writeFileSync(join(dir, "elsewhere.json"), replayText({ ...unlisted, id: "linked" }));
    symlinkSync(join(dir, "elsewhere.json"), join(folder, "linked.json"));
    writeFileSync(join(folder, "notes.txt"), "not a replay");
    mkdirSync(join(folder, "deeper"));
    writeFileSync(join(folder, "deeper", "pilot-a-1.json"), replayText(listed));

    expect(JSON.parse(previewReplayFile(folder, "index.json")!)).toEqual(list);
    expect(JSON.parse(previewReplayFile(folder, "pilot-a-1.json")!)).toEqual(listed);
    for (const name of ["not-listed.json", "a-case-file.json", "damaged.json", "wrong-name.json", "linked.json"]) expect(previewReplayFile(folder, name), name).toBeNull();
    for (const name of ["", "missing.json", "notes.txt", "../elsewhere.json", "..%2Felsewhere.json", "deeper/pilot-a-1.json", "/etc/passwd", "index.json/", "INDEX.json", ".json", "a..json", "index.json\0", `${folder}/index.json`]) {
      expect(previewReplayFile(folder, name), name).toBeNull();
    }
    expect(previewReplayFile(join(dir, "no-such-folder"), "index.json")).toBeNull();
  });

  it("hand out nothing from a folder whose list is not a list of replays, or is a link", async () => {
    const replay = await solved(lighthouse, "pilot-a-1");
    for (const index of [undefined, "{not json", JSON.stringify(archivePass), '{"version":1,"replays":[{"id":"pilot-a-1"}]}', JSON.stringify({ version: 2, replays: [cardOf(replay)] })]) {
      const folder = fresh();
      writeFileSync(join(folder, "pilot-a-1.json"), replayText(replay));
      if (index !== undefined) writeFileSync(join(folder, "index.json"), index);
      expect(previewReplayFile(folder, "index.json"), String(index).slice(0, 30)).toBeNull();
      expect(previewReplayFile(folder, "pilot-a-1.json"), String(index).slice(0, 30)).toBeNull();
    }
    const elsewhere = fresh();
    writeFileSync(join(elsewhere, "list.json"), indexText({ version: 1, replays: [cardOf(replay)] }));
    const folder = fresh();
    writeFileSync(join(folder, "pilot-a-1.json"), replayText(replay));
    symlinkSync(join(elsewhere, "list.json"), join(folder, "index.json"));
    expect(previewReplayFile(folder, "index.json")).toBeNull();
    expect(previewReplayFile(folder, "pilot-a-1.json")).toBeNull();
  });
});
