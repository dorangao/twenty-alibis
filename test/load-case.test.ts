import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { archiveFailTwin, archivePass } from "../src/case/fixtures/archive";
import { checkCase } from "../src/case/solver";
import { loadCase, parsePlayArgs } from "../src/game/load-case";
import { createGame, noModel } from "../src/game/terminal";
import { compilePlot } from "../src/writer/compile";
import { lighthousePeople, lighthouseSkeleton } from "../src/writer/fixtures/lighthouse";

const compiled = compilePlot("lighthouse", lighthouseSkeleton, lighthousePeople);
if (!compiled.ok) throw new Error(compiled.problems.join("; "));
const lighthouse = compiled.case;

describe("a case read from a file, for playing", () => {
  it("reads a bare case and a writer's report, and the game opens on it", () => {
    const bare = loadCase(JSON.stringify(lighthouse));
    const report = loadCase(JSON.stringify({ accepted: true, reasons: [], case: lighthouse }));
    expect(bare).toEqual({ ok: true, c: lighthouse });
    expect(report).toEqual({ ok: true, c: lighthouse });
    if (!report.ok) throw new Error("expected a case");
    const opening = createGame(report.c, noModel, "t", { language: "zh", modelOff: true }).opening().join("\n");
    expect(opening).toContain(lighthouse.title.zh);
    expect(opening).toContain(lighthouse.setting.zh);
    expect(opening).not.toContain(lighthouse.setting.en);
    expect(loadCase(JSON.stringify(archivePass))).toMatchObject({ ok: true });
  });

  it("takes nothing in the file at its word: the case goes through the gate, whatever the report says", () => {
    // Two people now fit: the second is given the culprit's whereabouts, so the case cannot be proven.
    const lamp = lighthouse.suspects.find((s) => s.id === lighthouse.culprit.suspect)!;
    const other = lighthouse.suspects.find((s) => s.id !== lamp.id)!;
    const broken = { ...lighthouse, culprit: { ...lighthouse.culprit, suspect: other.id } };
    const claimed = loadCase(JSON.stringify({ accepted: true, case: broken }));
    expect(claimed).toEqual({ ok: false, refusal: "inconsistent", why: ["the case in the file does not hold together", "文件里的案件自相矛盾"] });
    // A case that is well formed and true, but which no player could prove in the actions allowed:
    // the validator passes it and the solver does not. It is not played either.
    const tooShort = { ...lighthouse, sessionCap: 2 };
    const check = checkCase(tooShort);
    expect(check.validation.ok).toBe(true);
    expect(check.accepted).toBe(false);
    const unprovable = loadCase(JSON.stringify({ accepted: true, case: tooShort }));
    expect(unprovable).toEqual({ ok: false, refusal: "unprovable", why: ["the case in the file cannot be proven by a player", "文件里的案件无法由玩家证明"] });
    expect(loadCase(JSON.stringify(tooShort))).toMatchObject({ ok: false, refusal: "unprovable" });
    expect(loadCase(JSON.stringify(archiveFailTwin))).toMatchObject({ ok: false, refusal: "unprovable" });
    // A report that says it was refused, holding a good case, is still judged by the case.
    expect(loadCase(JSON.stringify({ accepted: false, case: lighthouse }))).toMatchObject({ ok: true });
  });

  it("refuses what is not a case", () => {
    for (const text of ["", "not json", "null", "[]", "7", "{}", JSON.stringify({ case: null }), JSON.stringify({ case: { title: "x" } }), JSON.stringify({ ...lighthouse, suspects: [] })]) {
      expect(loadCase(text), text.slice(0, 20)).toMatchObject({ ok: false });
    }
    expect(loadCase("not json")).toEqual({ ok: false, refusal: "not-json", why: ["the file is not JSON", "文件不是 JSON"] });
    expect(loadCase("[]")).toEqual({ ok: false, refusal: "not-a-case", why: ["the file does not hold a case", "文件里没有案件"] });
    expect(loadCase(JSON.stringify({ case: { title: "x" } }))).toMatchObject({ ok: false, refusal: "malformed" });
    expect(loadCase(JSON.stringify({ ...lighthouse, suspects: [] }))).toMatchObject({ ok: false, refusal: "malformed" });
  });

  it("a refusal tells the player nothing about the hidden truth: no person, place or fact of the case", () => {
    // The gate's own reasons for these name the people involved. None of that may reach the player.
    const mismatch = { ...archivePass, culprit: { ...archivePass.culprit, suspect: archivePass.suspects.find((s) => s.id !== archivePass.culprit.suspect)!.id } };
    const cases: [string, unknown, typeof archivePass][] = [
      ["a culprit the truth does not point at", mismatch, archivePass],
      ["a proof no player can reach", archiveFailTwin, archiveFailTwin],
      ["a 20-person case with too few actions", { ...lighthouse, sessionCap: 2 }, lighthouse],
      ["a 20-person case with the wrong culprit", { ...lighthouse, culprit: { ...lighthouse.culprit, suspect: "s-01" } }, lighthouse],
    ];
    for (const [what, file, source] of cases) {
      // The gate does say something specific, which is why this matters.
      expect(checkCase(file).reasons.join(" "), what).toMatch(/s-[a-z0-9]+/);
      const refused = loadCase(JSON.stringify({ accepted: true, case: file }));
      if (refused.ok) throw new Error(`expected a refusal: ${what}`);
      const said = refused.why.join(" ");
      const secrets = [
        ...source.suspects.flatMap((s) => [s.id, s.name.en, s.name.zh]),
        ...source.locations.flatMap((l) => [l.id, l.name.en, l.name.zh]),
        ...source.evidence.map((e) => e.id),
        ...source.assertions.map((a) => a.id),
        "culprit",
        "hidden truth",
      ];
      for (const secret of secrets) expect(said, `${what}: ${secret}`).not.toContain(secret);
      expect(said, what).not.toMatch(/\b[a-z]+-[a-z0-9]+\b/);
      // The Chinese message has no English in it.
      expect(refused.why[1], what).not.toMatch(/[A-Za-z]/);
    }
  });

  it("the play command says what its check of a file covers, and then opens the game", () => {
    const dir = mkdtempSync(join(tmpdir(), "play-"));
    const path = join(dir, "good.json");
    writeFileSync(path, JSON.stringify({ accepted: false, case: lighthouse }));
    const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/play.ts", "--zh", "--case", path], { encoding: "utf8", input: "quit\n", env: { PATH: process.env.PATH ?? "" } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("That is not the case writer's quality check.");
    expect(run.stdout).toContain("这不等于案件写作的质量检查。");
    expect(run.stdout).toContain(lighthouse.title.zh);
    expect(run.stdout).toContain("模型已关闭");
    // The handwritten case is played without that notice.
    const plain = spawnSync(process.execPath, ["--import", "tsx", "scripts/play.ts"], { encoding: "utf8", input: "quit\n", env: { PATH: process.env.PATH ?? "" } });
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain(archivePass.title.en);
    expect(plain.stdout).not.toContain("quality check");
  });

  it("the play command itself prints only that much, and ends before the game opens", () => {
    const dir = mkdtempSync(join(tmpdir(), "play-"));
    const other = archivePass.suspects.find((s) => s.id !== archivePass.culprit.suspect)!;
    const files: [string, unknown][] = [
      ["mismatch.json", { accepted: true, case: { ...archivePass, culprit: { ...archivePass.culprit, suspect: other.id } } }],
      ["unreachable.json", archiveFailTwin],
    ];
    for (const [name, content] of files) {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(content));
      for (const flags of [["--zh"], []]) {
        const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/play.ts", ...flags, "--case", path], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
        expect(run.status, name).toBe(1);
        const out = `${run.stdout}${run.stderr}`;
        for (const s of archivePass.suspects) for (const secret of [s.id, s.name.en, s.name.zh]) expect(out, `${name}: ${secret}`).not.toContain(secret);
        expect(out).not.toContain(archivePass.title.en);
        expect(out).toContain(name === "mismatch.json" ? "文件里的案件自相矛盾" : "文件里的案件无法由玩家证明");
      }
    }
  });
});

describe("the terminal game's arguments", () => {
  it("reads the forms it knows", () => {
    expect(parsePlayArgs([])).toEqual({ ok: true, language: "en", live: false, casePath: null });
    expect(parsePlayArgs(["--zh"])).toEqual({ ok: true, language: "zh", live: false, casePath: null });
    expect(parsePlayArgs(["--live", "--zh"])).toEqual({ ok: true, language: "zh", live: true, casePath: null });
    expect(parsePlayArgs(["--case", "a/b.json"])).toEqual({ ok: true, language: "en", live: false, casePath: "a/b.json" });
    expect(parsePlayArgs(["--case=a/b.json", "--zh"])).toEqual({ ok: true, language: "zh", live: false, casePath: "a/b.json" });
  });

  it("refuses everything else, so a mistyped flag never changes what the game may send", () => {
    const bad: string[][] = [["--lve"], ["--Live"], ["--live", "--live"], ["--zh", "--zh"], ["--en"], ["zh"], ["--case"], ["--case="], ["--case", "--zh"], ["--case", "a.json", "--case", "b.json"], ["--case=a.json", "--case=b.json"], ["--cases", "a.json"], ["a.json"], [""], ["--live=1"]];
    for (const argv of bad) expect(parsePlayArgs(argv), argv.join(" ")).toMatchObject({ ok: false });
  });
});
