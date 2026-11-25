import type { Case, Proposition, Suspect } from "./schema";

/** Is this proposition true in the case's hidden truth? Unknown subjects are simply false. */
export function holds(c: Case, prop: Proposition): boolean {
  const suspect = c.suspects.find((s) => s.id === prop.subject);
  if (!suspect) return false;
  switch (prop.kind) {
    case "at":
      return suspect.whereabouts[prop.slot] === prop.location;
    case "means":
      return suspect.means.includes(prop.means) === prop.value;
    case "motive":
      return suspect.motives.includes(prop.motive) === prop.value;
  }
}

/** Opportunity, the means that was used, and at least one motive: all true in the hidden truth. */
export function fitsTruth(c: Case, s: Suspect): boolean {
  return (
    s.whereabouts[c.victim.death.slot] === c.victim.death.location &&
    s.means.includes(c.victim.means) &&
    s.motives.length > 0
  );
}

/** Two propositions that cannot both be true. */
export function contradicts(a: Proposition, b: Proposition): boolean {
  if (a.subject !== b.subject) return false;
  if (a.kind === "at" && b.kind === "at") {
    return a.slot === b.slot && a.location !== b.location;
  }
  if (a.kind === "means" && b.kind === "means") {
    return a.means === b.means && a.value !== b.value;
  }
  if (a.kind === "motive" && b.kind === "motive") {
    return a.motive === b.motive && a.value !== b.value;
  }
  return false;
}
