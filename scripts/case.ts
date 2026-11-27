/**
 * For someone writing a case of their own.
 * 给想自己写案件的人。
 *
 *   npm run case -- example --id <name> [--out <file>]
 *       Writes the handwritten eight-suspect case out as a JSON file under a name of your
 *       own, to edit. Default file: cases/generated/<name>.json, where `npm run dev` looks.
 *       An existing file is never written over.
 *
 *   npm run case -- check <file>
 *       Puts a case file through the gate every case passes before anyone plays it: the
 *       form, that the hidden truth holds together, and that a player can prove it. Says
 *       why if it does not pass, each reason in the gate's own English and then in Chinese
 *       with the ids involved. The reasons name the people and facts of the case's answer:
 *       they are for its author. A player is only ever told that a file was refused.
 *
 * Neither sends anything or spends anything. A case that passes can be played
 * (`npm run play -- --case <file>`), is listed by `npm run dev` if it is in
 * cases/generated/, and can be made into a replay (`npm run replay:make`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { archivePass } from "../src/case/fixtures/archive";
import { checkCase } from "../src/case/solver";
import { idsIn, reasonZh } from "./case-reasons";
import { say } from "./say";

const repo = resolve(import.meta.dirname, "..");
const stop = (en: string, zh: string): never => {
  say(en, zh);
  process.exit(1);
};
const usage = (): never => stop("Usage: example --id <name> [--out <file>], or check <file>. Nothing was done.", "用法：example --id <名称> [--out <文件>]，或 check <文件>。没有执行任何操作。");

const [command, ...rest] = process.argv.slice(2);

if (command === "example") {
  // Every option at most once, and none that is not known.
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]!;
    const value = rest[i + 1];
    if ((name !== "--id" && name !== "--out") || options.has(name) || value === undefined || value.startsWith("--")) usage();
    options.set(name, value!);
  }
  const id = options.get("--id") ?? usage();
  // The name is also the file's name, which is how the dev server finds a case.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 60) stop("The name may only have lower-case letters, digits and hyphens. Nothing was written.", "名称只能包含小写字母、数字和连字符。没有写入任何内容。");
  if (id === "index") stop("\"index\" is the name of the list of replays, so a case called that could not be made into a replay under its own name. Choose another. Nothing was written.", "“index”是回放列表的名称，叫这个名字的案件无法用自己的名字生成回放。请换一个。没有写入任何内容。");
  if (id === archivePass.id) stop("That is the built-in case's own name, and a library lists a name once. Choose another. Nothing was written.", "这是内置案件自己的名称，而案件库里一个名称只列一次。请换一个。没有写入任何内容。");
  const out = resolve(options.get("--out") ?? resolve(repo, "cases/generated", `${id}.json`));
  mkdirSync(dirname(out), { recursive: true });
  try {
    // "wx": made only if it is not there. A file that exists is somebody's work.
    writeFileSync(out, `${JSON.stringify({ ...archivePass, id }, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") stop(`${out} is already there and was not written over. Nothing was written.`, `${out} 已经存在，没有覆盖。没有写入任何内容。`);
    throw error;
  }
  say(
    `Wrote ${out}: the handwritten case under the name "${id}". Edit it, then run: npm run case -- check ${out}`,
    `已写入 ${out}：手写案件，名称改为“${id}”。修改之后运行：npm run case -- check ${out}`,
  );
} else if (command === "check") {
  if (rest.length !== 1) usage();
  const file = rest[0]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    stop(`${file} could not be read as JSON.`, `无法把 ${file} 读成 JSON。`);
  }
  // A case writer's report holds its case under "case"; a bare case is the case itself.
  const inner = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { case?: unknown }).case : undefined;
  const candidate = inner && typeof inner === "object" ? inner : parsed;
  const gate = checkCase(candidate);
  if (gate.accepted) {
    const proof = gate.solve?.proof;
    say(
      `Passes: well formed, consistent, and provable by a player${proof ? ` in ${proof.actions.length} action(s)` : ""}. This is not the case writer's quality check.`,
      `通过：格式正确、自洽，玩家可以证明${proof ? `（${proof.actions.length} 次行动）` : ""}。这不等于案件写作的质量检查。`,
    );
  } else {
    say(`Refused, for ${gate.reasons.length} reason(s). They name the case's answer: they are for its author.`, `未通过，共 ${gate.reasons.length} 条原因。原因里会提到案件的答案：这是给作者看的。`);
    // Each reason in the gate's own words, then in Chinese: what kind of fault it is, and the ids to look for.
    const ids = idsIn(candidate);
    const issues = gate.validation.ok ? [] : gate.validation.issues;
    for (const [i, reason] of gate.reasons.entries()) {
      console.log(`  - ${reason}`);
      console.log(`    ${reasonZh(reason, ids, issues[i])}`);
    }
    process.exit(1);
  }
} else usage();
