import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    for (const id of ["", "Has Capitals", "a/b", "../x", "-a", "a-", "a--b", "x".repeat(61)]) expect(await why(moves, id), id).toBe("bad-id");
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
  const saved = (script: (Action | string)[], game = "pilot-x:g3"): DetectiveReply[] =>
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
    await bad(good.map((r, i) => (i === 3 ? { ...r, attemptId: "another-game:d4" } : r)));
    await bad(good.map((r, i) => (i === 3 ? { ...r, turn: 9 } : r)));
    await bad(good.map((r, i) => (i === 2 ? { ...r, settled: false } : r)));
    await bad(good.map((r, i) => (i === 2 ? { ...r, breached: true } : r)));
    await bad(good.map((r, i) => (i === 2 ? { ...r, usage: undefined } : r)));
    await bad(good.map((r, i) => (i === 2 ? { ...r, usage: { inputTokens: 10, cachedTokens: 20, outputTokens: 1 } } : r)));
    await bad([{ ...good[0], attemptId: ":d1" }]);
    await bad([null]);
    // Replies saved after the game had already ended are not this game's.
    await bad([...good, { ...good[0], attemptId: "pilot-x:g3:d8", turn: 8 }]);
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
  });

  it("writes nothing into a folder whose index.json is something else", async () => {
    const replay = await solved(lighthouse, "lighthouse");
    for (const other of ['{"name":"my-app","version":"1.0.0"}', "[1,2,3]", "{not json", '{"version":1}', '{"version":2,"replays":[]}', "null"]) {
      const dir = fresh();
      writeFileSync(join(dir, "index.json"), other);
      expect(writeReplay(dir, replay), other).toEqual({ ok: false, why: "bad-index" });
      expect(readdirSync(dir)).toEqual(["index.json"]);
      expect(readFileSync(join(dir, "index.json"), "utf8")).toBe(other);
    }
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

  it("lists the replays of a list file, and leaves out what is not a replay card", () => {
    expect(cardsOf(index, "/replays")).toEqual([{ ...cardOf(file()), base: "/replays" }]);
    const card = cardOf(file());
    const detective = { ...card, id: "by-ember", player: { kind: "detective", model: "muse-ember-1.0", turns: 9, unused: 0, requests: 9, costNano: 5_687_892 } };
    expect(cardsOf({ version: 1, replays: [card, detective] }, "/r").map((c) => c.id)).toEqual(["lighthouse", "by-ember"]);
    for (const data of [null, [], "x", {}, { version: 2, replays: [card] }, { version: 1 }, { version: 1, replays: "x" }]) expect(cardsOf(data, "/r")).toEqual([]);
    const bad = [
      null,
      {},
      { ...card, id: "../secret" },
      { ...card, id: "Has Capitals" },
      { ...card, title: "plain text" },
      { ...card, setting: { en: "only english" } },
      { ...card, suspects: "20" },
      { ...card, actions: -1 },
      { ...card, player: { kind: "someone" } },
      { ...card, player: { kind: "detective", model: "m" } },
      { ...card, player: undefined },
    ];
    expect(cardsOf({ version: 1, replays: [...bad, card] }, "/r").map((c) => c.id)).toEqual(["lighthouse"]);
  });

  it("takes a replay file only if it is the replay that was asked for, whole and in order", () => {
    const good = file();
    expect(replayOf(good, "lighthouse")).toEqual(good);
    expect(replayOf(good, "another")).toBeNull();
    const frames = good.frames;
    const view = frames[1]!.view;
    const broken: unknown[] = [
      null,
      "text",
      [],
      { ...good, version: 2 },
      { ...good, frames: undefined },
      { ...good, frames: [] },
      { ...good, frames: [frames[0]] },
      { ...good, frames: [frames[0], null, ...frames.slice(2)] },
      // The game over in the middle, or not over at the end.
      { ...good, frames: [frames[0], frames.at(-1), ...frames.slice(2)] },
      { ...good, frames: frames.slice(0, -1) },
      { ...good, frames: [...frames.slice(0, -1), { ...frames.at(-1), view: { ...frames.at(-1)!.view, reveal: undefined } }] },
      { ...good, frames: [...frames.slice(0, -1), { ...frames.at(-1), view: { ...frames.at(-1)!.view, verdict: undefined } }] },
      // A first frame with a move; a later one without, or with one of no known kind.
      { ...good, frames: [{ ...frames[0], move: frames[1]!.move }, ...frames.slice(1)] },
      { ...good, frames: [frames[0], { view }, ...frames.slice(2)] },
      { ...good, frames: [frames[0], { view, move: { kind: "dance" } }, ...frames.slice(2)] },
      // A view with a part missing that the page draws.
      ...["people", "evidence", "topics", "inspections", "transcript", "statements", "rules", "actions", "cost", "victim", "title"].map((part) => ({ ...good, frames: [frames[0], { ...frames[1], view: { ...view, [part]: undefined } }, ...frames.slice(2)] })),
      { ...good, title: "plain" },
      { ...good, player: { kind: "nobody" } },
    ];
    for (const [i, data] of broken.entries()) expect(replayOf(data, "lighthouse"), String(i)).toBeNull();
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
  it("are handed out by plain file name only, from their own folder", () => {
    const dir = fresh();
    const folder = join(dir, "replays");
    mkdirSync(folder);
    writeFileSync(join(folder, "index.json"), '{"version":1,"replays":[]}');
    writeFileSync(join(folder, "pilot-a-1.json"), '{"id":"pilot-a-1"}');
    writeFileSync(join(folder, "notes.txt"), "not a replay");
    writeFileSync(join(dir, "case.json"), '{"culprit":"s-01"}');
    mkdirSync(join(folder, "deeper"));
    writeFileSync(join(folder, "deeper", "x.json"), "{}");
    expect(previewReplayFile(folder, "index.json")).toBe('{"version":1,"replays":[]}');
    expect(previewReplayFile(folder, "pilot-a-1.json")).toBe('{"id":"pilot-a-1"}');
    for (const name of ["", "missing.json", "notes.txt", "../case.json", "..%2Fcase.json", "deeper/x.json", "/etc/passwd", "index.json/", "INDEX.json", ".json", "a..json", "index.json\0", `${folder}/index.json`]) {
      expect(previewReplayFile(folder, name), name).toBeNull();
    }
    expect(previewReplayFile(join(dir, "no-such-folder"), "index.json")).toBeNull();
  });
});
