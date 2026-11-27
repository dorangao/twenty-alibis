/**
 * Make a replay: a solved game as a file a page can play back with no server.
 * 生成回放：把一局已破解的游戏写成一个文件，页面不需要服务器就能播放。
 *
 *   npm run replay:make -- --builtin
 *       The replay that ships with the repository: the handwritten lighthouse plot, played
 *       along the proof its own solver found. Written to web/public/replays/.
 *
 *   npm run replay:make -- --case <case.json> --solver --id <name> --out <folder>
 *       Any case file that passes the gate, played along its solver's proof.
 *
 *   npm run replay:make -- --case <case.json> --detective <replies.json> --id <name> --out <folder>
 *       A game the detective agent played: its saved replies are run through the detective's
 *       own code again, with no model, and the moves it made are played back.
 *
 * Nothing is sent and nothing is spent. A replay is only made of a game the scorer calls
 * solved. It gives away its case's answer: put one in web/public/replays/ only when the
 * case is meant to be public. To look at one first, write it to cases/generated/replays/,
 * which git ignores and no build publishes; `npm run dev` lists what is there.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DetectiveReply } from "../src/agents/detective";
import type { Case } from "../src/case/schema";
import { loadCase } from "../src/game/load-case";
import { detectiveMoves, makeReplay, solverMoves, type ReplayPlayer } from "../src/web/replay";
import { compilePlot } from "../src/writer/compile";
import { lighthousePeople, lighthouseSkeleton } from "../src/writer/fixtures/lighthouse";
import { writeReplay } from "./replay-files";
import { say } from "./say";

const repo = resolve(import.meta.dirname, "..");
const stop = (en: string, zh: string): never => {
  say(`${en} Nothing was written.`, `${zh}没有写入任何内容。`);
  process.exit(1);
};
const usage = (): never => stop("Usage: --builtin, or --case <file> (--solver | --detective <file>) --id <name> --out <folder>.", "用法：--builtin，或 --case <文件> (--solver | --detective <文件>) --id <名称> --out <目录>。");

/** Every option at most once, and none that is not known. */
const args = process.argv.slice(2);
const options = new Map<string, string | true>();
for (let i = 0; i < args.length; i++) {
  const name = args[i]!;
  if (options.has(name)) usage();
  if (name === "--builtin" || name === "--solver") options.set(name, true);
  else if (["--case", "--detective", "--id", "--out"].includes(name) && args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) options.set(name, args[++i]!);
  else usage();
}
const text = (name: string): string | undefined => (typeof options.get(name) === "string" ? (options.get(name) as string) : undefined);

let c: Case;
let id: string;
let out: string;
let from: "solver" | "detective";
if (options.has("--builtin")) {
  if (options.size !== 1) usage();
  const built = compilePlot("lighthouse", lighthouseSkeleton, lighthousePeople);
  if (!built.ok) throw new Error("the lighthouse plot does not compile");
  c = built.case;
  id = "lighthouse";
  out = resolve(repo, "web/public/replays");
  from = "solver";
} else {
  const casePath = text("--case");
  const named = text("--id");
  const folder = text("--out");
  if (!casePath || !named || !folder || options.has("--solver") === options.has("--detective")) usage();
  let loaded: ReturnType<typeof loadCase>;
  try {
    loaded = loadCase(readFileSync(casePath!, "utf8"));
  } catch {
    stop("The case file could not be read.", "无法读取案件文件。");
    throw new Error("unreachable");
  }
  if (!loaded.ok) {
    stop(`The case file was refused: ${loaded.why[0]}`, `案件文件未通过检查：${loaded.why[1]}`);
    throw new Error("unreachable");
  }
  c = loaded.c;
  id = named!;
  out = resolve(folder!);
  from = options.has("--solver") ? "solver" : "detective";
}

let player: ReplayPlayer = { kind: "solver" };
let moves;
if (from === "solver") {
  const proof = await solverMoves(c);
  if (!proof.ok) {
    stop("The solver has no proof for this case.", "求解器没有找到这个案件的证明。");
    throw new Error("unreachable");
  }
  moves = proof.moves;
} else {
  let replies: DetectiveReply[];
  try {
    const parsed = JSON.parse(readFileSync(text("--detective")!, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not a list");
    replies = parsed as DetectiveReply[];
  } catch {
    stop("The detective's saved replies could not be read.", "无法读取侦探保存的回复。");
    throw new Error("unreachable");
  }
  const game = await detectiveMoves(c, replies);
  if (!game.ok) {
    stop("The saved replies are not one game's, in order, with their cost confirmed.", "保存的回复不是同一局按顺序、且费用已确认的回复。");
    throw new Error("unreachable");
  }
  moves = game.moves;
  player = game.player;
}

const made = await makeReplay(c, moves, { id, player });
if (!made.ok) {
  const why: Record<typeof made.why, [string, string]> = {
    "bad-id": ["The name may only have lower-case letters, digits and hyphens.", "名称只能包含小写字母、数字和连字符。"],
    "illegal-move": ["One of the moves cannot be made in this case.", "其中一步在这个案件里无法执行。"],
    "no-accusation": ["The game does not end in an accusation.", "这一局没有以指认结束。"],
    "not-solved": ["The scorer does not call this game solved.", "判分结果不是“已破解”。"],
    "no-proof": ["The solver has no proof for this case.", "求解器没有找到这个案件的证明。"],
    "bad-replies": ["The saved replies cannot be used.", "保存的回复无法使用。"],
  };
  stop(why[made.why][0], why[made.why][1]);
  throw new Error("unreachable");
}
const written = writeReplay(out, made.replay);
if (!written.ok) {
  stop(`${out} has an index.json that is not a replay index.`, `${out} 里的 index.json 不是回放索引。`);
  throw new Error("unreachable");
}
say(
  `Replay "${id}": ${made.replay.frames.length} frames, ${made.replay.actions} actions, solved. Written: ${written.files.join(", ")}`,
  `回放“${id}”：${made.replay.frames.length} 帧，${made.replay.actions} 次行动，已破解。已写入：${written.files.join("、")}`,
);
