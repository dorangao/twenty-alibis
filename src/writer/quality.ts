import { nameForms } from "../agents/line-guard";
import { proofRules } from "../case/proof";
import type { Case } from "../case/schema";
import { solve } from "../case/solver";

/**
 * The quality gate: what a case needs beyond being solvable.
 *
 * `checkCase()` says a case is fair: the truth is coherent and a player can prove it. It
 * does not say the case is worth playing, or that the line guard can tell its people apart.
 * This gate does. It reads only what a player or the guard would see.
 */

/** The fewest suspects the briefing must show with both means and motive. With one, the briefing names the culprit. */
export const MIN_SHORTLIST = 3;

/** English words that are also names. A suspect called May gets "May I go now?" refused. */
const EVERYDAY = new Set(
  "may will grace mark bill rose art hope joy faith dawn april june august summer autumn frank pat sue guy don rob rich drew chase hunter mason page penny ray rod sandy skip stone wade ward lane hall room hill park lake bell wood field west north south east young old long short white black brown green gray grey king queen prince lord lady major miles max norm bob jack tom dick harry sky rain storm star moon sun son man men boy girl miss lee low high day night dean earl duke".split(
    " ",
  ),
);

export interface Quality {
  /** Suspects the briefing shows with both the means and a motive. */
  shortlist: string[];
  /** Suspects the briefing alone leaves open, by the rules of proof. */
  openAtBriefing: string[];
  /** Actions in the solver's proof, and how many of them are questions to a suspect. */
  proofActions: number;
  interviews: number;
  problems: string[];
}

/** Names the line guard cannot keep apart, or cannot see. */
export function nameProblems(c: Case): string[] {
  const problems: string[] = [];
  const forms = nameForms(c);
  for (const f of forms) {
    if (f.kind !== "suspect") continue;
    if (f.en.length === 0) problems.push(`the guard cannot see the English name "${f.name.en}": no word of it has three letters`);
    if (f.zh.length === 0) problems.push(`the guard cannot see the Chinese name "${f.name.zh}": it needs at least two characters`);
    for (const word of f.en) if (EVERYDAY.has(word)) problems.push(`"${word}" in the name "${f.name.en}" is an everyday word, so ordinary lines would be refused`);
  }
  for (let i = 0; i < forms.length; i++) {
    for (let j = i + 1; j < forms.length; j++) {
      const a = forms[i]!;
      const b = forms[j]!;
      // A means may share a word with a place ("a key to the archive"); the guard allows for that.
      if ((a.kind === "location" && b.kind === "means") || (a.kind === "means" && b.kind === "location")) continue;
      const shared = a.en.find((word) => b.en.includes(word));
      if (shared) problems.push(`"${a.name.en}" and "${b.name.en}" share the word "${shared}", so naming one would cover the other`);
      const inside = a.zh.find((piece) => b.name.zh.includes(piece)) ?? b.zh.find((piece) => a.name.zh.includes(piece));
      if (inside) problems.push(`“${a.name.zh}”和“${b.name.zh}”都含有“${inside}”，说到一个就会被当成也说了另一个`);
    }
  }
  return problems;
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

  return { shortlist, openAtBriefing, proofActions: proof?.actions.length ?? 0, interviews, problems };
}
