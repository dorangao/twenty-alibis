import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { archiveFailTwin, archivePass } from "../src/case/fixtures/archive";
import type { Case } from "../src/case/schema";
import { loadCase } from "../src/game/load-case";
import { loadLibrary, previewReplayFile } from "../src/web/library";
import { replayOf } from "../web/src/replay-shape";
import { idsIn, ISSUE_ZH, REASON_ZH, reasonZh } from "../scripts/case-reasons";

const repo = resolve(import.meta.dirname, "..");
const dirs: string[] = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "ta-author-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const run = (script: string, ...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", `scripts/${script}.ts`, ...args], { cwd: repo, encoding: "utf8" });

describe("bringing a case of your own, by the steps the README gives", () => {
  it("writes an example to edit, checks it, lists it in a library, and makes a replay of it", () => {
    const dir = fresh();
    const file = join(dir, "my-case.json");

    // 1. An example under the author's own name.
    const example = run("case", "example", "--id", "my-case", "--out", file);
    expect(example.status, example.stdout + example.stderr).toBe(0);
    expect(example.stdout).toContain("my-case");
    expect(example.stdout).toContain("已写入");
    const written = JSON.parse(readFileSync(file, "utf8")) as Case;
    expect(written).toEqual({ ...archivePass, id: "my-case" });
    // Laid out to be read and edited.
    expect(readFileSync(file, "utf8").split("\n").length).toBeGreaterThan(200);

    // 2. The author changes it. Here: a new title. It still passes the gate.
    writeFileSync(file, JSON.stringify({ ...written, title: { en: "My Own Case", zh: "我自己的案件" } }, null, 2));
    const check = run("case", "check", file);
    expect(check.status, check.stdout).toBe(0);
    expect(check.stdout).toContain("Passes");
    expect(check.stdout).toContain("通过");

    // 3. It is what a player's commands take, and what a server's library lists beside the built-in case.
    expect(loadCase(readFileSync(file, "utf8"))).toMatchObject({ ok: true, c: { id: "my-case" } });
    expect(loadLibrary(dir)).toMatchObject({ cases: [{ id: archivePass.id }, { id: "my-case", title: { en: "My Own Case" } }], skipped: [] });

    // 4. A replay of it along its solver's proof, where the dev server looks for replays to preview.
    const replays = join(dir, "replays");
    const made = run("make-replay", "--case", file, "--solver", "--id", "my-case", "--out", replays);
    expect(made.status, made.stdout + made.stderr).toBe(0);
    expect(JSON.parse(previewReplayFile(replays, "index.json")!)).toMatchObject({ replays: [{ id: "my-case", title: { en: "My Own Case", zh: "我自己的案件" }, player: { kind: "solver" } }] });
    expect(replayOf(JSON.parse(previewReplayFile(replays, "my-case.json")!), "my-case")?.frames.at(-1)?.view.verdict).toMatchObject({ outcome: "solved" });
  }, 60_000);

  it("never writes an example over a file that is there, and takes only a plain name that is not the built-in case's", () => {
    const dir = fresh();
    const file = join(dir, "mine.json");
    writeFileSync(file, "three days of work");
    const over = run("case", "example", "--id", "mine", "--out", file);
    expect(over.status).toBe(1);
    expect(over.stdout).toContain("was not written over");
    expect(over.stdout).toContain("没有覆盖");
    expect(readFileSync(file, "utf8")).toBe("three days of work");

    const out = join(dir, "x.json");
    for (const args of [
      ["example"],
      ["example", "--id"],
      ["example", "--id", "Has Capitals", "--out", out],
      ["example", "--id", "../x", "--out", out],
      ["example", "--id", "a b", "--out", out],
      ["example", "--id", archivePass.id, "--out", out],
      // The name of the list of replays: a case called that could not be made into a replay under its own name.
      ["example", "--id", "index", "--out", out],
      ["example", "--id", "ok", "--id", "twice", "--out", out],
      ["example", "--id", "ok", "--out", out, "--force", "yes"],
      ["example", "--id", "ok", "--out"],
      ["check"],
      ["check", out, "extra"],
      ["publish", out],
      [],
    ]) {
      const r = run("case", ...args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stdout, args.join(" ")).toMatch(/Nothing was (written|done)\./);
    }
    expect(readdirSync(dir)).toEqual(["mine.json"]);
  }, 60_000);

  it("tells the author why a case does not pass, in the gate's own words, and fails", () => {
    const dir = fresh();
    // The handwritten twin: the same answer, and no way for a player to prove it.
    const twin = join(dir, "twin.json");
    writeFileSync(twin, JSON.stringify(archiveFailTwin));
    const unprovable = run("case", "check", twin);
    expect(unprovable.status).toBe(1);
    expect(unprovable.stdout).toContain("Refused");
    expect(unprovable.stdout).toContain("未通过");
    expect(unprovable.stdout.split("\n").filter((line) => line.startsWith("  - ")).length).toBeGreaterThan(0);

    // A culprit the truth does not point at: the reason names people, which is why it is for the author.
    const wrong = join(dir, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ ...archivePass, id: "wrong", culprit: { ...archivePass.culprit, suspect: archivePass.suspects.find((s) => s.id !== archivePass.culprit.suspect)!.id } }));
    const inconsistent = run("case", "check", wrong);
    expect(inconsistent.status).toBe(1);
    expect(inconsistent.stdout).toContain(archivePass.culprit.suspect);
    // Each reason comes in the gate's English and then in Chinese, with the ids the author has to find.
    const lines = inconsistent.stdout.split("\n");
    const first = lines.findIndex((line) => line.startsWith("  - truth: the hidden truth points at"));
    expect(first).toBeGreaterThan(-1);
    expect(lines[first + 1]).toBe(`    ${ISSUE_ZH["culprit-mismatch"]}（涉及：${archivePass.culprit.suspect}、${archivePass.suspects.find((x) => x.id !== archivePass.culprit.suspect)!.id}）`);
    const twinLines = unprovable.stdout.split("\n");
    for (const [i, line] of twinLines.entries()) {
      if (!line.startsWith("  - ")) continue;
      expect(twinLines[i + 1], line).toMatch(/^    [\u4e00-\u9fff]/);
      expect(twinLines[i + 1], line).not.toContain("暂时没有中文说明");
      expect(twinLines[i + 1], line).toContain("（涉及：");
    }
    // The player's command, given the same file, says only that it was refused.
    const played = run("play", "--case", wrong);
    expect(played.status).toBe(1);
    expect(played.stdout).not.toContain(archivePass.culprit.suspect);

    // Not JSON, not there, not a case.
    writeFileSync(join(dir, "broken.json"), "{not json");
    expect(run("case", "check", join(dir, "broken.json")).status).toBe(1);
    expect(run("case", "check", join(dir, "missing.json")).status).toBe(1);
    writeFileSync(join(dir, "other.json"), '{"name":"my-app"}');
    const other = run("case", "check", join(dir, "other.json"));
    expect(other.status).toBe(1);
    expect(other.stdout).toContain("Refused");

    // A case writer's report, which holds its case under "case", is checked as that case.
    writeFileSync(join(dir, "report.json"), JSON.stringify({ accepted: true, case: { ...archivePass, id: "from-a-report" } }));
    expect(run("case", "check", join(dir, "report.json")).status).toBe(0);
  }, 60_000);

  it("has a Chinese explanation for every kind of reason the gate can give", () => {
    // Every code the validator uses. Read from its source, so a code added there and not here fails this test.
    const validator = readFileSync(join(repo, "src/case/validate.ts"), "utf8");
    const codes = [...new Set([...validator.matchAll(/bad\("([a-z-]+)"/g)].map((m) => m[1]!))].sort();
    expect(codes.length).toBeGreaterThan(8);
    expect(Object.keys(ISSUE_ZH).sort()).toEqual(codes);
    // Every sentence the solver and the gate can give: one example of each, as their source writes them.
    const examples = [
      "reachable evidence both places s-ada at the scene and somewhere else",
      "the proof needs 44 actions, but a session allows 40",
      "the proof needs more than 40 actions, which is all a session allows",
      "no suspect has opportunity, means and motive proven by reachable evidence: s-ada (unproven: opportunity)",
      "more than one suspect is fully proven: [s-ada, s-ben]",
      "[s-ada, s-ben] all still fit: no reachable evidence rules out 1 of them (another session leaves [s-ada, s-clara])",
      "reachable evidence rules out every suspect",
      "the lie a-ada-foyer-2100 by s-ada cannot be caught: no single session holds both the statement and an independent record against it",
      "the solver reached its work limit before settling this case, so it is refused",
      "the reachable evidence proves s-ben, but the hidden culprit is s-ada",
    ];
    const ids = idsIn(archivePass);
    const used = new Set<string>();
    for (const example of examples) {
      const zh = reasonZh(example, ids);
      expect(zh, example).not.toContain("暂时没有中文说明");
      used.add(REASON_ZH.find(([pattern]) => pattern.test(example))![1]);
    }
    // Every explanation is reached by an example, and the sources still have as many reasons as there are examples for.
    expect(used.size).toBe(REASON_ZH.length);
    const solver = readFileSync(join(repo, "src/case/solver.ts"), "utf8");
    expect([...solver.matchAll(/reasons\.push\(/g)].length).toBe(9);
    // The ids a sentence mentions are listed in its order, once each, and only if the case has them.
    expect(reasonZh("topic t-missing: s-ada states a-ada-foyer-2100, s-ada again, and s-nobody", ids)).toMatch(/（涉及：s-ada、a-ada-foyer-2100）$/);
    // An id that ends a clause, with a colon after it, is still found: the validator writes "topic <id>: ...".
    const topic = archivePass.actions.topics[0]!;
    expect(reasonZh(`topic ${topic.id}: ${topic.suspect} states something false`, ids)).toMatch(new RegExp(`（涉及：${topic.id}、${topic.suspect}）$`));
    expect(reasonZh("reachable evidence rules out every suspect", ids)).not.toContain("涉及");
    // A fault in the file's form, and a reason this file has never heard of.
    expect(reasonZh("sessionCap: expected number", ids, { layer: "schema", code: "invalid_type" })).toContain("格式");
    expect(reasonZh("something new", ids)).toContain("暂时没有中文说明");
    // Ids are found wherever the file puts them, whatever its shape.
    expect([...idsIn({ slots: ["21:00", 7], a: [{ id: "x" }, { b: { id: "y", id2: "no" } }], id: 5 })].sort()).toEqual(["21:00", "x", "y"]);
  });
});
