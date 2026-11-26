import type { Held } from "./access";
import type { Case, Proposition } from "./schema";

/**
 * A goal is a list of options. An option is a list of groups, and a group is a list of
 * interchangeable items. The goal is met when, for at least one option, the notebook holds
 * some item from every group. Groups keep "any one of these records" as a choice for the
 * search to make, so the alternatives are never multiplied out.
 */
export type Option = string[][];
export type Goal = Option[];

/**
 * The rules of proof for one case: what proves a suspect, what rules one out, and what a
 * given notebook therefore shows.
 *
 * The solver uses them to decide whether a case can be solved. The game uses the very same
 * object to score a player's accusation. So what the solver calls a proof and what the game
 * accepts as one cannot drift apart.
 *
 * Nothing here reads the answer key. Only authoritative evidence proves or rules out
 * anything, and a suspect about whom nothing is known is never ruled out.
 */
export function proofRules(c: Case) {
  const assertion = new Map(c.assertions.map((a) => [a.id, a]));
  const death = c.victim.death;

  // What each piece of authoritative evidence proves.
  const proofs: { prop: Proposition; evidence: string }[] = [];
  for (const e of c.evidence) {
    if (!e.authoritative) continue;
    for (const a of e.proves) proofs.push({ prop: assertion.get(a)!.prop, evidence: e.id });
  }
  const evidenceFor = (test: (p: Proposition) => boolean): string[] => [
    ...new Set(proofs.filter((p) => test(p.prop)).map((p) => p.evidence)),
  ];

  const atScene = (id: string) => (p: Proposition) =>
    p.subject === id && p.kind === "at" && p.slot === death.slot && p.location === death.location;
  const offScene = (id: string) => (p: Proposition) =>
    p.subject === id && p.kind === "at" && p.slot === death.slot && p.location !== death.location;
  const hasMeans = (id: string, value: boolean) => (p: Proposition) =>
    p.subject === id && p.kind === "means" && p.means === c.victim.means && p.value === value;
  const hasSomeMotive = (id: string) => (p: Proposition) => p.subject === id && p.kind === "motive" && p.value;
  const lacksMotive = (id: string, motive: string) => (p: Proposition) =>
    p.subject === id && p.kind === "motive" && p.motive === motive && !p.value;

  /** Any one of these records settles it. No records means the goal cannot be met. */
  const anyOf = (items: string[]): Goal => (items.length > 0 ? [[items]] : []);
  // Worked out once per suspect; the search asks about them at every state.
  const suspectGoals = new Map(
    c.suspects.map((s) => {
      // Ruled out by being elsewhere, by lacking the means, or by a denial of every listed motive.
      const denials = c.motives.map((m) => evidenceFor(lacksMotive(s.id, m.id)));
      const exclusion: Goal = [
        ...anyOf([...evidenceFor(offScene(s.id)), ...evidenceFor(hasMeans(s.id, false))]),
        ...(denials.every((records) => records.length > 0) ? [denials] : []),
      ];
      const positive = [anyOf(evidenceFor(atScene(s.id))), anyOf(evidenceFor(hasMeans(s.id, true))), anyOf(evidenceFor(hasSomeMotive(s.id)))];
      return [s.id, { exclusion, positive }] as const;
    }),
  );
  const exclusionGoal = (id: string): Goal => suspectGoals.get(id)!.exclusion;
  const accusationGoals = (id: string): Goal[] => [
    ...suspectGoals.get(id)!.positive,
    ...c.suspects.filter((s) => s.id !== id).map((s) => exclusionGoal(s.id)),
  ];

  /** The items that meet a goal in this notebook: one per group of the first option that holds. */
  const met = (goal: Goal, held: Held): string[] | undefined => {
    for (const option of goal) {
      const picks = option.map((group) => group.find((item) => held.has(item)));
      if (picks.every((item) => item !== undefined)) return picks as string[];
    }
    return undefined;
  };

  /** What a notebook shows: who is still open, and who is fully proven. */
  const assess = (held: Held) => {
    const survivors: string[] = [];
    const proven: string[] = [];
    for (const s of c.suspects) {
      const goals = suspectGoals.get(s.id)!;
      if (met(goals.exclusion, held)) continue;
      survivors.push(s.id);
      if (goals.positive.every((goal) => met(goal, held))) proven.push(s.id);
    }
    return { survivors, proven };
  };

  return { evidenceFor, offScene, suspectGoals, exclusionGoal, accusationGoals, met, assess };
}

export type ProofRules = ReturnType<typeof proofRules>;
