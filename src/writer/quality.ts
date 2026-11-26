import { proofRules } from "../case/proof";
import type { Case } from "../case/schema";
import { solve } from "../case/solver";
import { nameProblems, roleNotes } from "./names";

/**
 * The quality gate: what a case needs beyond being solvable.
 *
 * `checkCase()` says a case is fair: the truth is coherent and a player can prove it. It
 * does not say the case is worth playing, or that the line guard can tell its people apart.
 * This gate does. It reads only what a player or the guard would see.
 */

/** The fewest suspects the briefing must show with both means and motive. With one, the briefing names the culprit. */
export const MIN_SHORTLIST = 3;

export interface Quality {
  /** Suspects the briefing shows with both the means and a motive. */
  shortlist: string[];
  /** Suspects the briefing alone leaves open, by the rules of proof. */
  openAtBriefing: string[];
  /** Actions in the solver's proof, and how many of them are questions to a suspect. */
  proofActions: number;
  interviews: number;
  /** Reasons the case is refused. */
  problems: string[];
  /** Weaknesses that do not refuse the case but should be looked at before it is released. */
  notes: string[];
}

export function assessQuality(c: Case): Quality {
  const problems = nameProblems(c);
  const rules = proofRules(c);
  const briefing = new Set(c.briefing.evidence);

  // Who the briefing shows with means and motive: positively proven, not merely not ruled out.
  const shortlist = c.suspects.filter((s) => rules.suspectGoals.get(s.id)!.positive.slice(1).every((goal) => rules.met(goal, briefing) !== undefined)).map((s) => s.id);
  const openAtBriefing = rules.assess(briefing).survivors;
  if (shortlist.length < MIN_SHORTLIST) {
    problems.push(`the briefing shows only ${shortlist.length} suspect(s) with both means and motive; it needs at least ${MIN_SHORTLIST}, or the opening names the culprit`);
  }

  const proof = solve(c).proof;
  const interviews = proof?.actions.filter((a) => a.type === "topic").length ?? 0;
  if (proof && interviews === 0) problems.push("the case can be proven from records alone, without speaking to anyone");
  // One play must have room both to prove the case and to hear the culprit's lie.
  if (proof && proof.actions.length + 1 > c.sessionCap) problems.push(`proving the case and hearing the culprit takes ${proof.actions.length + 1} actions, but a session allows ${c.sessionCap}`);

  // The culprit's statement should not stand alone. This check, unlike the ones above, reads
  // the answer: it asks whether anyone else under suspicion states the room the culprit
  // states. If nobody does, a player who knows how cases are built can pick out the liar
  // from the statements, before any record.
  const notes: string[] = roleNotes(c);
  const prop = new Map(c.assertions.map((a) => [a.id, a.prop]));
  const stated = new Map<string, string>();
  for (const topic of c.actions.topics) {
    for (const id of topic.yields) {
      const p = prop.get(id);
      if (p?.kind === "at" && p.subject === topic.suspect && p.slot === c.victim.death.slot) stated.set(topic.suspect, p.location);
    }
  }
  const claim = stated.get(c.culprit.suspect);
  if (claim && !shortlist.some((s) => s !== c.culprit.suspect && stated.get(s) === claim)) {
    notes.push("no other shortlisted suspect states the room the culprit states, so the statements alone can mark the liar");
  }

  return { shortlist, openAtBriefing, proofActions: proof?.actions.length ?? 0, interviews, problems, notes };
}
