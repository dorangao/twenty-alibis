import { expect, it } from "vitest";
import { archiveFailTwin, archivePass } from "../src/case/fixtures/archive";
import type { Case } from "../src/case/schema";
import { checkCase, solve, type SolveResult } from "../src/case/solver";
import { caseOracle } from "./case-oracle";

const ada = "s-ada";
const ben = "s-ben";
const log = "e-attendance-log";
const benFoyer = "a-ben-foyer-2100";
const both = [ada, ben];
const label = { en: "Check the register", zh: "查阅登记簿" };

function variant(edit: (c: Case) => void): Case {
  const c = structuredClone(archivePass);
  edit(c);
  return c;
}

// Visit reference values and dictionary keys (including the slot keys in whereabouts).
function transform(c: Case, rename: ReadonlyMap<string, string>, reverse: boolean): Case {
  function visit(value: unknown): unknown {
    if (typeof value === "string") return rename.get(value) ?? value;
    if (Array.isArray(value)) {
      const values = value.map(visit);
      return reverse ? values.reverse() : values;
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [rename.get(k) ?? k, visit(v)]));
    }
    return value;
  }
  return visit(c) as Case;
}

function allIds(c: Case): string[] {
  return [...c.slots, ...[c.locations, c.means, c.motives, c.suspects, c.assertions, c.evidence,
    c.actions.topics, c.actions.inspections].flatMap(items => items.map(item => item.id))];
}

function atScene(c: Case): void {
  c.suspects.find(s => s.id === ben)!.whereabouts[c.victim.death.slot] = c.victim.death.location;
  c.assertions.find(a => a.id === benFoyer)!.prop = {
    kind: "at", subject: ben, slot: c.victim.death.slot, location: c.victim.death.location,
  };
}

function motiveExclusion(exhaustive: boolean): Case {
  return variant(c => {
    atScene(c);
    c.suspects.find(s => s.id === ben)!.motives = [];
    c.evidence.find(e => e.id === "e-letters")!.proves = ["a-ada-debt"];
    // Separate authentic records force the certificate to cite both denials.
    for (const m of exhaustive ? c.motives : c.motives.slice(0, 1)) {
      const assertion = `no-${m.id}`;
      const evidence = `record-${m.id}`;
      c.assertions.push({ id: assertion, prop: { kind: "motive", subject: ben, motive: m.id, value: false } });
      c.evidence.push({ id: evidence, kind: "record", authoritative: true, proves: [assertion], text: label });
      c.briefing.evidence.push(evidence);
    }
  });
}

function twoRoutes(shortFirst: boolean, differentRecord = false): Case {
  return variant(c => {
    c.sessionCap = 2;
    c.actions.inspections[0]!.requires = ["a-ada-foyer-2100", benFoyer];
    const shortcut = differentRecord ? "duplicate-log" : log;
    if (differentRecord) c.evidence.push({ ...c.evidence.find(e => e.id === log)!, id: shortcut });
    c.actions.inspections.push({ id: "direct", label, yields: [shortcut] });
    if (shortFirst) c.actions.inspections.reverse();
  });
}

interface Sample {
  name: string;
  c: Case;
  accepted: boolean;
  survivors: string[];
  otherSurvivorSets?: string[][];
  truthValid?: boolean;
  // Narrow expected failures keep the contract executable while the bounded planner is incomplete.
  verdictDiffers?: boolean;
  survivorsDiffer?: boolean;
}

const samples: Sample[] = [];
for (const [fixture, accepted] of [[archivePass, true], [archiveFailTwin, false]] as const) {
  const survivors = accepted ? [ada] : both;
  const swapped = new Map([[ada, ben], [ben, ada]]);
  const ids = allIds(fixture);
  const permuted = new Map(ids.map((id, i) => [id, ids[(i + 11) % ids.length]!]));
  const reversed = transform(fixture, new Map(), true);
  // Slots are ordered. Rotate them so death still precedes discovery and all moves stay legal.
  reversed.slots = [...fixture.slots.slice(1), fixture.slots[0]!];
  samples.push(
    { name: fixture.id, c: fixture, accepted, survivors },
    { name: `${fixture.id} with the two suspects exchanged`, c: transform(fixture, swapped, false),
      accepted, survivors: survivors.map(id => swapped.get(id)!) },
    { name: `${fixture.id} with all IDs permuted`, c: transform(fixture, permuted, false),
      accepted, survivors: survivors.map(id => permuted.get(id)!) },
    { name: `${fixture.id} with every list reordered`, c: reversed, accepted, survivors },
  );
}

samples.push(
  { name: "the only inspection yields nothing", c: variant(c => { c.actions.inspections[0]!.yields = []; }),
    accepted: false, survivors: both },
  { name: "the door log is hearsay", c: variant(c => { c.evidence.find(e => e.id === log)!.authoritative = false; }),
    accepted: false, survivors: both },
  { name: "interview and inspection require each other's clue", c: variant(c => {
    c.actions.inspections[0]!.requires = [benFoyer];
    c.actions.topics.find(t => t.suspect === ben)!.requires = [log];
  }), accepted: false, survivors: both },
  { name: "the two-step unlock exactly fits", c: variant(c => {
    c.sessionCap = 2;
    c.actions.inspections[0]!.requires = ["a-ada-foyer-2100"];
  }), accepted: true, survivors: [ada] },
  { name: "a reachable log is one action beyond the cap", c: variant(c => {
    c.sessionCap = 1;
    c.actions.inspections[0]!.requires = ["a-ada-foyer-2100"];
  }), accepted: false, survivors: both, survivorsDiffer: true },
  { name: "two routes to one log, longer route first", c: twoRoutes(false),
    accepted: true, survivors: [ada], verdictDiffers: true },
  { name: "two routes to one log, shorter route first", c: twoRoutes(true),
    accepted: true, survivors: [ada] },
  { name: "different records establish the same facts, costly source first", c: twoRoutes(false, true),
    accepted: true, survivors: [ada], verdictDiffers: true },
  { name: "different records establish the same facts, cheap source first", c: twoRoutes(true, true),
    accepted: true, survivors: [ada] },
  { name: "one visit can clear Ben or Clara but cannot clear both", c: variant(c => {
    c.sessionCap = 1;
    c.actions.topics = [];
    c.suspects.find(s => s.id === ada)!.lies = [];
    const claraAlibi = "a-clara-dining-2100";
    const photo = c.evidence.find(e => e.id === "e-dinner-photo")!;
    photo.proves = photo.proves.filter(id => id !== claraAlibi);
    c.evidence.push({ ...photo, id: "clara-photo", proves: [claraAlibi, "a-ada-archive-2100"] });
    c.actions.inspections.push({ id: "inspect-photo", label, yields: ["clara-photo"] });
  }), accepted: false, survivors: both, otherSurvivorSets: [[ada, "s-clara"]], survivorsDiffer: true },
  { name: "two key holders with motives are recorded at the scene", c: variant(atScene),
    accepted: false, survivors: both, truthValid: false },
  { name: "a second person at the scene is proven to lack the key", c: variant(c => {
    atScene(c);
    c.suspects.find(s => s.id === ben)!.means = [];
    c.assertions.find(a => a.id === "a-ben-key")!.prop = { kind: "means", subject: ben, means: c.victim.means, value: false };
  }), accepted: true, survivors: [ada] },
  { name: "a briefing exclusion suffices even when an optional alibi is expensive", c: variant(c => {
    c.sessionCap = 2;
    c.suspects.find(s => s.id === ben)!.means = [];
    c.assertions.find(a => a.id === "a-ben-key")!.prop = { kind: "means", subject: ben, means: c.victim.means, value: false };
    c.evidence.find(e => e.id === log)!.proves = ["a-ada-archive-2100"];
    c.evidence.push({ id: "late-alibi", kind: "record", authoritative: true, proves: [benFoyer], text: label });
    c.actions.inspections.push({ id: "late-check", label, yields: ["late-alibi"], requires: ["a-ada-foyer-2100", benFoyer] });
  }), accepted: true, survivors: [ada] },
  { name: "every listed motive is explicitly ruled out", c: motiveExclusion(true), accepted: true, survivors: [ada] },
  { name: "one motive is ruled out and another stays unknown", c: motiveExclusion(false),
    accepted: false, survivors: both },
  { name: "the accusation fits but the statement and its rebuttal cannot be collected together", c: variant(c => {
    c.sessionCap = 1;
  }), accepted: false, survivors: [ada], verdictDiffers: true },
  { name: "an innocent speaker's lie about the prime suspect cannot be reached", c: variant(c => {
    const id = "ada-dining";
    c.assertions.push({ id, prop: { kind: "at", subject: ada, slot: c.victim.death.slot, location: "l-dining" } });
    c.suspects.find(s => s.id === ben)!.lies.push(id);
    c.actions.topics.push({ id: "ben-on-ada", suspect: ben, label, yields: [id], requires: ["a-ada-key"] });
  }), accepted: false, survivors: [ada] },
  { name: "the identified suspect's other declared lie still requires a rebuttal", c: variant(c => {
    const id = "earlier-claim";
    c.assertions.push({ id, prop: { kind: "at", subject: ada, slot: "20:40", location: "l-archive" } });
    c.suspects.find(s => s.id === ada)!.lies.push(id);
    c.actions.topics.find(t => t.suspect === ada)!.yields.push(id);
  }), accepted: false, survivors: [ada] },
  { name: "an accusation and each lie have legal routes but no single route fits all three actions", c: variant(c => {
    c.sessionCap = 2;
    const id = "ben-archive";
    c.assertions.push({ id, prop: { kind: "at", subject: ben, slot: c.victim.death.slot, location: c.victim.death.location } });
    c.suspects.find(s => s.id === ben)!.lies.push(id);
    c.actions.topics.find(t => t.suspect === ben)!.yields = [id];
  }), accepted: true, survivors: [ada] },
);

function replay(c: Case, proof: NonNullable<SolveResult["proof"]>): void {
  const held = new Set(c.briefing.evidence);
  expect(proof.actions.length).toBeLessThanOrEqual(c.sessionCap);
  for (const ref of proof.actions) {
    const actions = ref.type === "topic" ? c.actions.topics : c.actions.inspections;
    const action = actions.find(a => a.id === ref.id)!;
    expect((action.requires ?? []).every(id => held.has(id))).toBe(true);
    for (const item of action.yields) held.add(item);
  }
  for (const id of proof.evidence) expect(held.has(id)).toBe(true);
  // Verify that the cited evidence on its own is sufficient for an accusation.
  const notebook = { ...c, briefing: { evidence: proof.evidence }, actions: { topics: [], inspections: [] } };
  expect(caseOracle(notebook).proofIn).toBe(0);
}

for (const sample of samples) {
  const { c } = sample;
  const oracle = caseOracle(c);
  const gate = checkCase(c);
  // For invalid hidden truth the gate returns no player result. Check the public deduction separately.
  const player = gate.solve ?? solve(c);
  it(sample.name, () => {
    expect(oracle.accepted).toBe(sample.accepted);
    const expectedSets = [sample.survivors, ...(sample.otherSurvivorSets ?? [])];
    expect(oracle.survivorSets).toHaveLength(expectedSets.length);
    for (const ids of expectedSets) expect(oracle.survivorSets).toContainEqual([...ids].sort());
    expect(gate.validation.ok).toBe(sample.truthValid ?? true);
    if (!sample.verdictDiffers) expect(gate.accepted).toBe(oracle.accepted);
    if (!sample.survivorsDiffer) expect(oracle.survivorSets).toContainEqual([...player.survivors].sort());
    if (gate.accepted) {
      expect(player.proof).not.toBeNull();
      replay(c, player.proof!);
    }
  });
  if (sample.verdictDiffers) {
    it.fails(`bounded verdict: ${sample.name}`, () => expect(gate.accepted).toBe(oracle.accepted));
  }
  if (sample.survivorsDiffer) {
    it.fails(`bounded survivors: ${sample.name}`, () => {
      expect(oracle.survivorSets).toContainEqual([...player.survivors].sort());
    });
  }
}

it("player deduction cannot distinguish two answer keys with the same visible case", () => {
  const wrongKey = variant(c => { c.culprit = { suspect: ben, motive: "mo-will" }; });
  const oracle = caseOracle(wrongKey);
  const player = solve(wrongKey);
  expect(oracle.accepted).toBe(false);
  expect(checkCase(wrongKey).accepted).toBe(oracle.accepted);
  expect(oracle.survivorSets).toEqual([[ada]]);
  expect(oracle.survivorSets).toContainEqual([...player.survivors].sort());
  expect(player).toEqual(solve(archivePass));
});
