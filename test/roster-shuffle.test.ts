import { describe, expect, it } from "vitest";
import type { Case } from "../src/case/schema";
import { checkCase } from "../src/case/solver";
import { createMetered } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderRequest, ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { MemorySpendStore } from "../src/spend/store";
import { compilePlot } from "../src/writer/compile";
import { lighthousePeople, lighthouseSkeleton } from "../src/writer/fixtures/lighthouse";
import { plotIds, type People, type Skeleton } from "../src/writer/plot";
import { assessQuality } from "../src/writer/quality";
import { rosterOrder, shufflePlot, shuffleRoster } from "../src/writer/shuffle";
import { writeCase } from "../src/writer/write";

/**
 * A plot the way the model really writes one: the culprit is the first person on the list
 * and the people with means and motive are the first four. Here: the handwritten lighthouse,
 * reordered so that Cormac Brandt, Aldric Varga, Gideon Petrov and Leonie Eklund come first.
 */
const modelLike = (() => {
  const ids = plotIds(lighthouseSkeleton).suspects;
  const front = ["s-03", "s-01", "s-07", "s-12"];
  const order = [...front, ...ids.filter((id) => !front.includes(id))];
  const at = (id: string) => ids.indexOf(id);
  const skeleton: Skeleton = { ...lighthouseSkeleton, suspects: order.map((id) => lighthouseSkeleton.suspects[at(id)]!) };
  const people: People = { culprit: "s-01", suspects: order.map((id, i) => ({ ...lighthousePeople.suspects[at(id)]!, id: ids[i]! })) };
  return { skeleton, people };
})();

const compiled = (skeleton: Skeleton, people: People): Case => {
  const result = compilePlot("x", skeleton, people);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.case;
};
const culpritName = (c: Case) => c.suspects.find((s) => s.id === c.culprit.suspect)!.name.en;
const position = (id: string) => Number(id.slice(2));
/** Everything about each person that the plot fixed, by name. */
const byName = (c: Case) =>
  Object.fromEntries(c.suspects.map((s) => [s.name.en, { zh: s.name.zh, role: s.role.en, persona: s.persona.en, whereabouts: Object.values(s.whereabouts), means: s.means.length, motives: s.motives.map((id) => c.motives.find((m) => m.id === id)!.text.en) }]));

describe("the model's habit this guards against", () => {
  it("compiled as written, the culprit is first and the shortlist is the first four", () => {
    const c = compiled(modelLike.skeleton, modelLike.people);
    expect(checkCase(c).accepted).toBe(true);
    expect(c.culprit.suspect).toBe("s-01");
    expect(assessQuality(c).shortlist).toEqual(["s-01", "s-02", "s-03", "s-04"]);
    // The briefing's register lists them first too.
    expect(c.evidence.find((e) => e.id === "e-register")!.text.en).toContain("held by Cormac Brandt, Aldric Varga, Gideon Petrov, Leonie Eklund");
  });
});

describe("the roster is put in an order that has nothing to do with the plot", () => {
  it("gives the same order for the same seed, and a full reordering every time", () => {
    expect(rosterOrder("writer-b-1", 20)).toEqual(rosterOrder("writer-b-1", 20));
    expect(rosterOrder("writer-b-1", 20)).not.toEqual(rosterOrder("writer-b-2", 20));
    for (const seed of ["a", "b", "writer-b-3", ""]) expect([...rosterOrder(seed, 20)].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_x, i) => i));
    expect(rosterOrder("a", 1)).toEqual([0]);
  });

  it("changes nothing about anyone but their place in the list", () => {
    const before = compiled(modelLike.skeleton, modelLike.people);
    const moved = shufflePlot("writer-b-1", modelLike.skeleton, modelLike.people);
    const after = compiled(moved.skeleton, moved.people);
    expect(checkCase(after).accepted).toBe(true);
    expect(assessQuality(after).problems).toEqual([]);
    // The same person did it, and every person has the same name, voice, whereabouts, means and motive.
    expect(culpritName(after)).toBe("Cormac Brandt");
    expect(byName(after)).toEqual(byName(before));
    expect(after.title).toEqual(before.title);
    // The motives keep their wording; the catalogue is in another order.
    expect(after.motives.map((m) => m.text.en).sort()).toEqual(before.motives.map((m) => m.text.en).sort());
    expect(after.motives.map((m) => m.text.en)).not.toEqual(before.motives.map((m) => m.text.en));
    expect(after.motives.find((m) => m.id === after.culprit.motive)!.text).toEqual(before.motives.find((m) => m.id === before.culprit.motive)!.text);
    expect(after.locations).toEqual(before.locations);
    expect(after.victim).toEqual(before.victim);
    // What changed is where people stand.
    expect(after.suspects.map((s) => s.name.en)).not.toEqual(before.suspects.map((s) => s.name.en));
    expect(after.culprit.suspect).not.toBe("s-01");
  });

  it("spreads the culprit and the shortlist over the whole list across seeds", () => {
    const culpritAt = new Map<number, number>();
    let shortlistFirstFour = 0;
    const seeds = Array.from({ length: 200 }, (_x, i) => `writer-${i}`);
    for (const seed of seeds) {
      const moved = shufflePlot(seed, modelLike.skeleton, modelLike.people);
      const c = compiled(moved.skeleton, moved.people);
      const at = position(c.culprit.suspect);
      culpritAt.set(at, (culpritAt.get(at) ?? 0) + 1);
      if (assessQuality(c).shortlist.join() === "s-01,s-02,s-03,s-04") shortlistFirstFour++;
    }
    // Every one of the twenty places is used, none much more than its share of 200.
    expect(culpritAt.size).toBe(20);
    expect(Math.max(...culpritAt.values())).toBeLessThan(25);
    expect(culpritAt.get(1) ?? 0).toBeLessThan(25);
    // The first four being exactly the shortlist is a 1 in 4,845 chance, not a rule.
    expect(shortlistFirstFour).toBeLessThanOrEqual(1);
  });

  it("reorders a skeleton before the plot exists, changing nothing but the order", () => {
    const moved = shuffleRoster("writer-b-1:before", lighthouseSkeleton);
    expect(moved.suspects).not.toEqual(lighthouseSkeleton.suspects);
    expect([...moved.suspects].sort((x, y) => x.name.en.localeCompare(y.name.en))).toEqual([...lighthouseSkeleton.suspects].sort((x, y) => x.name.en.localeCompare(y.name.en)));
    expect([...moved.motives].sort((x, y) => x.en.localeCompare(y.en))).toEqual([...lighthouseSkeleton.motives].sort((x, y) => x.en.localeCompare(y.en)));
    expect({ ...moved, suspects: [], motives: [] }).toEqual({ ...lighthouseSkeleton, suspects: [], motives: [] });
    expect(shuffleRoster("writer-b-1:before", lighthouseSkeleton)).toEqual(moved);
  });

  it("leaves a plot with missing or doubled rows as it is, for the compiler to refuse", () => {
    const missing: People = { ...modelLike.people, suspects: modelLike.people.suspects.slice(1) };
    expect(shufflePlot("s", modelLike.skeleton, missing)).toEqual({ skeleton: modelLike.skeleton, people: missing });
    const doubled: People = { ...modelLike.people, suspects: [...modelLike.people.suspects.slice(1), modelLike.people.suspects[1]!] };
    expect(shufflePlot("s", modelLike.skeleton, doubled)).toEqual({ skeleton: modelLike.skeleton, people: doubled });
    const result = compilePlot("x", modelLike.skeleton, missing);
    expect(result.ok ? [] : result.problems).toEqual(["the people stage has no row for s-01"]);
  });
});

describe("the writer applies it, before and after the plot is written", () => {
  const usage = { inputTokens: 900, cachedTokens: 0, outputTokens: 3_000 };
  /**
   * A model with the habits seen in three real plots: whatever people it is shown, the first
   * is the culprit and the first four have means and motive; and the culprit gets the first
   * motive it is shown. It names people in alphabetical order, as two real rosters did: the
   * handwritten skeleton's given names already run from Aldric to Tamsin.
   */
  const habitualPeople: People = { ...modelLike.people, suspects: modelLike.people.suspects.map((row) => (row.id === "s-01" ? { ...row, motive: "mo-01" } : row)) };
  const habitual = (request: ProviderRequest): ProviderResponse => ({ text: JSON.stringify(request.responseSchema?.name === "case_skeleton" ? lighthouseSkeleton : habitualPeople), toolCalls: [], usage, finishReason: "stop" });
  const write = async (attemptId: string, salt?: string) => {
    const provider = new FakeProvider(habitual);
    const metered = createMetered({ inputBound: { tokensPerByte: 100 }, provider, store: new MemorySpendStore(), envelope: "e", limitNano: usdToNano(1) });
    return { report: await writeCase({ metered, attemptId, brief: { theme: "a lighthouse", suspects: 20, rooms: 5 }, ...(salt !== undefined ? { salt } : {}) }), provider };
  };
  const alphabetical = lighthouseSkeleton.suspects.map((x) => x.name.en).sort();
  const culpritMotive = (c: Case) => c.motives.find((m) => m.id === c.culprit.motive)!.text.en;

  it("shows the model the people and the motives in a seeded order, not the order it wrote them in", async () => {
    const { provider } = await write("writer-b-1", "salt-1");
    const lines = provider.requests[1]!.messages.at(-1)!.content.split("\n");
    const shown = lines.filter((line) => line.startsWith("- s-")).map((line) => line.replace(/^- s-\d+: /, "").split(",")[0]!);
    expect(shown).toHaveLength(20);
    expect([...shown].sort()).toEqual(alphabetical);
    expect(shown).not.toEqual(lighthouseSkeleton.suspects.map((x) => x.name.en));
    const motives = lines.filter((line) => line.startsWith("- mo-")).map((line) => line.replace(/^- mo-\d+: /, ""));
    expect([...motives].sort()).toEqual(lighthouseSkeleton.motives.map((m) => m.en).sort());
  });

  it("so neither the culprit's name, place nor motive follows the model's habit", async () => {
    const names = new Map<string, number>();
    const places = new Map<string, number>();
    const motiveTexts = new Map<string, number>();
    const motiveIds = new Map<string, number>();
    for (let i = 0; i < 80; i++) {
      const { report } = await write("writer-x", `salt-${i}`);
      expect(report.accepted, `salt-${i}`).toBe(true);
      const c = report.case!;
      names.set(culpritName(c), (names.get(culpritName(c)) ?? 0) + 1);
      places.set(c.culprit.suspect, (places.get(c.culprit.suspect) ?? 0) + 1);
      motiveTexts.set(culpritMotive(c), (motiveTexts.get(culpritMotive(c)) ?? 0) + 1);
      motiveIds.set(c.culprit.motive, (motiveIds.get(c.culprit.motive) ?? 0) + 1);
      expect(report.quality!.shortlist, `salt-${i}`).toHaveLength(4);
    }
    // Over 80 cases the culprit is many different people, in many different places.
    expect(names.size).toBeGreaterThanOrEqual(15);
    expect(places.size).toBeGreaterThanOrEqual(15);
    expect(names.get(alphabetical[0]!) ?? 0).toBeLessThan(12);
    expect(Math.max(...names.values())).toBeLessThan(12);
    expect(Math.max(...places.values())).toBeLessThan(12);
    // And the culprit's motive is each of the three, by wording and by id, none of them nearly always.
    expect(motiveTexts.size).toBe(3);
    expect(motiveIds.size).toBe(3);
    expect(Math.max(...motiveTexts.values())).toBeLessThan(45);
    expect(Math.max(...motiveIds.values())).toBeLessThan(45);
  });

  it("uses a private salt, not the public id: the same id gives different cases, and the salt is not in the case", async () => {
    const a = await write("writer-b-1", "salt-a");
    const b = await write("writer-b-1", "salt-b");
    expect(a.report.case!.id).toBe("writer-b-1");
    expect(b.report.case!.id).toBe("writer-b-1");
    expect(a.report.case).not.toEqual(b.report.case);
    expect(a.report.salt).toBe("salt-a");
    expect(JSON.stringify(a.report.case)).not.toContain("salt-a");
    // With no salt given, one is drawn at random each time.
    const c = await write("writer-b-1");
    const d = await write("writer-b-1");
    expect(c.report.salt).not.toBe(d.report.salt);
    expect(c.report.salt.length).toBeGreaterThan(20);
  });

  it("rebuilds the same case from the same salt", async () => {
    const a = await write("writer-b-1", "salt-a");
    const again = await write("writer-b-1", "salt-a");
    expect(again.report.case).toEqual(a.report.case);
    // The second request is the same too, so saved replies can be read again later.
    expect(again.provider.bodies[1]).toBe(a.provider.bodies[1]);
  });
});
