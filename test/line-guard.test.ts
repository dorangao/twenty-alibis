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
    expect(mentions(c, "half past nine, 9:30, 九点半").sort()).toEqual(["time 9:30"]);
    expect(mentions(c, "十二点, at 12")).toEqual(["time 0:00"]);
    expect(mentions(c, "九点二十")).toEqual(["time 9:20"]);
  });

  it("keeps morning and evening apart when the line says which it means", () => {
    // The statement is about 21:00. A bare "nine" fits; a morning nine does not.
    for (const line of ["I was in the foyer at 21:00.", "I was in the foyer at 9:00.", "I was in the foyer at 9 pm.", "I was in the foyer at nine in the evening.", "晚上九点我在门厅。", "21点我在门厅。"]) {
      ok("s-ada", adaFoyer, line);
    }
    for (const line of ["I was in the foyer at 09:00.", "I was in the foyer at 9 a.m.", "I was in the foyer at nine in the morning.", "上午九点我在门厅。", "早上9点我在门厅。"]) {
      refused("uncovered", "s-ada", adaFoyer, line);
    }
    expect(mentions(c, "21:00")).toEqual(["time 9:00 pm"]);
    expect(mentions(c, "09:00")).toEqual(["time 9:00 am"]);
    expect(mentions(c, "21时30分")).toEqual(["time 9:30 pm"]);
    expect(mentions(c, "noon").concat(mentions(c, "中午"))).toEqual(["time 0:00 pm", "time 0:00 pm"]);
    expect(mentions(c, "midnight").concat(mentions(c, "午夜"))).toEqual(["time 0:00 am", "time 0:00 am"]);
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

  it("refuses a line that leaves the time of a statement out", () => {
    // "Foyer." after "Where were you at 21:00?" reads well, but nothing in the line ties it to 21:00.
    refused("omits", "s-ada", adaFoyer, "I was in the foyer.");
    refused("omits", "s-ben", benFoyer, "Foyer.");
    refused("omits", "s-ada", adaFoyer, "我在门厅。");
    expect(guardLine(c, "s-ada", adaFoyer, "I was in the foyer.", "en")).toEqual({ ok: false, reason: "omits", detail: "a-ada-foyer-2100 (time)" });
    ok("s-ben", benFoyer, "Foyer. Nine o'clock.");
    // A bare number word is not read as a time, so this one falls back to code's sentence.
    refused("omits", "s-ben", benFoyer, "Foyer. Nine.");
  });

  it("refuses a line that puts the speaker beside the place, not in it", () => {
    for (const line of ["I was outside the foyer at 21:00.", "I was near the foyer at 21:00.", "At 21:00 I was leaving the foyer.", "I left the foyer at 21:00.", "At 21:00 I was on my way to the foyer."]) {
      refused("displaced", "s-ada", adaFoyer, line);
    }
    for (const line of ["21:00 我在门厅外。", "21:00 我在门厅门口。", "21:00 我在门厅附近。", "21:00 我离开门厅。", "21:00 我正去门厅。"]) {
      refused("displaced", "s-ada", adaFoyer, line);
    }
    refused("displaced", "s-clara", the("a-clara-dining-2100"), "I was just outside the dining hall at 21:00.");
    ok("s-ada", adaFoyer, "At 21:00 I was in the foyer, by the door.");
    ok("s-ada", adaFoyer, "21:00 我就在门厅里。");
  });

  it("refuses a line that leaves the statement out", () => {
    refused("omits", "s-ada", adaFoyer, "I'd rather not say.");
    refused("omits", "s-ada", benFoyer, "I was in the foyer at 21:00.");
    ok("s-ada", benFoyer, "Ben was in the foyer at 21:00.");
  });

  it("holds a statement about a motive to its subject", () => {
    const debt = the("a-ada-debt");
    const noDebt: Assertion[] = [{ id: "a-ada-no-debt", prop: { kind: "motive", subject: "s-ada", motive: "mo-debt", value: false } }];
    ok("s-ada", debt, "Yes, I owed him money. A debt is a debt.");
    ok("s-ada", debt, "我确实欠他一笔债。");
    // A line that changes the subject does not make the statement.
    refused("omits", "s-ada", debt, "I'd rather talk later.");
    refused("omits", "s-ada", debt, "请下一个问题。");
    // An admission turned into a denial, and a denial turned into an admission.
    refused("polarity", "s-ada", debt, "I never owed him anything.");
    refused("polarity", "s-ada", debt, "我不欠他债。");
    refused("polarity", "s-ada", noDebt, "I owed him a debt.");
    ok("s-ada", noDebt, "I owed him nothing. Check your records.");
    ok("s-ada", noDebt, "我不欠他债。");
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
