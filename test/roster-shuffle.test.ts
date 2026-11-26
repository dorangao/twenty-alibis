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
import { rosterOrder, shufflePlot } from "../src/writer/shuffle";
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
const byName = (c: Case) => Object.fromEntries(c.suspects.map((s) => [s.name.en, { zh: s.name.zh, role: s.role.en, persona: s.persona.en, whereabouts: Object.values(s.whereabouts), means: s.means.length, motives: s.motives }]));

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

  it("leaves a plot with missing or doubled rows as it is, for the compiler to refuse", () => {
    const missing: People = { ...modelLike.people, suspects: modelLike.people.suspects.slice(1) };
    expect(shufflePlot("s", modelLike.skeleton, missing)).toEqual({ skeleton: modelLike.skeleton, people: missing });
    const doubled: People = { ...modelLike.people, suspects: [...modelLike.people.suspects.slice(1), modelLike.people.suspects[1]!] };
    expect(shufflePlot("s", modelLike.skeleton, doubled)).toEqual({ skeleton: modelLike.skeleton, people: doubled });
    const result = compilePlot("x", modelLike.skeleton, missing);
    expect(result.ok ? [] : result.problems).toEqual(["the people stage has no row for s-01"]);
  });
});

describe("the writer applies it", () => {
  const usage = { inputTokens: 900, cachedTokens: 0, outputTokens: 3_000 };
  const reply = (request: ProviderRequest): ProviderResponse => ({ text: JSON.stringify(request.responseSchema?.name === "case_skeleton" ? modelLike.skeleton : modelLike.people), toolCalls: [], usage, finishReason: "stop" });
  const write = (attemptId: string) => {
    const metered = createMetered({ inputBound: { tokensPerByte: 100 }, provider: new FakeProvider(reply), store: new MemorySpendStore(), envelope: "e", limitNano: usdToNano(1) });
    return writeCase({ metered, attemptId, brief: { theme: "a lighthouse", suspects: 20, rooms: 5 } });
  };

  it("so a culprit the model put first does not stay first, and the attempt id decides where they go", async () => {
    const a = await write("writer-b-1");
    const b = await write("writer-b-2");
    const again = await write("writer-b-1");
    for (const report of [a, b, again]) {
      expect(report.accepted).toBe(true);
      expect(culpritName(report.case!)).toBe("Cormac Brandt");
      expect(report.quality!.shortlist).toHaveLength(4);
    }
    expect(a.case!.culprit.suspect).not.toBe("s-01");
    expect(b.case!.culprit.suspect).not.toBe(a.case!.culprit.suspect);
    // The same attempt id rebuilds the same case.
    expect(again.case).toEqual(a.case);
    // The register no longer lists the shortlist first.
    expect(a.case!.evidence.find((e) => e.id === "e-register")!.text.en).not.toContain("held by Cormac Brandt, Aldric Varga, Gideon Petrov, Leonie Eklund");
  });
});
