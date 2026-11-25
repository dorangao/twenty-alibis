import { describe, expect, it } from "vitest";
import { guardLine, languageOf, mentions, MAX_LINE_CHARS, type GuardReason } from "../src/agents/line-guard";
import { renderAssertion } from "../src/agents/render";
import { archivePass as c } from "../src/case/fixtures/archive";
import type { Assertion } from "../src/case/schema";

const the = (id: string): Assertion[] => c.assertions.filter((a) => a.id === id);
const adaFoyer = the("a-ada-foyer-2100");
const benFoyer = the("a-ben-foyer-2100");
const adaKey = the("a-ada-key");
const adaNoKey: Assertion[] = [{ id: "a-ada-no-key", prop: { kind: "means", subject: "s-ada", means: "m-key", value: false } }];

const ok = (speaker: string, accepted: Assertion[], line: string, lang: "en" | "zh" = languageOf(line)) =>
  expect(guardLine(c, speaker, accepted, line, lang), line).toEqual({ ok: true });
const refused = (reason: GuardReason, speaker: string, accepted: Assertion[], line: string, lang: "en" | "zh" = languageOf(line)) =>
  expect(guardLine(c, speaker, accepted, line, lang), line).toMatchObject({ ok: false, reason });

describe("the line guard lets a suspect speak in its own voice", () => {
  it("accepts the lines Muse Ember actually wrote for these statements", () => {
    ok("s-ada", adaFoyer, "At 21:00 I was in the foyer. Please note the exact time — I do not approximate.");
    ok("s-ada", adaFoyer, "21:00 我在门厅。请说清楚，我不喜欢被催促。");
    ok("s-ada", adaFoyer, "Precisely: I was in the foyer at 21:00.");
    ok("s-ben", benFoyer, "Foyer. At 21:00.");
    ok("s-ben", benFoyer, "21:00 我在门厅。");
  });

  it("accepts a deflection that names nothing from the case", () => {
    ok("s-ada", [], "I don't know who did it. I won't name someone without evidence, especially when I'm being rushed.");
    ok("s-ben", [], "不知道。问我没用。");
    ok("s-ada", [], "I have nothing else to say.");
    ok("s-ada", [], "At one point you will have to stop asking.");
  });

  it("reads one time the same however it is written", () => {
    ok("s-ada", adaFoyer, "I was in the foyer at nine.");
    ok("s-ada", adaFoyer, "Foyer, 9 p.m. sharp.");
    ok("s-ada", adaFoyer, "九点我在门厅。");
    ok("s-ada", adaFoyer, "晚上9点我在门厅。");
    expect(mentions(c, "nine o'clock").sort()).toEqual(["time 9:00"]);
    expect(mentions(c, "half past nine, 9:30, 21时30分, 九点半").sort()).toEqual(["time 9:30"]);
    expect(mentions(c, "十二点, noon, 中午, at 12").sort()).toEqual(["time 0:00"]);
    expect(mentions(c, "九点二十")).toEqual(["time 9:20"]);
  });

  it("does not take the everyday 一点 for one o'clock", () => {
    ok("s-ada", adaFoyer, "21:00 我在门厅。快一点问。");
    expect(mentions(c, "一点半")).toEqual(["time 1:30"]);
  });

  it("lets a suspect use its own name and role, and a short form of a place", () => {
    ok("s-ada", adaFoyer, "I am the archivist's assistant. I was in the foyer at 21:00.");
    ok("s-ada", adaFoyer, "我是档案助理，21:00 在门厅。");
    ok("s-clara", the("a-clara-dining-2100"), "I was in the hall at 21:00.");
  });
});

describe("the line guard refuses a line that says more than the statements", () => {
  it("refuses another person, place or time", () => {
    refused("uncovered", "s-ada", adaFoyer, "I was in the foyer at 21:00 with Ben.");
    refused("uncovered", "s-ben", benFoyer, "21:00 我在门厅。去问艾达。");
    refused("uncovered", "s-ada", adaFoyer, "I was in the archive at 21:00.");
    refused("uncovered", "s-ada", adaFoyer, "I was in the foyer at 21:00, far from the hall.");
    refused("uncovered", "s-ada", adaFoyer, "At 21:20 I was in the foyer.");
    refused("uncovered", "s-ada", adaFoyer, "I was in the foyer at nine thirty.");
    refused("uncovered", "s-ada", adaFoyer, "九点半我在门厅。");
    refused("uncovered", "s-ada", adaFoyer, "I was in the foyer at 21:00, and left after 20 minutes.");
  });

  it("names what was not covered, so the retry can be told", () => {
    expect(guardLine(c, "s-ada", adaFoyer, "I was in the foyer at 21:00 with Ben.", "en")).toEqual({ ok: false, reason: "uncovered", detail: "ben" });
  });

  it("refuses any case fact in a line that makes no statement", () => {
    refused("uncovered", "s-ada", [], "Ask Ben.");
    refused("uncovered", "s-ada", [], "I was in the foyer at 21:00.");
    refused("uncovered", "s-ada", [], "我有钥匙。");
  });

  it("refuses the known hole: a claim about everyone else", () => {
    refused("exclusive", "s-ada", adaFoyer, "I was in the foyer at 21:00. Alone.");
    refused("exclusive", "s-ada", adaFoyer, "我九点在门厅。就我一个。");
    refused("exclusive", "s-ada", adaFoyer, "I was in the foyer at 21:00, nobody else was there.");
  });

  it("refuses a line that turns the statement round", () => {
    refused("polarity", "s-ada", adaFoyer, "I was not in the foyer at 21:00.");
    refused("polarity", "s-ada", adaFoyer, "At 21:00, I wasn't in the foyer.");
    refused("polarity", "s-ada", adaFoyer, "21:00 我不在门厅。");
    // A "not" that is not about a case fact is only a manner of speaking.
    ok("s-ada", adaFoyer, "I was in the foyer at 21:00. I don't like being rushed.");
    ok("s-ada", adaFoyer, "No, I was in the foyer at 21:00.");
  });

  it("holds a denial to its negative", () => {
    ok("s-ada", adaNoKey, "I don't have a key.");
    ok("s-ada", adaNoKey, "我没有钥匙。");
    refused("polarity", "s-ada", adaNoKey, "I have a key.");
  });

  it("refuses a line that leaves the statement out", () => {
    refused("omits", "s-ada", adaFoyer, "I'd rather not say.");
    refused("omits", "s-ada", benFoyer, "I was in the foyer at 21:00.");
    ok("s-ada", benFoyer, "Ben was in the foyer at 21:00.");
  });

  it("does not count a word the means shares with a place as naming the means", () => {
    ok("s-ada", adaKey, "Yes, I have a key.");
    ok("s-ada", adaKey, "I have a key to the archive.");
    ok("s-ada", adaKey, "我有钥匙。");
    refused("omits", "s-ada", adaKey, "I work in the archive.");
    refused("omits", "s-ada", adaKey, "我在档案室工作。");
  });

  it("refuses the wrong language, a blank line, a long line and a step out of character", () => {
    refused("wrong-language", "s-ada", adaFoyer, "21:00 我在门厅。", "en");
    refused("wrong-language", "s-ada", adaFoyer, "I was in the foyer at 21:00.", "zh");
    refused("empty", "s-ada", adaFoyer, "   ", "en");
    refused("too-long", "s-ada", adaFoyer, `I was in the foyer at 21:00. ${"Really. ".repeat(MAX_LINE_CHARS / 8)}`);
    refused("breaks-character", "s-ada", adaFoyer, "As an AI, I was in the foyer at 21:00.");
    refused("breaks-character", "s-ada", adaFoyer, "作为语言模型，21:00 我在门厅。");
  });

  it("passes every code-rendered sentence, whoever says it, in both languages", () => {
    // The fallback line must itself pass the guard, or a turn could end with nothing to show.
    for (const a of c.assertions) {
      for (const speaker of [a.prop.subject, a.prop.subject === "s-ada" ? "s-ben" : "s-ada"]) {
        for (const lang of ["en", "zh"] as const) ok(speaker, [a], renderAssertion(c, speaker, a, lang), lang);
      }
    }
  });
});
