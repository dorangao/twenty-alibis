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
});
