import type { Case, Proposition } from "./schema";
import { contradicts } from "./truth";
import { validateCase, type ValidationResult } from "./validate";

export interface ActionRef {
  type: "topic" | "inspection";
  id: string;
}

export interface CaughtLie {
  suspect: string;
  assertion: string;
  /** The topic where the suspect says it. */
  statedBy: string;
  /** The authoritative evidence that contradicts it. */
  contradictedBy: string;
}

export interface SolveResult {
  /** Can a player prove the culprit, and rule out everyone else, with actions they really have? */
  solvable: boolean;
  /** Suspects that no reachable authoritative evidence rules out. */
  survivors: string[];
  /** Suspects with opportunity, means and motive all proven by reachable authoritative evidence. */
  proven: string[];
  /** The actions and evidence that make the proof, in an order a player could follow. */
  proof: { actions: ActionRef[]; evidence: string[] } | null;
  caughtLies: CaughtLie[];
  uncaughtLies: { suspect: string; assertion: string }[];
  /** Why the case is not solvable. Empty when it is. */
  reasons: string[];
}

interface Act {
  ref: ActionRef;
  key: string;
  suspect?: string;
  yields: string[];
  requires: string[];
}

/**
 * Layer 3 of the case check: the player proof.
 *
 * Starting from the briefing, take every action a player could take. Only authoritative
 * evidence counts. Testimony can unlock further actions, but it never proves or rules out
 * anything, and a fact the player cannot reach does not exist: unknown is never an exclusion.
 *
 * Candidate proof uses no answer key. The separate catchability check uses the declared lies.
 */
export function solve(c: Case): SolveResult {
  const assertion = new Map(c.assertions.map((a) => [a.id, a]));
  const evidence = new Map(c.evidence.map((e) => [e.id, e]));

  // 1. Everything a player can reach. `held` maps an item to the action that first yielded it.
  const held = new Map<string, string | null>();
  for (const e of c.briefing.evidence) held.set(e, null);

  const all: Act[] = [
    ...c.actions.topics.map((t) => ({
      ref: { type: "topic" as const, id: t.id },
      key: `topic:${t.id}`,
      suspect: t.suspect,
      yields: t.yields,
      requires: t.requires ?? [],
    })),
    ...c.actions.inspections.map((i) => ({
      ref: { type: "inspection" as const, id: i.id },
      key: `inspection:${i.id}`,
      yields: i.yields,
      requires: i.requires ?? [],
    })),
  ];
  const order: Act[] = [];
  const done = new Set<string>();
  for (let progressed = true; progressed; ) {
    progressed = false;
    for (const act of all) {
      if (done.has(act.key) || !act.requires.every((r) => held.has(r))) continue;
      done.add(act.key);
      order.push(act);
      for (const y of act.yields) if (!held.has(y)) held.set(y, act.key);
      progressed = true;
    }
  }
  const position = new Map(order.map((act, i) => [act.key, i]));
  const byKey = new Map(order.map((act) => [act.key, act]));

  // 2. What the reachable authoritative evidence proves, earliest first.
  const proofs: { prop: Proposition; evidence: string }[] = [];
  for (const id of held.keys()) {
    const e = evidence.get(id);
    if (!e?.authoritative) continue;
    for (const a of e.proves) proofs.push({ prop: assertion.get(a)!.prop, evidence: e.id });
  }
  const provedBy = (test: (p: Proposition) => boolean) => proofs.find((p) => test(p.prop))?.evidence;

  // 3. Each suspect: fully proven, ruled out, or still open.
  const death = c.victim.death;
  const offScene = (p: Proposition, subject: string) =>
    p.subject === subject && p.kind === "at" && p.slot === death.slot && p.location !== death.location;
  const exclusionFor = (subject: string): string[] | undefined => {
    const direct = provedBy((p) => offScene(p, subject) ||
      (p.subject === subject && p.kind === "means" && p.means === c.victim.means && !p.value));
    if (direct) return [direct];
    // Any one motive suffices. Ruling out motive requires an explicit denial for every listed motive.
    const records = c.motives.map((m) => provedBy((p) =>
      p.subject === subject && p.kind === "motive" && p.motive === m.id && !p.value));
    if (records.every((id) => id !== undefined)) return records;
  };
  const status = c.suspects.map((s) => {
    const mine = (p: Proposition) => p.subject === s.id;
    return {
      id: s.id,
      opportunity: provedBy((p) => mine(p) && p.kind === "at" && p.slot === death.slot && p.location === death.location),
      means: provedBy((p) => mine(p) && p.kind === "means" && p.means === c.victim.means && p.value),
      motive: provedBy((p) => mine(p) && p.kind === "motive" && p.value),
      exclusion: exclusionFor(s.id),
    };
  });
  const proven = status.filter((s) => s.opportunity && s.means && s.motive).map((s) => s.id);
  const survivors = status.filter((s) => !s.exclusion).map((s) => s.id);

  // 4. Lies: caught only when the statement and an independent record are both reachable.
  const caughtLies: CaughtLie[] = [];
  const uncaughtLies: { suspect: string; assertion: string }[] = [];
  for (const s of c.suspects) {
    for (const lie of s.lies) {
      const stated = order.find((act) => act.suspect === s.id && act.yields.includes(lie));
      const prop = assertion.get(lie)?.prop;
      const record = prop && proofs.find((p) => contradicts(p.prop, prop))?.evidence;
      if (stated && record) {
        caughtLies.push({ suspect: s.id, assertion: lie, statedBy: stated.ref.id, contradictedBy: record });
      } else {
        uncaughtLies.push({ suspect: s.id, assertion: lie });
      }
    }
  }

  // 5. The verdict, with reasons a writer can act on.
  const reasons: string[] = [];
  for (const s of status) {
    if (s.opportunity && provedBy((p) => offScene(p, s.id))) {
      reasons.push(`reachable evidence both places ${s.id} at the scene and rules them out`);
    }
  }
  if (proven.length === 0) {
    const gaps = status
      .filter((s) => !s.exclusion)
      .map((s) => {
        const missing = [!s.opportunity && "opportunity", !s.means && "means", !s.motive && "motive"].filter(Boolean);
        return `${s.id} (unproven: ${missing.join(", ")})`;
      });
    reasons.push(`no suspect has opportunity, means and motive proven by reachable evidence: ${gaps.join("; ")}`);
  } else if (proven.length > 1) {
    reasons.push(`more than one suspect is fully proven: [${proven.join(", ")}]`);
  }
  if (survivors.length > 1) {
    reasons.push(`[${survivors.join(", ")}] all still fit: no reachable evidence rules out ${survivors.length - 1} of them`);
  } else if (survivors.length === 0) {
    reasons.push("reachable evidence rules out every suspect");
  }
  for (const lie of uncaughtLies) {
    const prop = assertion.get(lie.assertion)!.prop;
    // Keep every lie by a positively identified suspect catchable, along with any other
    // speaker's claim about a fact used to establish opportunity, means or motive.
    if (proven.includes(lie.suspect) || prop.kind === "motive" || (prop.kind === "at" && prop.slot === death.slot)
      || (prop.kind === "means" && prop.means === c.victim.means)) {
      reasons.push(`the lie ${lie.assertion} by ${lie.suspect} cannot be caught: the statement or an independent record is out of reach`);
    }
  }

  // 6. The proof path: the evidence the verdict rests on, and the actions that reach it.
  let proof: SolveResult["proof"] = null;
  if (reasons.length === 0) {
    const culprit = status.find((s) => s.id === proven[0])!;
    const needed = new Set<string>([culprit.opportunity!, culprit.means!, culprit.motive!]);
    for (const s of status) {
      if (s.id === culprit.id) continue;
      for (const record of s.exclusion!) needed.add(record);
    }

    const actions = new Set<string>();
    const reach = (item: string) => {
      const via = held.get(item);
      if (!via || actions.has(via)) return; // briefing items need no action
      actions.add(via);
      for (const r of byKey.get(via)!.requires) reach(r);
    };
    for (const e of needed) reach(e);

    const path = [...actions].sort((a, b) => position.get(a)! - position.get(b)!).map((k) => byKey.get(k)!.ref);
    if (path.length > c.sessionCap) {
      reasons.push(`the proof needs ${path.length} actions, but a session allows ${c.sessionCap}`);
    } else {
      proof = { actions: path, evidence: [...needed] };
    }
  }

  return { solvable: reasons.length === 0, survivors, proven, proof, caughtLies, uncaughtLies, reasons };
}

export interface CaseCheck {
  /** True only when the case is valid and a player can solve it. */
  accepted: boolean;
  validation: ValidationResult;
  solve: SolveResult | null;
  reasons: string[];
}

/** All three layers. This is the gate every case passes before anyone plays it. */
export function checkCase(input: unknown): CaseCheck {
  const validation = validateCase(input);
  if (!validation.ok) {
    return { accepted: false, validation, solve: null, reasons: validation.issues.map((i) => `${i.layer}: ${i.message}`) };
  }
  const result = solve(validation.case);
  return { accepted: result.solvable, validation, solve: result, reasons: result.reasons };
}
