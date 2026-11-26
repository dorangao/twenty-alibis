import { describe, expect, it } from "vitest";
import { archivePass } from "../src/case/fixtures/archive";
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
    expect(claimed.ok).toBe(false);
    if (claimed.ok) throw new Error("expected a refusal");
    expect(claimed.why[0]).toMatch(/^the case in the file is refused: /);
    expect(claimed.why[1]).toMatch(/^文件里的案件未通过检查：/);
    // A case that is well formed and true, but which no player could prove in the actions allowed:
    // the validator passes it and the solver does not. It is not played either.
    const tooShort = { ...lighthouse, sessionCap: 2 };
    const check = checkCase(tooShort);
    expect(check.validation.ok).toBe(true);
    expect(check.accepted).toBe(false);
    const unprovable = loadCase(JSON.stringify({ accepted: true, case: tooShort }));
    expect(unprovable.ok).toBe(false);
    expect(loadCase(JSON.stringify(tooShort)).ok).toBe(false);
    // A report that says it was refused, holding a good case, is still judged by the case.
    expect(loadCase(JSON.stringify({ accepted: false, case: lighthouse }))).toMatchObject({ ok: true });
  });

  it("refuses what is not a case", () => {
    for (const text of ["", "not json", "null", "[]", "7", "{}", JSON.stringify({ case: null }), JSON.stringify({ case: { title: "x" } }), JSON.stringify({ ...lighthouse, suspects: [] })]) {
      expect(loadCase(text), text.slice(0, 20)).toMatchObject({ ok: false });
    }
    expect(loadCase("not json")).toEqual({ ok: false, why: ["the file is not JSON", "文件不是 JSON"] });
    expect(loadCase("[]")).toEqual({ ok: false, why: ["the file does not hold a case", "文件里没有案件"] });
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
