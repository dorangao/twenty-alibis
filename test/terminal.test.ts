import { describe, expect, it } from "vitest";
import { archivePass } from "../src/case/fixtures/archive";
import { solve } from "../src/case/solver";
import { createGame, noModel, pinAtLaunch, type GameOptions } from "../src/game/terminal";
import { createMetered, type Metered } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderRequest, ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore } from "../src/spend/store";

const c = archivePass;
const usage = { inputTokens: 1_000, cachedTokens: 0, outputTokens: 60 };

const off = noModel;

/** A stand-in suspect: it picks the first topic on its menu and repeats the statements it is given. */
function wellBehaved(request: ProviderRequest): ProviderResponse {
  if (request.tools?.length) {
    const menu = (request.tools[0]!.parameters as { properties: { topic: { enum: string[] } } }).properties.topic.enum;
    return { text: null, toolCalls: [{ id: "call_1", name: "recall", arguments: JSON.stringify({ topic: menu[0] }) }], usage, finishReason: "tool_calls" };
  }
  const recalled = JSON.parse(request.messages.find((m) => m.role === "tool")!.content) as { statements: { id: string; en: string; zh: string }[] };
  return { text: JSON.stringify({ assertions: recalled.statements.map((s) => s.id), line: `${recalled.statements.map((s) => s.en).join(" ")} Now leave me be.`, language: "en" }), toolCalls: [], usage, finishReason: "stop" };
}
function live() {
  const provider = new FakeProvider(wellBehaved);
  const metered = createMetered({ inputBound: { tokensPerByte: 100 }, provider, store: new MemorySpendStore(), envelope: "e", limitNano: usdToNano(1) });
  return { provider, metered };
}

async function play(commands: string[], options: GameOptions = { modelOff: true }, metered: Metered = off) {
  const game = createGame(c, metered, "t1", options);
  const out: string[] = [];
  for (const command of commands) out.push(...(await game.handle(command)));
  return { game, out, text: out.join("\n") };
}

describe("the game in a terminal, with the model off", () => {
  it("opens with the public case and nothing hidden", () => {
    const text = createGame(c, off, "t1").opening().join("\n");
    expect(text).toContain("The Archive at Nine · 九点的档案室");
    expect(text).toContain("Mr. Shen died at 21:00 in the archive and was found at 21:20.");
    expect(text).toContain("Key register");
    expect(text).toContain("Actions left: 40 of 40.");
    // The record the player has not found yet, and the answer, are not in it.
    expect(text).not.toContain("door log");
    expect(text).not.toContain("Ada Marlow's key opened");
  });

  it("can be played from the briefing to a proven accusation and the reveal", async () => {
    const { game, text } = await play(["people", "topics ada", "ask ada 1", "records", "inspect 1", "notebook", "accuse ada all", "reveal"]);
    expect(text).toContain("1. Ada Marlow — Archivist's assistant");
    expect(text).toContain("1. Where were you at 21:00?");
    expect(text).toContain("Ada Marlow: “I was in the foyer at 21:00.”  [worded by code]");
    expect(text).toContain("Archive door log, 21:00: Ada Marlow's key opened the archive.");
    expect(text).toContain("Ada Marlow said “I was in the foyer at 21:00.” Record 4 says otherwise.");
    expect(text).toContain("SOLVED. The right person, and your evidence proves it.");
    expect(text).toContain("It was Ada Marlow.");
    expect(text).toContain("Ada Marlow: 20:40 Foyer, 21:00 Archive, 21:20 Foyer");
    expect(text).toContain("you caught it");
    expect(game.session()).toMatchObject({ actions: 2, verdict: { outcome: "solved" } });
  });

  it("follows the solver's own proof to a solved case", async () => {
    const proof = solve(c).proof!;
    const game = createGame(c, off, "t1", { modelOff: true });
    for (const action of proof.actions) {
      expect(action.type).toBe("inspection");
      await game.handle("inspect 1");
    }
    expect((await game.handle(`accuse ada ${proof.evidence.map((id) => game.session().evidence.indexOf(id) + 1).join(" ")}`)).join("\n")).toContain("SOLVED");
  });

  it("plays the same in Chinese", async () => {
    const { text, game } = await play(["ask 艾达 1", "ask 马艾达 1", "inspect 1", "notebook", "accuse 1 全部", "reveal"], { language: "zh", modelOff: true });
    // 艾达 and 马艾达 are the same person; the second ask is a replay.
    expect(text).toContain("[代码转述，重听]");
    expect(game.session().actions).toBe(2);
    expect(text).toContain("马艾达: “21:00 我在门厅。”  [代码转述]");
    expect(text).toContain("马艾达说“21:00 我在门厅。”，与第 4 项记录不符。");
    expect(text).toContain("破案。指认正确，证据确凿。");
    expect(text).toContain("凶手是马艾达。");
    expect(text).toContain("被你识破");
  });

  it("says a typed question needs the model, and uses nothing up", async () => {
    const { game, text } = await play(["say ben where were you"]);
    expect(text).toContain("The model is off, and a question in your own words needs it.");
    expect(text).not.toContain("Ben Okafor:");
    expect(game.session()).toMatchObject({ actions: 0, turns: [] });
  });

  it("tells a right name from a proof, and a wrong name from both", async () => {
    const unproven = await play(["accuse ada all"]);
    expect(unproven.text).toContain("RIGHT, BUT UNPROVEN.");
    expect(unproven.text).toContain("Not proven for Ada Marlow: opportunity.");
    expect(unproven.text).toContain("Not ruled out: Ben Okafor.");

    const cited = await play(["inspect 1", "accuse ada 4"]);
    expect(cited.text).toContain("RIGHT, BUT UNPROVEN.");
    expect(cited.text).toContain("Not proven for Ada Marlow: means, motive.");

    const wrong = await play(["inspect 1", "accuse ben all"]);
    expect(wrong.text).toContain("WRONG. That is not who did it.");
    expect(wrong.text).toContain("Your own evidence rules that person out.");
  });

  it("asks the player to cite evidence: an accusation with none named does nothing yet", async () => {
    const { game, out } = await play(["inspect 1", "accuse ada"]);
    expect(out.at(-1)).toBe("Cite the records that prove it, by number (see `notebook`), or `all`. For example: accuse ada 1 2 4");
    expect(game.session().verdict).toBeUndefined();
    // Holding the proof is not citing it: the same notebook, cited in full, solves the case.
    expect((await game.handle("accuse ada 1 2 3 4")).join("\n")).toContain("SOLVED");
  });

  it("keeps the truth back until the accusation, and ends play after it", async () => {
    const { text } = await play(["reveal", "accuse ben all", "ask ada 1", "inspect 1", "accuse ada all"]);
    expect(text.split("\n")[0]).toBe("The truth is revealed only after you accuse someone.");
    expect(text).not.toContain("It was Ada Marlow.");
    expect(text.match(/The session has ended with your accusation/g)).toHaveLength(3);
  });

  it("answers a bad command, person, topic or record without changing anything", async () => {
    const { game, out } = await play(["dance", "topics nobody", "ask ada 9", "inspect 9", "accuse ada 9", "topics 3", "lang fr", ""]);
    expect(out).toEqual([
      "I don't know that command. Type `help`.",
      "Which person? Type `people` for the list.",
      "Which topic? Type `topics <person>` for the list.",
      "Which record? Type `records` for the list.",
      "You can only cite records that are in your notebook.",
      "Clara Voss has no topic to offer right now.",
      "Use `lang en` or `lang zh`.",
    ]);
    expect(game.session()).toMatchObject({ actions: 0, turns: [], inspections: [] });
  });

  it("switches language mid-game and quits", async () => {
    const { game, out } = await play(["lang zh", "people", "quit"]);
    expect(out[0]).toBe("中文。");
    expect(out[1]).toBe("  1. 马艾达 — 档案助理");
    expect(out.at(-1)).toBe("再见。");
    expect(game.quit).toBe(true);
  });
});

describe("the game in a terminal, with a model", () => {
  it("shows the suspect's own line for a typed question and notes the statement", async () => {
    const { provider, metered } = live();
    const { game, text } = await play(["say ada So where were you?", "say ada so where were you?", "notebook"], {}, metered);
    expect(text).toContain("Ada Marlow: “I was in the foyer at 21:00. Now leave me be.”  [in their own words]");
    expect(text).toContain("noted: “I was in the foyer at 21:00.”");
    // The same question again is replayed: two requests in all, one action.
    expect(text).toContain("[in their own words, heard before]");
    expect(provider.dispatched).toBe(2);
    expect(game.session().actions).toBe(1);
    // The notebook holds code's wording, not the model's.
    expect(text).toContain("  Ada Marlow: “I was in the foyer at 21:00.”");
    expect(text).not.toContain("  Ada Marlow: “I was in the foyer at 21:00. Now leave me be.”\n");
  });

  it("gives the fixed line when no topic fits, after one request", async () => {
    const { provider, metered } = live();
    const { text } = await play(["say clara What did you see?"], {}, metered);
    expect(text).toMatch(/Clara Voss: “.+”  \[nothing to state\]/);
    expect(provider.dispatched).toBe(1);
  });
});

describe("whether a game may use the model is decided at launch", () => {
  it("a game that started with paid requests closed never sends, even if they are opened later", async () => {
    const { provider, metered: real } = live();
    // Closed at launch. The real wrapper would send; the pinned one must not be it.
    const pinned = pinAtLaunch(real, false);
    expect(pinned.modelOff).toBe(true);
    const { game, text } = await play(["say ada So where were you?", "ask ada 1"], { modelOff: pinned.modelOff }, pinned.metered);
    expect(provider.dispatched).toBe(0);
    expect(text).toContain("The model is off");
    expect(text).toContain("[worded by code]");
    expect(game.session().actions).toBe(1);
  });

  it("a game that started live uses the real wrapper, and one with no runtime has no model", async () => {
    const { provider, metered: real } = live();
    const pinned = pinAtLaunch(real, true);
    expect(pinned).toEqual({ metered: real, modelOff: false });
    await play(["say ada So where were you?"], {}, pinned.metered);
    expect(provider.dispatched).toBe(2);
    expect(pinAtLaunch(null, true)).toEqual({ metered: noModel, modelOff: true });
  });
});
