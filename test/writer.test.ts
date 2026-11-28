import { describe, expect, it } from "vitest";
import { guardLine, nameForms } from "../src/agents/line-guard";
import { renderAssertion } from "../src/agents/render";
import { recallResult, recallTool, suspectSystemMessages } from "../src/agents/suspect-prompt";
import { startingHeld } from "../src/case/access";
import type { Case } from "../src/case/schema";
import { checkCase } from "../src/case/solver";
import { accuse, ask, inspect, inspectionMenu, notebook, startSession } from "../src/game/session";
import { createGame, noModel } from "../src/game/terminal";
import { createMetered, type Metered } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore } from "../src/spend/store";
import { compilePlot } from "../src/writer/compile";
import { lighthousePeople, lighthouseSkeleton } from "../src/writer/fixtures/lighthouse";
import { NO_MOTIVE, peopleRequestSchema, plotIds, skeletonMessages, SkeletonSchema, type People, type Skeleton } from "../src/writer/plot";
import { nameProblems, roleNotes } from "../src/writer/names";
import { assessQuality, MIN_SHORTLIST } from "../src/writer/quality";
import { skeletonProblems } from "../src/writer/skeleton";
import { writeCase, type ReplyRecord } from "../src/writer/write";

const compiled = (skeleton: Skeleton = lighthouseSkeleton, people: People = lighthousePeople): Case => {
  const result = compilePlot("lighthouse", skeleton, people);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.case;
};
const problemsOf = (skeleton: Skeleton, people: People): string[] => {
  const result = compilePlot("x", skeleton, people);
  return result.ok ? [] : result.problems;
};
/** The people stage with one suspect's row changed. */
const withRow = (id: string, change: Partial<People["suspects"][number]>, base: People = lighthousePeople): People => ({
  ...base,
  suspects: base.suspects.map((s) => (s.id === id ? { ...s, ...change } : s)),
});
const stays = (room: string) => lighthouseSkeleton.slots.map((slot) => ({ slot, room }));
const rename = (index: number, name: { en: string; zh: string }): Skeleton => ({
  ...lighthouseSkeleton,
  suspects: lighthouseSkeleton.suspects.map((s, i) => (i === index ? { ...s, name } : s)),
});

describe("a handwritten 20-person plot compiles to a case the gates accept", () => {
  const c = compiled();

  it("passes the validator and the solver", () => {
    const checked = checkCase(c);
    expect(checked.reasons).toEqual([]);
    expect(checked.accepted).toBe(true);
    expect(checked.solve!.proven).toEqual(["s-03"]);
    expect(checked.solve!.caughtLies).toEqual([{ suspect: "s-03", assertion: "a-03-says", statedBy: "t-03", contradictedBy: "e-room-01" }]);
    expect(c.suspects).toHaveLength(20);
  });

  it("passes the quality gate: four people to suspect at the opening, and a proof that needs an interview", () => {
    const quality = assessQuality(c);
    expect(quality.problems).toEqual([]);
    expect(quality.shortlist).toEqual(["s-01", "s-03", "s-07", "s-12"]);
    // The briefing alone rules out everyone else, and proves nobody.
    expect(quality.openAtBriefing).toEqual(quality.shortlist);
    expect(quality.interviews).toBe(1);
    expect(quality.proofActions).toBe(5);
  });

  it("takes the hidden truth from the plot and nothing else", () => {
    expect(c.culprit).toEqual({ suspect: "s-03", motive: "mo-02" });
    expect(c.victim.death).toEqual({ slot: "22:20", location: "l-01" });
    expect(c.suspects[2]).toMatchObject({ id: "s-03", whereabouts: { "22:00": "l-02", "22:20": "l-01", "22:40": "l-02" }, means: ["m-01"], motives: ["mo-02"], lies: ["a-03-says"] });
    // The culprit claims the room next to the scene.
    expect(c.assertions.find((a) => a.id === "a-03-says")!.prop).toEqual({ kind: "at", subject: "s-03", slot: "22:20", location: "l-02" });
    // Doors work both ways, whichever room listed them.
    expect(c.locations.find((l) => l.id === "l-04")!.adjacent).toEqual(["l-03"]);
  });

  it("writes records in both languages that say what they prove", () => {
    const text = (id: string) => c.evidence.find((e) => e.id === id)!.text;
    expect(text("e-register").en).toBe('Register for "A key to the lamp room": held by Aldric Varga, Cormac Brandt, Edmund Soler, Gideon Petrov and Leonie Eklund. Nobody else holds one.');
    expect(text("e-register").zh).toBe("“灯室钥匙”登记：持有者为魏立群、柏康默、苏艾蒙、裴吉登、艾莱昂。其他人都没有。");
    expect(text("e-papers-none").en).toBe("The victim's papers give Edmund Soler none of the listed motives.");
    expect(text("e-room-01").en).toBe("Lamp room, 22:20: Cormac Brandt, Edmund Soler and Isidore Abara were here.");
    expect(text("e-room-05").zh).toBe("船屋，22:20：裴吉登在这里。");
    expect(text("e-keeper").en).toBe("The record of who was in the lamp room is kept by Beatrix Okonkwo. Hear their account first.");
    // The note proves nothing and is not authoritative.
    expect(c.evidence.find((e) => e.id === "e-keeper")).toMatchObject({ authoritative: false, proves: [] });
  });

  it("gives every suspect a statement the line guard accepts as code words it", () => {
    for (const topic of c.actions.topics) {
      const accepted = c.assertions.filter((a) => topic.yields.includes(a.id));
      for (const lang of ["en", "zh"] as const) {
        const line = accepted.map((a) => renderAssertion(c, topic.suspect, a, lang)).join(" ");
        expect(guardLine(c, topic.suspect, accepted, line, lang), `${topic.suspect} ${lang}: ${line}`).toEqual({ ok: true });
      }
    }
  });
});

describe("what the compiler adds because silence rules nobody out", () => {
  it("an innocent at the scene with the means is ruled out only by a record that denies every motive", () => {
    const c = compiled();
    // Edmund Soler: in the lamp room at 22:20, holds a key, has no motive.
    expect(c.evidence.find((e) => e.id === "e-papers-none")!.proves).toEqual(["a-05-mo-01", "a-05-mo-02", "a-05-mo-03"]);
    // Take that record away and the same true plot cannot be solved, even with every room open.
    const silent: Case = { ...c, evidence: c.evidence.filter((e) => e.id !== "e-papers-none"), briefing: { evidence: c.briefing.evidence.filter((id) => id !== "e-papers-none") } };
    const checked = checkCase(silent);
    expect(checked.accepted).toBe(false);
    expect(checked.solve!.survivors).toEqual(["s-03", "s-05"]);
  });

  it("someone at the scene without the means is ruled out by the register", () => {
    const c = compiled();
    // Isidore Abara: in the lamp room, no key.
    expect(c.assertions.find((a) => a.id === "a-09-means")!.prop).toMatchObject({ value: false });
    expect(c.evidence.find((e) => e.id === "e-register")!.proves).toContain("a-09-means");
  });
});

describe("the opening must not name the culprit", () => {
  it("refuses a case whose briefing shows one person with means and motive, though the solver accepts it", () => {
    let people = lighthousePeople;
    for (const id of ["s-01", "s-07", "s-12"]) people = withRow(id, { has_means: false }, people);
    const c = compiled(lighthouseSkeleton, people);
    expect(checkCase(c).accepted).toBe(true);
    const quality = assessQuality(c);
    expect(quality.shortlist).toEqual(["s-03"]);
    expect(quality.problems).toEqual([`the briefing shows only 1 suspect(s) with both means and motive; it needs at least ${MIN_SHORTLIST}, or the opening names the culprit`]);
  });

  it("two plots with different culprits open identically", async () => {
    // The same plot, but Aldric Varga did it: he and Cormac Brandt swap where they were.
    const a = lighthousePeople.suspects.find((s) => s.id === "s-01")!;
    const b = lighthousePeople.suspects.find((s) => s.id === "s-03")!;
    const other: People = { ...withRow("s-01", { whereabouts: b.whereabouts }, withRow("s-03", { whereabouts: a.whereabouts })), culprit: "s-01" };
    const first = compiled();
    const second = compiled(lighthouseSkeleton, other);
    expect(checkCase(second).accepted).toBe(true);
    expect(second.culprit.suspect).toBe("s-01");

    const view = async (c: Case) => {
      const game = createGame(c, noModel, "t1", { modelOff: true });
      const lines = [...game.opening()];
      for (const command of ["people", "records", "notebook", ...c.suspects.map((_s, i) => `topics ${i + 1}`)]) lines.push(...(await game.handle(command)));
      return lines;
    };
    expect(await view(second)).toEqual(await view(first));
  });
});

describe("the proof needs an interview", () => {
  const c = compiled();
  const metered: Metered = noModel;

  it("hides the scene's record until its keeper has been heard", async () => {
    let s = startSession(c, "s1");
    expect(inspectionMenu(c, s).map((i) => i.id)).toEqual(["i-02", "i-03", "i-04", "i-05"]);
    // Every record a player can reach without speaking to anyone does not solve it.
    for (const id of ["i-02", "i-03", "i-04", "i-05"]) s = inspect(c, s, id).session;
    expect(accuse(c, s, { suspect: "s-03", evidence: s.evidence }).verdict).toMatchObject({ outcome: "right-but-unproven", missing: ["opportunity"] });

    // Hear the keeper named in the briefing, and the scene opens.
    s = (await ask(metered, c, s, { suspect: "s-02", topic: "t-02" })).session;
    expect(inspectionMenu(c, s).map((i) => i.id)).toContain("i-01");
    s = inspect(c, s, "i-01").session;
    expect(accuse(c, s, { suspect: "s-03", evidence: s.evidence }).verdict.outcome).toBe("solved");
  });

  it("leaves room in one play to prove the case and catch the lie", async () => {
    let s = startSession(c, "s1");
    s = (await ask(metered, c, s, { suspect: "s-03", topic: "t-03" })).session;
    s = (await ask(metered, c, s, { suspect: "s-02", topic: "t-02" })).session;
    for (const id of ["i-01", "i-02", "i-04", "i-05"]) s = inspect(c, s, id).session;
    expect(s.actions).toBeLessThanOrEqual(c.sessionCap);
    expect(notebook(c, s).contradictions).toEqual([{ suspect: "s-03", assertion: "a-03-says", evidence: "e-room-01" }]);
    expect(accuse(c, s, { suspect: "s-03", evidence: s.evidence }).verdict.outcome).toBe("solved");
  });

  it("the keeper is never one of the people the briefing shows with means and motive", () => {
    const result = compilePlot("x", lighthouseSkeleton, lighthousePeople);
    expect(result.ok && result.witness).toBe("s-02");
    expect(result.ok && result.shortlist).not.toContain("s-02");
  });
});

describe("a plot that cannot be compiled is refused with its reasons", () => {
  it("names what is wrong with the rows", () => {
    const [LAMP] = plotIds(lighthouseSkeleton).rooms;
    expect(problemsOf(lighthouseSkeleton, withRow("s-04", { whereabouts: stays(LAMP!).slice(1) }))).toEqual(["s-04 has no room at 22:00"]);
    expect(problemsOf(lighthouseSkeleton, withRow("s-04", { whereabouts: [...stays(LAMP!), { slot: "22:00", room: LAMP! }] }))).toEqual(["s-04 has two rooms at 22:00"]);
    expect(problemsOf(lighthouseSkeleton, withRow("s-04", { whereabouts: [{ slot: "23:00", room: LAMP! }, ...stays(LAMP!)] }))).toEqual(["s-04 has a room at 23:00, which is not a time slot"]);
    expect(problemsOf(lighthouseSkeleton, withRow("s-04", { motive: "mo-09" }))).toEqual(["s-04 has the motive mo-09, which is not listed"]);
    expect(problemsOf(lighthouseSkeleton, { ...lighthousePeople, suspects: lighthousePeople.suspects.slice(1) })).toEqual(["the people stage has no row for s-01"]);
    expect(problemsOf(lighthouseSkeleton, { ...lighthousePeople, suspects: [...lighthousePeople.suspects, lighthousePeople.suspects[0]!] })).toEqual(["the people stage has two rows for s-01"]);
    expect(problemsOf(lighthouseSkeleton, { ...lighthousePeople, culprit: "s-99" })).toEqual(["the culprit s-99 is not in the skeleton"]);
  });

  it("refuses a door to a room that does not exist", () => {
    const skeleton: Skeleton = { ...lighthouseSkeleton, rooms: lighthouseSkeleton.rooms.map((r, i) => (i === 3 ? { ...r, doors: ["Pantry"] } : r)) };
    expect(problemsOf(skeleton, lighthousePeople)).toEqual(['room "Cellar" lists a door to "Pantry", which is not a room']);
  });

  it("takes a door listed from one side only as a door both ways", () => {
    // Only the gallery lists the door to the lamp room; only the kitchen lists the cellar.
    const oneSided: Skeleton = {
      ...lighthouseSkeleton,
      rooms: lighthouseSkeleton.rooms.map((r) => (r.name.en === "Lamp room" || r.name.en === "Cellar" ? { ...r, doors: [] } : r)),
    };
    const c = compiled(oneSided);
    expect(c.locations.find((l) => l.id === "l-01")!.adjacent).toEqual(["l-02"]);
    expect(c.locations.find((l) => l.id === "l-04")!.adjacent).toEqual(["l-03"]);
    // The culprit still has the gallery to claim, and the case is still accepted.
    expect(c.assertions.find((a) => a.id === "a-03-says")!.prop).toMatchObject({ location: "l-02" });
    expect(checkCase(c).accepted).toBe(true);
  });

  it("refuses a culprit with no means or no motive, and a scene with no door", () => {
    expect(problemsOf(lighthouseSkeleton, withRow("s-03", { has_means: false }))).toEqual(["the culprit does not hold the means"]);
    expect(problemsOf(lighthouseSkeleton, withRow("s-03", { motive: NO_MOTIVE }))).toEqual(["the culprit has no motive"]);
    const sealed: Skeleton = { ...lighthouseSkeleton, rooms: lighthouseSkeleton.rooms.map((r) => ({ ...r, doors: r.doors.filter((d) => d !== "Lamp room" && r.name.en !== "Lamp room") })) };
    expect(problemsOf(sealed, lighthousePeople)).toEqual(['the scene, "Lamp room", has no door, so the culprit has no neighbouring room to claim']);
  });

  it("refuses a plot in which everyone is a suspect, because there is no one to keep the record", () => {
    const everyone: People = { ...lighthousePeople, suspects: lighthousePeople.suspects.map((s) => ({ ...s, has_means: true, motive: s.motive === NO_MOTIVE ? "mo-01" : s.motive })) };
    expect(problemsOf(lighthouseSkeleton, everyone)).toEqual(["everyone holds the means and has a motive, so there is no one to keep the scene's record"]);
  });
});

describe("a compiled case still has to pass the validator and the solver", () => {
  it("a move through a wall is caught", () => {
    const [LAMP, , , CELLAR] = plotIds(lighthouseSkeleton).rooms;
    const people = withRow("s-04", {
      whereabouts: [
        { slot: "22:00", room: CELLAR! },
        { slot: "22:20", room: CELLAR! },
        { slot: "22:40", room: LAMP! },
      ],
    });
    const checked = checkCase(compiled(lighthouseSkeleton, people));
    expect(checked.accepted).toBe(false);
    expect(checked.reasons.join("\n")).toContain("which are not adjacent");
  });

  it("a second person at the scene with means and motive is caught", () => {
    const [LAMP] = plotIds(lighthouseSkeleton).rooms;
    const checked = checkCase(compiled(lighthouseSkeleton, withRow("s-01", { whereabouts: stays(LAMP!) })));
    expect(checked.accepted).toBe(false);
    expect(checked.reasons.join("\n")).toContain("exactly one suspect must have opportunity, means and motive");
  });
});

describe("names are checked with the line guard's own word rules", () => {
  it("accepts the handwritten roster", () => {
    expect(nameProblems(compiled())).toEqual([]);
  });

  it("refuses a name that is an everyday word", () => {
    const c = compiled(rename(3, { en: "May Linden", zh: "林梅" }));
    expect(nameProblems(c)).toEqual(['"may" in the name "May Linden" is an everyday word, so ordinary lines would be refused']);
    // The reason: a harmless line by someone else is refused because it "names" her.
    const foyer = c.assertions.filter((a) => a.id === "a-01-says");
    expect(guardLine(c, "s-01", foyer, "I was in the gallery at 22:20. May I go now?", "en")).toMatchObject({ ok: false, reason: "uncovered", detail: "may" });
  });

  it("refuses a person and a room that share a word, in English or in Chinese", () => {
    const skeleton: Skeleton = {
      ...rename(3, { en: "Delphine Gallery", zh: "回廊梅" }),
    };
    const problems = nameProblems(compiled(skeleton));
    expect(problems).toContain('"Delphine Gallery" and "Gallery" share the word "gallery", so naming one would cover the other');
    expect(problems).toContain("“回廊梅”和“回廊”都含有“回廊”，说到一个就会被当成也说了另一个");
  });

  it("refuses two people who share a name, or part of a Chinese one", () => {
    const problems = nameProblems(compiled(rename(3, { en: "Delphine Varga", zh: "马立群" })));
    expect(problems).toContain('"Aldric Varga" and "Delphine Varga" share the word "varga", so naming one would cover the other');
    expect(problems).toContain("“魏立群”和“马立群”都含有“立群”，说到一个就会被当成也说了另一个");
  });

  it("refuses names that differ only by an ending the guard hears through", () => {
    // The guard hears "Collin" in "Collins", "Collin's" and "Collines": a plural or possessive ending does not make a new name.
    const skeleton: Skeleton = {
      ...lighthouseSkeleton,
      suspects: lighthouseSkeleton.suspects.map((s, i) => (i === 0 ? { ...s, name: { en: "Aldric Collins", zh: s.name.zh } } : i === 2 ? { ...s, name: { en: "Cormac Collin", zh: s.name.zh } } : s)),
    };
    const c = compiled(skeleton);
    expect(nameProblems(c)).toEqual(['"Aldric Collins" and "Cormac Collin" share the word "collin", so naming one would cover the other']);
    expect(skeletonProblems(skeleton)).toEqual(nameProblems(c));
    // The reason: Aldric could name Cormac for free.
    const said = c.assertions.filter((x) => x.id === "a-01-says");
    expect(guardLine(c, "s-01", said, "I was in the gallery at 22:20 with Collin.", "en")).toEqual({ ok: true });
  });

  it("refuses a name the guard cannot see", () => {
    expect(nameProblems(compiled(rename(3, { en: "Li Wu", zh: "吴" })))).toEqual([
      'the guard cannot see the English name "Li Wu": no word of it has three letters',
      'the guard cannot see the Chinese name "吴": it needs at least two characters',
    ]);
  });
});

describe("nothing a suspect or a player sees depends on who did it", () => {
  // The same plot twice: once Cormac Brandt did it, once Aldric Varga did, and the two swap where they were.
  const a = lighthousePeople.suspects.find((s) => s.id === "s-01")!;
  const b = lighthousePeople.suspects.find((s) => s.id === "s-03")!;
  const other: People = { ...withRow("s-01", { whereabouts: b.whereabouts }, withRow("s-03", { whereabouts: a.whereabouts })), culprit: "s-01" };
  const first = compiled();
  const second = compiled(lighthouseSkeleton, other);

  it("recall returns the same bytes to every suspect in both cases", () => {
    expect(checkCase(second).accepted).toBe(true);
    for (const c of [first, second]) expect(c.suspects.find((s) => s.lies.length > 0)!.id).toBe(c.culprit.suspect);
    for (const s of first.suspects) {
      const topic = `t-${s.id.slice(2)}`;
      expect(recallResult(second, s.id, topic, startingHeld(second)), s.id).toBe(recallResult(first, s.id, topic, startingHeld(first)));
      expect(JSON.stringify(recallTool(second, s.id, startingHeld(second))), s.id).toBe(JSON.stringify(recallTool(first, s.id, startingHeld(first))));
      expect(JSON.stringify(suspectSystemMessages(second, s.id)), s.id).toBe(JSON.stringify(suspectSystemMessages(first, s.id)));
    }
    // Both under suspicion say the gallery, with the same id pattern, whoever is lying.
    expect(recallResult(first, "s-03", "t-03", startingHeld(first))).toBe('{"topic":"t-03","statements":[{"id":"a-03-says","en":"I was in the gallery at 22:20.","zh":"22:20 我在回廊。"}]}');
    expect(recallResult(first, "s-01", "t-01", startingHeld(first))).toBe('{"topic":"t-01","statements":[{"id":"a-01-says","en":"I was in the gallery at 22:20.","zh":"22:20 我在回廊。"}]}');
  });

  it("names statements and recorded facts by kind, never by truth", () => {
    for (const c of [first, second]) {
      const ids = c.assertions.map((x) => x.id);
      expect(ids.filter((id) => /claim|lie|true|false/.test(id))).toEqual([]);
      for (const s of c.suspects) {
        expect(ids).toContain(`a-${s.id.slice(2)}-says`);
        expect(ids).toContain(`a-${s.id.slice(2)}-was`);
      }
    }
  });

  it("offers every room for inspection, in the skeleton's order, occupied or empty", async () => {
    const [, , KITCHEN] = plotIds(lighthouseSkeleton).rooms;
    // Leonie Eklund was the only one in the cellar. Move her to the kitchen: the cellar is now empty.
    const emptyCellar = compiled(lighthouseSkeleton, withRow("s-12", { whereabouts: stays(KITCHEN!) }));
    expect(checkCase(emptyCellar).accepted).toBe(true);
    expect(emptyCellar.actions.inspections.map((i) => i.id)).toEqual(["i-01", "i-02", "i-03", "i-04", "i-05"]);
    // Before anything is inspected the menu is the same as in the case where the cellar was occupied.
    const menu = (c: Case) => inspectionMenu(c, startSession(c, "s1")).map((i) => [i.id, i.label.en]);
    expect(menu(emptyCellar)).toEqual(menu(first));
    expect(emptyCellar.evidence.find((e) => e.id === "e-room-04")).toMatchObject({ authoritative: true, proves: [], text: { en: "Cellar, 22:20: nobody was recorded here.", zh: "地窖，22:20：没有人在这里的记录。" } });
    // The cap counts every room.
    expect(emptyCellar.sessionCap).toBe(25);
  });

  it("has the culprit claim a room that another suspect under suspicion also claims, and says so when it cannot", () => {
    const shared = compilePlot("x", lighthouseSkeleton, lighthousePeople);
    expect(shared.ok && shared.sharedAlibi).toBe(true);
    expect(assessQuality(first).notes).toEqual([]);

    // Give the lamp room a second door, to the kitchen, and put Aldric Varga in the kitchen.
    // The gallery comes first among the scene's neighbours, but the kitchen is where another
    // suspect really was, so the culprit claims the kitchen.
    const [, , K] = plotIds(lighthouseSkeleton).rooms;
    const twoDoors: Skeleton = { ...lighthouseSkeleton, rooms: lighthouseSkeleton.rooms.map((r) => (r.name.en === "Lamp room" ? { ...r, doors: ["Gallery", "Kitchen"] } : r)) };
    const viaKitchen = compilePlot("x", twoDoors, withRow("s-01", { whereabouts: stays(K!) }));
    expect(viaKitchen.ok && viaKitchen.sharedAlibi).toBe(true);
    if (!viaKitchen.ok) throw new Error("expected a case");
    expect(viaKitchen.case.assertions.find((x) => x.id === "a-03-says")!.prop).toMatchObject({ location: K });
    expect(assessQuality(viaKitchen.case).notes).toEqual([]);

    // Aldric Varga leaves the gallery for the kitchen. The gallery is the scene's only neighbour, so the culprit still claims it, alone.
    const [, , KITCHEN] = plotIds(lighthouseSkeleton).rooms;
    const alone = compilePlot("x", lighthouseSkeleton, withRow("s-01", { whereabouts: stays(KITCHEN!) }));
    expect(alone.ok && alone.sharedAlibi).toBe(false);
    if (!alone.ok) throw new Error("expected a case");
    expect(checkCase(alone.case).accepted).toBe(true);
    const quality = assessQuality(alone.case);
    expect(quality.problems).toEqual([]);
    expect(quality.notes).toEqual(["no other shortlisted suspect states the room the culprit states, so the statements alone can mark the liar"]);
  });
});

describe("what is wrong with a skeleton is known before the second request", () => {
  const brief = { theme: "a lighthouse during a storm", suspects: 20, rooms: 5 };

  it("accepts the handwritten skeleton", () => {
    expect(skeletonProblems(lighthouseSkeleton, brief)).toEqual([]);
    expect(SkeletonSchema.safeParse(lighthouseSkeleton).success).toBe(true);
  });

  it("refuses the wrong number of people or rooms", () => {
    expect(skeletonProblems(lighthouseSkeleton, { ...brief, rooms: 6 })).toEqual(["the skeleton has 5 rooms; 6 were asked for"]);
    expect(skeletonProblems(lighthouseSkeleton, { ...brief, suspects: 12 })).toEqual(["the skeleton has 20 suspects; 12 were asked for"]);
  });

  it("refuses a room that no door leads to", () => {
    const cut: Skeleton = { ...lighthouseSkeleton, rooms: lighthouseSkeleton.rooms.map((r) => (r.name.en === "Boathouse" ? { ...r, doors: [] } : { ...r, doors: r.doors.filter((d) => d !== "Boathouse") })) };
    expect(skeletonProblems(cut, brief)).toEqual(['room "Boathouse" cannot be reached from "Lamp room" through any doors']);
  });

  it("refuses times that are not clock times, or not in order", () => {
    const issues = (slots: string[]) => {
      const parsed = SkeletonSchema.safeParse({ ...lighthouseSkeleton, slots });
      return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
    };
    expect(issues(["29:88", "29:98", "30:10"])).toContain("a time slot must be a clock time such as 21:00");
    expect(issues(["22:00", "22:60", "23:00"])).toContain("a time slot must be a clock time such as 21:00");
    expect(issues(["22:40", "22:20", "22:00"])).toEqual(["time slots must be in order, each later than the last"]);
    expect(issues(["22:00", "22:00", "22:20"])).toEqual(["time slots must be in order, each later than the last"]);
    expect(issues(["23:20", "23:40", "23:59"])).toEqual([]);
  });

  it("refuses a clear mix-up of the two languages", () => {
    const issues = (change: Partial<Skeleton>) => {
      const parsed = SkeletonSchema.safeParse({ ...lighthouseSkeleton, ...change });
      return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    };
    expect(issues({ setting: { en: "A lighthouse.", zh: "A lighthouse." } })).toEqual(["setting.zh: the Chinese text must be in Chinese"]);
    expect(issues({ title: { en: "灯灭之夜", zh: "灯灭之夜" } })).toEqual(["title.en: the English text must be in English"]);
    expect(issues({ means: { en: "A key to the lamp room 钥匙", zh: "灯室钥匙" } })).toEqual(["means.en: the English text must be in English"]);
  });

  it("refuses a role or a manner that names a person", () => {
    const role = (en: string, zh: string): Skeleton => ({ ...lighthouseSkeleton, suspects: lighthouseSkeleton.suspects.map((s, i) => (i === 0 ? { ...s, role: { en, zh } } : s)) });
    expect(skeletonProblems(role("Assistant to Cormac", "柏康默的助手"), brief)).toEqual(['the role of "Aldric Varga" names a person (cormac, 柏康, 康默, 柏康默): "Assistant to Cormac" / “柏康默的助手”']);
    const persona: Skeleton = { ...lighthouseSkeleton, suspects: lighthouseSkeleton.suspects.map((s, i) => (i === 0 ? { ...s, persona: { en: "Speaks warmly of Helena.", zh: "说起林海伦总是很亲切。" } } : s)) };
    expect(skeletonProblems(persona, brief)[0]).toContain('the persona of "Aldric Varga" names a person (helena');
  });

  it("allows a role that names a room or the means, and notes it", () => {
    // What the model really wrote for a boat with a deck: "Deck Officer". Here: the keeper of the lamp room.
    const skeleton: Skeleton = { ...lighthouseSkeleton, suspects: lighthouseSkeleton.suspects.map((s, i) => (i === 0 ? { ...s, role: { en: "Keeper of the lamp room", zh: "灯室看守" } } : s)) };
    expect(skeletonProblems(skeleton, brief)).toEqual([]);
    const c = compiled(skeleton);
    expect(roleNotes(c)).toEqual(['the role of "Aldric Varga" names a place or the means (lamp, room, 灯室): a line that repeats it will be replaced by code\'s sentence']);
    expect(assessQuality(c).notes).toEqual(roleNotes(c));
    expect(assessQuality(c).problems).toEqual([]);
    // The role still buys the speaker nothing: he was in the gallery, and may not add the lamp room.
    const said = c.assertions.filter((x) => x.id === "a-01-says");
    expect(guardLine(c, "s-01", said, "I keep the lamp room. I was in the gallery at 22:20.", "en")).toMatchObject({ ok: false, reason: "uncovered" });
  });

  it("hears a Chinese name written in parts by each whole part, and does not count the space", () => {
    // Names as the model really wrote them in the first paid trial: transliterations with a space.
    const trial: [string, string][] = [
      ["Aldric Varga", "艾德里克 塔莫林"],
      ["Beatrix Okonkwo", "乌尔夫里克 彭达尔"],
      ["Cormac Brandt", "米雷尔 科桑"],
      ["Delphine Marchetti", "索雷尔 哈维克"],
      ["Edmund Soler", "托文 阿达尔"],
      ["Fenella Nakamura", "伊奥兰特 德雷扎尔"],
      ["Gideon Petrov", "赞特 拉维尔"],
    ];
    const skeleton: Skeleton = { ...lighthouseSkeleton, suspects: lighthouseSkeleton.suspects.map((s, i) => (trial[i] ? { ...s, name: { en: trial[i]![0], zh: trial[i]![1] } } : s)) };
    // They share syllables (里克, 雷尔, 达尔, 尔) and a space, and that is no longer a collision.
    expect(skeletonProblems(skeleton, brief)).toEqual([]);
    const c = compiled(skeleton);
    expect(checkCase(c).accepted).toBe(true);
    // What must be his alone is each whole part. What the guard hears is any two characters in a row of a part.
    const forms = nameForms(c).find((f) => f.id === "s-01")!;
    expect(forms.zhOwn).toEqual(["艾德里克", "塔莫林"]);
    expect(forms.zh).toContain("莫林");
    expect(forms.zh).toContain("里克");
    expect(forms.zh).not.toContain("克 ");
    expect(forms.zh).not.toContain("克塔");
    // The guard hears a part, or a piece of one.
    const said = c.assertions.filter((x) => x.id === "a-02-says");
    expect(guardLine(c, "s-02", said, "22:20 我在厨房，和塔莫林在一起。", "zh")).toMatchObject({ ok: false, reason: "uncovered", detail: "塔莫, 莫林, 塔莫林" });
    const given = guardLine(c, "s-02", said, "22:20 我在厨房，和艾德里克在一起。", "zh");
    expect(given).toMatchObject({ ok: false, reason: "uncovered" });
    expect(given.ok ? "" : given.detail).toContain("艾德里克");
    expect(guardLine(c, "s-02", said, "22:20 我在厨房，莫林也在。", "zh")).toMatchObject({ ok: false, reason: "uncovered", detail: "莫林" });
    expect(guardLine(c, "s-02", said, "22:20 我在厨房。", "zh")).toEqual({ ok: true });
    // A role that uses a piece of someone's name names that person.
    const helper: Skeleton = { ...skeleton, suspects: skeleton.suspects.map((s, i) => (i === 10 ? { ...s, role: { en: s.role.en, zh: "莫林的助手" } } : s)) };
    expect(skeletonProblems(helper, brief)).toEqual([`the role of "${skeleton.suspects[10]!.name.en}" names a person (莫林): "${skeleton.suspects[10]!.role.en}" / “莫林的助手”`]);
    // The rendered sentence, which carries the whole name, still passes.
    expect(guardLine(c, "s-02", said, renderAssertion(c, "s-02", said[0]!, "zh"), "zh")).toEqual({ ok: true });

    // Two people with the same part are still refused.
    const clash: Skeleton = { ...skeleton, suspects: skeleton.suspects.map((s, i) => (i === 1 ? { ...s, name: { en: s.name.en, zh: "乌尔夫 塔莫林" } } : s)) };
    expect(skeletonProblems(clash, brief)).toEqual(["“艾德里克 塔莫林”和“乌尔夫 塔莫林”都含有“塔莫林”，说到一个就会被当成也说了另一个"]);
    // A middle dot separates parts too.
    const dotted: Skeleton = { ...lighthouseSkeleton, suspects: lighthouseSkeleton.suspects.map((s, i) => (i === 0 ? { ...s, name: { en: s.name.en, zh: "艾德里克·塔莫林" } } : s)) };
    expect(nameForms(compiled(dotted)).find((f) => f.id === "s-01")!.zhOwn).toEqual(["艾德里克", "塔莫林"]);
  });

  it("and even if such a role slipped through, the guard would not let it cover a name", () => {
    const skeleton: Skeleton = { ...lighthouseSkeleton, suspects: lighthouseSkeleton.suspects.map((s, i) => (i === 0 ? { ...s, role: { en: "Assistant to Cormac", zh: "柏康默的助手" } } : s)) };
    const c = compiled(skeleton);
    const said = c.assertions.filter((x) => x.id === "a-01-says");
    expect(guardLine(c, "s-01", said, "I was in the gallery at 22:20 with Cormac.", "en")).toMatchObject({ ok: false, reason: "uncovered", detail: "cormac" });
    expect(guardLine(c, "s-01", said, "I was in the gallery at 22:20.", "en")).toEqual({ ok: true });
  });
});

describe("the writer: two requests, then code", () => {
  const usage = { inputTokens: 2_000, cachedTokens: 0, outputTokens: 1_500 };
  const PRICE = 2_000 * 100 + 1_500 * 500;
  const json = (value: unknown): ProviderResponse => ({ text: JSON.stringify(value), toolCalls: [], usage, finishReason: "stop" });
  const brief = { theme: "a lighthouse during a storm", suspects: 20, rooms: 5 };

  function setup(replies: (ProviderResponse | Error)[], options: { killSwitch?: () => boolean } = {}) {
    const provider = new FakeProvider((_request, index) => {
      const reply = replies[Math.min(index, replies.length - 1)]!;
      if (reply instanceof Error) throw reply;
      return reply;
    });
    const metered = createMetered({
      inputBound: { tokensPerByte: 100 },
      provider,
      store: new MemorySpendStore(),
      envelope: "e",
      limitNano: usdToNano(1),
      ...(options.killSwitch ? { killSwitch: options.killSwitch } : {}),
    });
    return { provider, metered };
  }

  it("accepts a good plot after two requests and reports what it measured", async () => {
    const { provider, metered } = setup([json(lighthouseSkeleton), json(lighthousePeople)]);
    const report = await writeCase({ metered, attemptId: "w-1", brief });
    expect(report).toMatchObject({ accepted: true, reasons: [], requests: 2, costNano: 2 * PRICE });
    expect(report.failedAt).toBeUndefined();
    expect(report.problem).toBeUndefined();
    expect(report.case!.id).toBe("w-1");
    // The writer reorders the roster by a seed, so which ids are shortlisted depends on the attempt id; how many does not.
    expect(report.quality).toMatchObject({ interviews: 1, proofActions: 5 });
    expect(report.quality!.shortlist).toHaveLength(4);
    expect(report.usage.map((u) => [u.step, u.outputTokens])).toEqual([
      ["writer.skeleton", 1_500],
      ["writer.people", 1_500],
    ]);
    expect(provider.dispatched).toBe(2);
  });

  it("asks for voices before the answer key, and offers stage 2 only the ids code made", async () => {
    const { provider, metered } = setup([json(lighthouseSkeleton), json(lighthousePeople)]);
    await writeCase({ metered, attemptId: "w-1", brief });
    const [first, second] = provider.requests;
    expect(first!.messages.at(-1)!.content).toContain("persona");
    expect(skeletonMessages(brief).at(-1)!.content).toContain("nothing about guilt or innocence");
    // Stage 2 is not shown the voices and is not asked to write any.
    expect(second!.messages.at(-1)!.content).not.toContain("Blunt and unhurried");
    expect(JSON.stringify(second!.responseSchema)).not.toContain("persona");
    const ids = plotIds(lighthouseSkeleton);
    expect(second!.responseSchema).toEqual(peopleRequestSchema(ids));
    const schema = second!.responseSchema!.schema as { properties: { culprit: { enum: string[] } } };
    expect(schema.properties.culprit.enum).toEqual(ids.suspects);
  });

  it("stops at a bad skeleton after one request", async () => {
    for (const [reply, reason] of [
      [{ text: "not json", toolCalls: [], usage, finishReason: "stop" }, "the skeleton reply is not JSON"],
      [{ text: null, toolCalls: [], usage, finishReason: "length" }, "the skeleton reply was cut off at the output limit"],
      [json({ ...lighthouseSkeleton, suspects: lighthouseSkeleton.suspects.slice(0, 19) }), "the skeleton has 19 suspects; 20 were asked for"],
    ] as const) {
      const { provider, metered } = setup([reply as ProviderResponse, json(lighthousePeople)]);
      const report = await writeCase({ metered, attemptId: "w-1", brief });
      expect(report, reason).toMatchObject({ accepted: false, failedAt: "skeleton", reasons: [reason], requests: 1 });
      expect(provider.dispatched, reason).toBe(1);
    }
    const missing = setup([json({ ...lighthouseSkeleton, means: { en: "A key", zh: "" } }), json(lighthousePeople)]);
    const report = await writeCase({ metered: missing.metered, attemptId: "w-1", brief });
    expect(report).toMatchObject({ accepted: false, failedAt: "skeleton", requests: 1 });
    expect(report.reasons[0]).toContain("skeleton: means.zh");
  });

  it("does not spend the second request on a skeleton that is already known to be bad", async () => {
    const cut: Skeleton = { ...lighthouseSkeleton, rooms: lighthouseSkeleton.rooms.map((r) => (r.name.en === "Boathouse" ? { ...r, doors: [] } : { ...r, doors: r.doors.filter((d) => d !== "Boathouse") })) };
    const named: Skeleton = { ...lighthouseSkeleton, suspects: lighthouseSkeleton.suspects.map((s, i) => (i === 3 ? { ...s, name: { en: "May Linden", zh: "林梅" } } : s)) };
    for (const [skeleton, askFor, reason] of [
      [lighthouseSkeleton, { ...brief, rooms: 6 }, "the skeleton has 5 rooms; 6 were asked for"],
      [cut, brief, 'room "Boathouse" cannot be reached from "Lamp room" through any doors'],
      [named, brief, '"may" in the name "May Linden" is an everyday word, so ordinary lines would be refused'],
    ] as const) {
      const { provider, metered } = setup([json(skeleton), json(lighthousePeople)]);
      const report = await writeCase({ metered, attemptId: "w-1", brief: askFor });
      expect(report, reason).toMatchObject({ accepted: false, failedAt: "skeleton", reasons: [reason], requests: 1 });
      expect(provider.dispatched, reason).toBe(1);
    }
    const bad = setup([json({ ...lighthouseSkeleton, slots: ["29:88", "29:98", "30:10"] }), json(lighthousePeople)]);
    expect(await writeCase({ metered: bad.metered, attemptId: "w-1", brief })).toMatchObject({ accepted: false, failedAt: "skeleton", requests: 1 });
    expect(bad.provider.dispatched).toBe(1);
  });

  it("never reports an attempt as accepted when the last request's cost is unconfirmed", async () => {
    for (const [settled, breached, problem, costNano] of [
      [false, false, "unconfirmed:not-settled", 12],
      [true, true, "envelope-suspended", 24],
    ] as const) {
      const replies = [json(lighthouseSkeleton), json(lighthousePeople)];
      let sent = 0;
      // The skeleton settles cleanly; the people reply arrives, good in every other way, but unconfirmed.
      const metered: Metered = async (request) => {
        const first = sent === 0;
        return { ok: true, attemptId: request.attemptId, response: replies[sent++]!, costNano: 12, settled: first ? true : settled, breached: first ? false : breached };
      };
      const report = await writeCase({ metered, attemptId: "w-1", brief });
      expect(report, problem).toMatchObject({ accepted: false, failedAt: "people", requests: 2, costNano, problem });
      expect(report.reasons, problem).toEqual([`the people reply came back, but the attempt is not judged: ${problem}`]);
      expect(report.case, problem).toBeUndefined();
      expect(sent).toBe(2);
    }
  });

  it("drops surplus suspects at the skeleton stage, and refuses too few", async () => {
    // What the model really did in the first paid trial: 21 people for 20.
    const extra = { name: { en: "Ursula Whitlock", zh: "韦乌苏" }, role: { en: "Visitor", zh: "访客" }, persona: { en: "Brisk.", zh: "干脆利落。" } };
    const { provider, metered } = setup([json({ ...lighthouseSkeleton, suspects: [...lighthouseSkeleton.suspects, extra] }), json(lighthousePeople)]);
    const report = await writeCase({ metered, attemptId: "w-1", brief });
    expect(report).toMatchObject({ accepted: true, requests: 2 });
    expect(report.notes).toEqual(["the skeleton had 21 suspects; the last 1 were dropped"]);
    expect(report.case!.suspects).toHaveLength(20);
    // The second request was offered twenty people, not twenty-one.
    const schema = provider.requests[1]!.responseSchema!.schema as { properties: { culprit: { enum: string[] } } };
    expect(schema.properties.culprit.enum).toHaveLength(20);
    expect(provider.requests[1]!.messages.at(-1)!.content).not.toContain("Ursula Whitlock");

    const few = setup([json({ ...lighthouseSkeleton, suspects: lighthouseSkeleton.suspects.slice(0, 19) }), json(lighthousePeople)]);
    expect(await writeCase({ metered: few.metered, attemptId: "w-1", brief })).toMatchObject({ accepted: false, failedAt: "skeleton", reasons: ["the skeleton has 19 suspects; 20 were asked for"], requests: 1 });
  });

  it("hands every reply to the caller as it arrived, before anything parses or judges it", async () => {
    const seen: ReplyRecord[] = [];
    const good = setup([json(lighthouseSkeleton), json(lighthousePeople)]);
    await writeCase({ metered: good.metered, attemptId: "w-1", brief, salt: "salt-1", onReply: (reply) => seen.push(reply) });
    expect(seen).toEqual([
      { attemptId: "w-1:skeleton", stage: "skeleton", text: JSON.stringify(lighthouseSkeleton), finishReason: "stop", usage, settled: true, breached: false, salt: "salt-1" },
      { attemptId: "w-1:people", stage: "people", text: JSON.stringify(lighthousePeople), finishReason: "stop", usage, settled: true, breached: false, salt: "salt-1", shown: expect.any(Array) as string[] },
    ]);
    expect(seen[1]!.shown).toHaveLength(20);
  });

  it("hands over a reply that is cut off, is not JSON, is JSON null, or is later refused", async () => {
    const named = { ...lighthouseSkeleton, suspects: lighthouseSkeleton.suspects.map((s, i) => (i === 3 ? { ...s, name: { en: "May Linden", zh: "林梅" } } : s)) };
    for (const [reply, finishReason, reason] of [
      ['{"suspects":', "length", "the skeleton reply was cut off at the output limit"],
      ["not json", "stop", "the skeleton reply is not JSON"],
      ["null", "stop", "skeleton: (the whole reply): Invalid input: expected object, received null"],
      [JSON.stringify(named), "stop", '"may" in the name "May Linden" is an everyday word, so ordinary lines would be refused'],
    ] as const) {
      const seen: ReplyRecord[] = [];
      const { provider, metered } = setup([{ text: reply, toolCalls: [], usage, finishReason }, json(lighthousePeople)]);
      const report = await writeCase({ metered, attemptId: "w-1", brief, salt: "salt-1", onReply: (r) => seen.push(r) });
      expect(report, reason).toMatchObject({ accepted: false, failedAt: "skeleton", reasons: [reason], requests: 1 });
      expect(seen, reason).toEqual([{ attemptId: "w-1:skeleton", stage: "skeleton", text: reply, finishReason, usage, settled: true, breached: false, salt: "salt-1" }]);
      expect(provider.dispatched, reason).toBe(1);
    }
  });

  it("reads only a reply that ended normally, at either stage, however complete its text looks", async () => {
    for (const finishReason of ["content_filter", "tool_calls", undefined] as const) {
      const odd = (value: unknown): ProviderResponse => ({ text: JSON.stringify(value), toolCalls: [], usage, ...(finishReason ? { finishReason } : {}) });
      const said = finishReason ?? "not given";
      // A valid skeleton on an odd finish: kept, not used, and the people request is not sent.
      const seen: ReplyRecord[] = [];
      const first = setup([odd(lighthouseSkeleton), json(lighthousePeople)]);
      const a = await writeCase({ metered: first.metered, attemptId: "w-1", brief, onReply: (r) => seen.push(r) });
      expect(a, said).toMatchObject({ accepted: false, failedAt: "skeleton", reasons: [`the skeleton reply did not end normally (finish: ${said})`], requests: 1 });
      expect(seen.map((r) => r.finishReason), said).toEqual([finishReason]);
      expect(first.provider.dispatched, said).toBe(1);
      // A valid plot on an odd finish: no case.
      const second = setup([json(lighthouseSkeleton), odd(lighthousePeople)]);
      const b = await writeCase({ metered: second.metered, attemptId: "w-1", brief });
      expect(b, said).toMatchObject({ accepted: false, failedAt: "people", reasons: [`the people reply did not end normally (finish: ${said})`], requests: 2 });
      expect(b.case, said).toBeUndefined();
    }
  });

  it("hands over a reply whose cost was not confirmed, marked as such", async () => {
    const seen: ReplyRecord[] = [];
    const unsettled: Metered = async (request) => ({ ok: true, attemptId: request.attemptId, response: json(lighthouseSkeleton), costNano: 12, settled: false, breached: false });
    await writeCase({ metered: unsettled, attemptId: "w-1", brief, onReply: (r) => seen.push(r) });
    expect(seen).toMatchObject([{ attemptId: "w-1:skeleton", settled: false, breached: false }]);
  });

  it("runs stage 2 from a saved skeleton, spending only the people request", async () => {
    const { provider, metered } = setup([json(lighthousePeople)]);
    const seen: string[] = [];
    const report = await writeCase({ metered, attemptId: "w-1", brief, skeleton: JSON.parse(JSON.stringify(lighthouseSkeleton)), onReply: (reply) => seen.push(reply.stage) });
    expect(report).toMatchObject({ accepted: true, requests: 1, costNano: PRICE });
    expect(report.usage.map((u) => u.step)).toEqual(["writer.people"]);
    expect(provider.dispatched).toBe(1);
    expect(seen).toEqual(["people"]);

    // A saved skeleton is judged like a new one: a bad one sends nothing at all.
    const bad = setup([json(lighthousePeople)]);
    const refused = await writeCase({ metered: bad.metered, attemptId: "w-1", brief: { ...brief, rooms: 6 }, skeleton: lighthouseSkeleton });
    expect(refused).toMatchObject({ accepted: false, failedAt: "skeleton", requests: 0 });
    expect(bad.provider.dispatched).toBe(0);
  });

  it("gives each request room for its reasoning", async () => {
    const { provider, metered } = setup([json(lighthouseSkeleton), json(lighthousePeople)]);
    await writeCase({ metered, attemptId: "w-1", brief });
    expect(provider.requests.map((r) => r.maxOutputTokens)).toEqual([8_000, 8_000]);
  });

  it("says which later stage refused the plot, and keeps the case it got to", async () => {
    const cutOff = setup([json(lighthouseSkeleton), { text: null, toolCalls: [], usage, finishReason: "length" }]);
    expect(await writeCase({ metered: cutOff.metered, attemptId: "w-1", brief })).toMatchObject({ accepted: false, failedAt: "people", requests: 2 });

    const noRow = setup([json(lighthouseSkeleton), json({ ...lighthousePeople, suspects: lighthousePeople.suspects.slice(1) })]);
    expect(await writeCase({ metered: noRow.metered, attemptId: "w-1", brief })).toMatchObject({ failedAt: "compile", reasons: ["the people stage has no row for s-01"] });

    const [LAMP] = plotIds(lighthouseSkeleton).rooms;
    const twoFit = setup([json(lighthouseSkeleton), json(withRow("s-01", { whereabouts: stays(LAMP!) }))]);
    const gate = await writeCase({ metered: twoFit.metered, attemptId: "w-1", brief });
    expect(gate).toMatchObject({ accepted: false, failedAt: "gate" });
    expect(gate.case).toBeDefined();

    let people = lighthousePeople;
    for (const id of ["s-01", "s-07", "s-12"]) people = withRow(id, { has_means: false }, people);
    const obvious = setup([json(lighthouseSkeleton), json(people)]);
    const quality = await writeCase({ metered: obvious.metered, attemptId: "w-1", brief });
    expect(quality).toMatchObject({ accepted: false, failedAt: "quality" });
    expect(quality.quality!.shortlist).toHaveLength(1);
  });

  it("sends nothing more when a request is refused, fails, or comes back unconfirmed", async () => {
    const refused = setup([json(lighthouseSkeleton)], { killSwitch: () => true });
    expect(await writeCase({ metered: refused.metered, attemptId: "w-1", brief })).toMatchObject({ accepted: false, failedAt: "skeleton", requests: 0, problem: "refused:kill-switch" });
    expect(refused.provider.dispatched).toBe(0);

    const failed = setup([json(lighthouseSkeleton), new Error("socket closed")]);
    expect(await writeCase({ metered: failed.metered, attemptId: "w-1", brief })).toMatchObject({ accepted: false, failedAt: "people", requests: 2, costNano: PRICE, problem: "failed:outcome-unknown" });

    // The skeleton came back but its cost was not settled: the people request is not sent.
    let sent = 0;
    const unsettled: Metered = async (request) => {
      sent++;
      return { ok: true, attemptId: request.attemptId, response: json(lighthouseSkeleton), costNano: 12, settled: false, breached: false };
    };
    expect(await writeCase({ metered: unsettled, attemptId: "w-1", brief })).toMatchObject({ accepted: false, failedAt: "skeleton", requests: 1, costNano: 0, problem: "unconfirmed:not-settled" });
    expect(sent).toBe(1);
  });
});
