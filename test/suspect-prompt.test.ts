import { describe, expect, it } from "vitest";
import { renderAssertion } from "../src/agents/render";
import { publicBriefing, recallResult, recallTool, suspectIdentity, suspectSystemMessages } from "../src/agents/suspect-prompt";
import { archivePass } from "../src/case/fixtures/archive";

const c = archivePass;
const everything = (suspectId: string) =>
  [...suspectSystemMessages(c, suspectId).map((m) => m.content), JSON.stringify(recallTool(c, suspectId))].join("\n");

describe("what a suspect is shown", () => {
  it("never includes evidence the player has not been given", () => {
    const hidden = c.evidence.filter((e) => !c.briefing.evidence.includes(e.id));
    expect(hidden.map((e) => e.id)).toEqual(["e-attendance-log"]);
    for (const s of c.suspects) {
      for (const e of hidden) {
        expect(everything(s.id)).not.toContain(e.text.en);
        expect(everything(s.id)).not.toContain(e.text.zh);
        expect(everything(s.id)).not.toContain(e.id);
      }
    }
  });

  it("never includes the answer key, anyone's true whereabouts, or which statements are lies", () => {
    for (const s of c.suspects) {
      const text = everything(s.id);
      expect(text).not.toContain("culprit");
      expect(text).not.toContain("whereabouts");
      expect(text).not.toMatch(/\blie\b|\blies\b|lying|说谎|撒谎/);
      // No raw ids of assertions, means or motives: those belong to the case file.
      for (const a of c.assertions) expect(text).not.toContain(a.id);
      expect(text).not.toContain("mo-debt");
      expect(text).not.toContain("m-key");
    }
  });

  it("gives every suspect the same briefing, word for word, so it can be cached", () => {
    const first = suspectSystemMessages(c, "s-ada")[0]!.content;
    for (const s of c.suspects) expect(suspectSystemMessages(c, s.id)[0]!.content).toBe(first);
    expect(first).toBe(publicBriefing(c));
  });

  it("gives each suspect only its own identity and voice", () => {
    const ada = suspectIdentity(c, "s-ada");
    expect(ada).toContain("Ada Marlow");
    expect(ada).toContain("Precise, quick to correct others");
    expect(ada).not.toContain("Ben Okafor");
    // Ben's manner of speaking is not in Ada's prompt at all.
    expect(everything("s-ada")).not.toContain("answers in as few words as he can");
    expect(() => suspectIdentity(c, "s-nobody")).toThrow();
  });

  it("offers only the suspect's own topics, plus none", () => {
    const tool = recallTool(c, "s-ada");
    expect((tool.parameters as any).properties.topic.enum).toEqual(["t-ada-2100", "none"]);
    expect(JSON.stringify(tool)).not.toContain("t-ben-2100");
    expect((recallTool(c, "s-clara").parameters as any).properties.topic.enum).toEqual(["none"]);
  });
});

describe("what recall returns", () => {
  it("returns what the suspect says, in both languages, without saying whether it is true", () => {
    // Ada's statement is false in the hidden truth. Nothing in the result says so.
    expect(JSON.parse(recallResult(c, "s-ada", "t-ada-2100"))).toEqual({
      topic: "t-ada-2100",
      statements: [{ id: "a-ada-foyer-2100", en: "I was in the foyer at 21:00.", zh: "21:00 我在门厅。" }],
    });
    // Ben's is true. The two results have exactly the same shape.
    expect(JSON.parse(recallResult(c, "s-ben", "t-ben-2100"))).toEqual({
      topic: "t-ben-2100",
      statements: [{ id: "a-ben-foyer-2100", en: "I was in the foyer at 21:00.", zh: "21:00 我在门厅。" }],
    });
  });

  it("returns nothing for another suspect's topic, an unknown topic, or none", () => {
    for (const topic of ["t-ben-2100", "t-made-up", "none"]) {
      expect(JSON.parse(recallResult(c, "s-ada", topic))).toEqual({ topic: "none", statements: [] });
    }
  });
});

describe("rendering an assertion", () => {
  const byId = (id: string) => c.assertions.find((a) => a.id === id)!;

  it("uses the first person for the speaker and the name for anyone else", () => {
    expect(renderAssertion(c, "s-ada", byId("a-ada-archive-2100"), "en")).toBe("I was in the archive at 21:00.");
    expect(renderAssertion(c, "s-ben", byId("a-ada-archive-2100"), "en")).toBe("Ada Marlow was in the archive at 21:00.");
    expect(renderAssertion(c, "s-ben", byId("a-ada-archive-2100"), "zh")).toBe("21:00 马艾达在档案室。");
  });

  it("renders means and motives in both languages", () => {
    expect(renderAssertion(c, "s-ada", byId("a-ada-key"), "en")).toBe("I have a key to the archive.");
    expect(renderAssertion(c, "s-ben", byId("a-ada-key"), "zh")).toBe("马艾达有档案室钥匙。");
    expect(renderAssertion(c, "s-ada", byId("a-ada-debt"), "en")).toBe("I had a motive: Owed the victim a debt that was about to be called in.");
    expect(renderAssertion(c, "s-ben", byId("a-ben-will"), "zh")).toBe("我有动机：即将被从遗嘱中除名。");
  });
});
