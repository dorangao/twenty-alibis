import type { Case, Proposition } from "../src/case/schema";

/** Exhaust all legal plays of a small, well-formed fixture. No production proof or truth helpers. */
export function caseOracle(c: Case) {
  const { death, means } = c.victim;
  const truthCandidates = c.suspects.filter(s =>
    s.whereabouts[death.slot] === death.location && s.means.includes(means) && s.motives.length > 0);
  const culprit = truthCandidates[0];
  const truthAgrees = truthCandidates.length === 1 && culprit?.id === c.culprit.suspect
    && culprit.motives.includes(c.culprit.motive);

  function isTrue(p: Proposition): boolean {
    const person = c.suspects.find(s => s.id === p.subject)!;
    switch (p.kind) {
      case "at": return person.whereabouts[p.slot] === p.location;
      case "means": return person.means.includes(p.means) === p.value;
      case "motive": return person.motives.includes(p.motive) === p.value;
    }
  }

  const assertions = new Map(c.assertions.map(a => [a.id, a.prop]));
  const recordsAgree = c.evidence.filter(e => e.authoritative)
    .every(e => e.proves.every(id => isTrue(assertions.get(id)!)));
  const actions = [...c.actions.topics, ...c.actions.inspections];
  const lies = c.suspects.flatMap(s => s.lies.map(id => ({ speaker: s.id, id })));
  const caught = new Set<(typeof lies)[number]>();
  let minimum = c.suspects.length;
  const smallestNotebooks = new Map<string, string[]>();
  let proofIn = Infinity;
  const identified = new Set<string>();

  function play(path: typeof actions, held: Set<string>): void {
    const facts = c.evidence.filter(e => e.authoritative && held.has(e.id))
      .flatMap(e => e.proves.map(id => assertions.get(id)!));
    const survivors: string[] = [];
    let confirmed = false;

    for (const { id } of c.suspects) {
      const own = facts.filter(p => p.subject === id);
      const whereabouts = own.find(p => p.kind === "at" && p.slot === death.slot);
      const key = own.find(p => p.kind === "means" && p.means === means);
      const motives = own.filter(p => p.kind === "motive");
      const elsewhere = whereabouts?.kind === "at" && whereabouts.location !== death.location;
      const lacksMeans = key?.kind === "means" && !key.value;
      const lacksMotive = c.motives.every(m => motives.some(p => p.motive === m.id && !p.value));
      if (elsewhere || lacksMeans || lacksMotive) continue;

      survivors.push(id);
      if (whereabouts?.kind === "at" && key?.kind === "means" && motives.some(p => p.value)) {
        confirmed = true;
      }
    }

    if (survivors.length === 1 && confirmed) {
      proofIn = Math.min(proofIn, path.length);
      identified.add(survivors[0]!);
    }
    if (survivors.length < minimum) {
      minimum = survivors.length;
      smallestNotebooks.clear();
    }
    if (survivors.length === minimum) {
      survivors.sort();
      smallestNotebooks.set(JSON.stringify(survivors), survivors);
    }
    // Each lie can be witnessed on its own play, independently of the accusation route.
    for (const lie of lies) {
      const heard = path.some(a => "suspect" in a && a.suspect === lie.speaker && a.yields.includes(lie.id));
      if (heard && facts.some(p => contradicts(assertions.get(lie.id)!, p))) caught.add(lie);
    }

    if (path.length === c.sessionCap) return;
    for (const action of actions) {
      if (path.includes(action) || action.requires?.some(id => !held.has(id))) continue;
      play([...path, action], new Set([...held, ...action.yields]));
    }
  }

  play([], new Set(c.briefing.evidence));
  const requiredLies = lies.filter(({ speaker, id }) => {
    const claim = assertions.get(id)!;
    if (identified.has(speaker)) return true;
    switch (claim.kind) {
      case "at": return claim.slot === death.slot;
      case "means": return claim.means === means;
      case "motive": return true;
    }
  });
  return {
    accepted: truthAgrees && recordsAgree && requiredLies.every(lie => caught.has(lie)) && Number.isFinite(proofIn),
    truthAgrees,
    proofIn,
    // Two equally informative legal plays can leave different candidates under a tight cap.
    survivorSets: [...smallestNotebooks.values()],
  };
}

function contradicts(claim: Proposition, record: Proposition): boolean {
  if (claim.subject !== record.subject) return false;
  switch (claim.kind) {
    case "at": return record.kind === "at" && claim.slot === record.slot && claim.location !== record.location;
    case "means": return record.kind === "means" && claim.means === record.means && claim.value !== record.value;
    case "motive": return record.kind === "motive" && claim.motive === record.motive && claim.value !== record.value;
  }
}
