import { CaseSchema, type Case } from "./schema";
import { fitsTruth, holds } from "./truth";

export type Layer = "schema" | "truth" | "evidence";

export interface Issue {
  layer: Layer;
  code: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; case: Case; issues: [] }
  | { ok: false; case?: Case; issues: Issue[] };

/**
 * Layers 1 and 2 of the case check: is the hidden truth coherent, and is every piece of
 * testimony and evidence honest about what it is? Whether a player can actually solve the
 * case is layer 3, in solver.ts.
 */
export function validateCase(input: unknown): ValidationResult {
  const parsed = CaseSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        layer: "schema" as const,
        code: "schema",
        message: `${i.path.join(".") || "(root)"}: ${i.message}`,
      })),
    };
  }
  const c = parsed.data;
  const issues: Issue[] = [...checkReferences(c)];
  // The later layers assume ids resolve, so stop here if they do not.
  if (issues.length === 0) {
    issues.push(...checkTruth(c), ...checkEvidence(c));
  }
  return issues.length === 0 ? { ok: true, case: c, issues: [] } : { ok: false, case: c, issues };
}

function checkReferences(c: Case): Issue[] {
  const issues: Issue[] = [];
  const bad = (code: string, message: string) => issues.push({ layer: "schema", code, message });

  const groups: Record<string, string[]> = {
    slot: c.slots,
    location: c.locations.map((l) => l.id),
    means: c.means.map((m) => m.id),
    motive: c.motives.map((m) => m.id),
    suspect: c.suspects.map((s) => s.id),
    assertion: c.assertions.map((a) => a.id),
    evidence: c.evidence.map((e) => e.id),
    topic: c.actions.topics.map((t) => t.id),
    inspection: c.actions.inspections.map((i) => i.id),
  };

  // Ids are unique across the whole file, so a `requires` entry is never ambiguous.
  const seen = new Map<string, string>();
  for (const [group, ids] of Object.entries(groups)) {
    for (const id of ids) {
      const earlier = seen.get(id);
      if (earlier) bad("duplicate-id", `id "${id}" is used by both a ${earlier} and a ${group}`);
      else seen.set(id, group);
    }
  }
  const is = (group: string, id: string) => seen.get(id) === group;
  const need = (group: string, id: string, where: string) => {
    if (!is(group, id)) bad("unknown-id", `${where}: "${id}" is not a ${group}`);
  };

  for (const l of c.locations) for (const a of l.adjacent) need("location", a, `location ${l.id}.adjacent`);
  need("slot", c.victim.death.slot, "victim.death.slot");
  need("location", c.victim.death.location, "victim.death.location");
  need("slot", c.victim.found.slot, "victim.found.slot");
  need("location", c.victim.found.location, "victim.found.location");
  need("means", c.victim.means, "victim.means");
  need("suspect", c.culprit.suspect, "culprit.suspect");
  need("motive", c.culprit.motive, "culprit.motive");

  for (const s of c.suspects) {
    for (const [slot, loc] of Object.entries(s.whereabouts)) {
      need("slot", slot, `suspect ${s.id}.whereabouts`);
      need("location", loc, `suspect ${s.id}.whereabouts[${slot}]`);
    }
    for (const m of s.means) need("means", m, `suspect ${s.id}.means`);
    for (const m of s.motives) need("motive", m, `suspect ${s.id}.motives`);
    for (const a of s.lies) need("assertion", a, `suspect ${s.id}.lies`);
  }
  for (const a of c.assertions) {
    need("suspect", a.prop.subject, `assertion ${a.id}.subject`);
    if (a.prop.kind === "at") {
      need("slot", a.prop.slot, `assertion ${a.id}.slot`);
      need("location", a.prop.location, `assertion ${a.id}.location`);
    } else if (a.prop.kind === "means") {
      need("means", a.prop.means, `assertion ${a.id}.means`);
    } else {
      need("motive", a.prop.motive, `assertion ${a.id}.motive`);
    }
  }
  for (const e of c.evidence) for (const a of e.proves) need("assertion", a, `evidence ${e.id}.proves`);
  for (const e of c.briefing.evidence) need("evidence", e, "briefing.evidence");

  const needHeld = (id: string, where: string) => {
    if (!is("assertion", id) && !is("evidence", id)) {
      bad("unknown-id", `${where}: "${id}" is neither an assertion nor evidence`);
    }
  };
  for (const t of c.actions.topics) {
    need("suspect", t.suspect, `topic ${t.id}.suspect`);
    for (const a of t.yields) need("assertion", a, `topic ${t.id}.yields`);
    for (const r of t.requires ?? []) needHeld(r, `topic ${t.id}.requires`);
  }
  for (const i of c.actions.inspections) {
    for (const e of i.yields) need("evidence", e, `inspection ${i.id}.yields`);
    for (const r of i.requires ?? []) needHeld(r, `inspection ${i.id}.requires`);
  }
  return issues;
}

/** Layer 1: the hidden truth is physically possible and points at exactly one person. */
function checkTruth(c: Case): Issue[] {
  const issues: Issue[] = [];
  const bad = (code: string, message: string) => issues.push({ layer: "truth", code, message });
  const adjacent = new Map(c.locations.map((l) => [l.id, new Set(l.adjacent)]));

  for (const s of c.suspects) {
    for (const slot of c.slots) {
      if (!s.whereabouts[slot]) bad("missing-whereabouts", `suspect ${s.id} has no location at ${slot}`);
    }
    for (let i = 1; i < c.slots.length; i++) {
      const from = s.whereabouts[c.slots[i - 1]!];
      const to = s.whereabouts[c.slots[i]!];
      if (!from || !to || from === to) continue;
      // A door works both ways, whichever side the file lists it on.
      const linked = adjacent.get(from)?.has(to) || adjacent.get(to)?.has(from);
      if (!linked) {
        bad("impossible-move", `suspect ${s.id} moves ${from} -> ${to} between ${c.slots[i - 1]} and ${c.slots[i]}, which are not adjacent`);
      }
    }
  }

  const fitting = c.suspects.filter((s) => fitsTruth(c, s)).map((s) => s.id);
  if (fitting.length !== 1) {
    bad("truth-not-unique", `exactly one suspect must have opportunity, means and motive in the hidden truth; found ${fitting.length}: [${fitting.join(", ")}]`);
  } else if (fitting[0] !== c.culprit.suspect) {
    bad("culprit-mismatch", `the hidden truth points at ${fitting[0]}, but culprit.suspect is ${c.culprit.suspect}`);
  }
  const culprit = c.suspects.find((s) => s.id === c.culprit.suspect);
  if (culprit && !culprit.motives.includes(c.culprit.motive)) {
    bad("culprit-motive", `culprit.motive ${c.culprit.motive} is not one of ${culprit.id}'s motives`);
  }
  return issues;
}

/** Layer 2: authoritative evidence is true, and every false statement is a declared lie. */
function checkEvidence(c: Case): Issue[] {
  const issues: Issue[] = [];
  const bad = (code: string, message: string) => issues.push({ layer: "evidence", code, message });
  const assertion = new Map(c.assertions.map((a) => [a.id, a]));
  const suspect = new Map(c.suspects.map((s) => [s.id, s]));

  for (const e of c.evidence) {
    if (!e.authoritative) continue;
    for (const id of e.proves) {
      const a = assertion.get(id)!;
      if (!holds(c, a.prop)) {
        bad("false-record", `authoritative evidence ${e.id} proves ${id}, which is false in the hidden truth`);
      }
    }
  }

  const stated = new Map<string, Set<string>>(); // suspect id -> assertion ids they state
  for (const t of c.actions.topics) {
    const set = stated.get(t.suspect) ?? new Set<string>();
    for (const id of t.yields) {
      set.add(id);
      const a = assertion.get(id)!;
      const isLie = suspect.get(t.suspect)!.lies.includes(id);
      if (!holds(c, a.prop) && !isLie) {
        bad("undeclared-lie", `topic ${t.id}: ${t.suspect} states ${id}, which is false, but it is not in their lies`);
      }
    }
    stated.set(t.suspect, set);
  }

  for (const s of c.suspects) {
    for (const id of s.lies) {
      const a = assertion.get(id)!;
      if (holds(c, a.prop)) bad("lie-is-true", `suspect ${s.id} lists ${id} as a lie, but it is true`);
      if (!stated.get(s.id)?.has(id)) {
        bad("lie-never-stated", `suspect ${s.id} lists ${id} as a lie, but none of their topics states it`);
      }
    }
  }
  return issues;
}
