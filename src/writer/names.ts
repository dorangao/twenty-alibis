import { mentions, nameForms, type Names } from "../agents/line-guard";

/**
 * Names the line guard cannot keep apart, or cannot see.
 *
 * The guard works on words. It hears a person in any word of their English name and in any
 * two characters of their Chinese one. So a roster is only safe when no word names two
 * things, no name is an everyday word, and nobody's role or manner names anyone or
 * anywhere. These checks use the guard's own rules, so they cannot disagree with it.
 */

/** English words that are also names. A suspect called May gets "May I go now?" refused. */
const EVERYDAY = new Set(
  "may will grace mark bill rose art hope joy faith dawn april june august summer autumn frank pat sue guy don rob rich drew chase hunter mason page penny ray rod sandy skip stone wade ward lane hall room hill park lake bell wood field west north south east young old long short white black brown green gray grey king queen prince lord lady major miles max norm bob jack tom dick harry sky rain storm star moon sun son man men boy girl miss low high day night dean earl duke".split(
    " ",
  ),
);

/** What the name checks read: the names, and each person's role and manner. */
export interface Roster extends Names {
  suspects: readonly { id: string; name: { en: string; zh: string }; role: { en: string; zh: string }; persona: { en: string; zh: string } }[];
}

export function nameProblems(c: Roster): string[] {
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
  // A role or a manner that names a person, a place or the means puts that name in a
  // suspect's mouth before any question is asked.
  for (const s of c.suspects) {
    for (const [what, text] of [
      ["role", s.role],
      ["persona", s.persona],
    ] as const) {
      const named = mentions(c, `${text.en}\n${text.zh}`).filter((m) => !m.startsWith("time "));
      if (named.length > 0) problems.push(`the ${what} of "${s.name.en}" names something from the case (${named.join(", ")}): "${text.en}" / “${text.zh}”`);
    }
  }
  return problems;
}
