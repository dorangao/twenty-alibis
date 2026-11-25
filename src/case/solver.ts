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
  /** Can a player prove one suspect, rule out everyone else, and catch every lie that matters, each within one session? */
  solvable: boolean;
  /** The suspects left open by the best notebook a player can build in one session. */
  survivors: string[];
  /**
   * The smallest sets of open suspects that one-session notebooks can reach. Usually one set.
   * More than one means different sessions clear different people and none clears them all.
   */
  survivorSets: string[][];
  /** False when `survivorSets` is only a sample: the search was cut short, or the list was too long. */
  survivorSetsComplete: boolean;
  /** Suspects with opportunity, means and motive all proven in that notebook. */
  proven: string[];
  /** One session that proves the case: its actions in a legal order, and the evidence it rests on. */
  proof: { actions: ActionRef[]; evidence: string[] } | null;
  caughtLies: CaughtLie[];
  uncaughtLies: { suspect: string; assertion: string }[];
  /** Why the case is not solvable. Empty when it is. */
  reasons: string[];
  /** False when the search hit its work limit. Such a case is refused, never accepted. */
  exhaustive: boolean;
}

/** How many search states one case may cost before the solver gives up and refuses it. */
const WORK_LIMIT = 200_000;
/** Extra states spent on shortening a proof that already fits, or on diagnostics. */
const POLISH_LIMIT = 20_000;

interface Act {
  index: number;
  bit: bigint;
  ref: ActionRef;
  suspect?: string;
  yields: string[];
  requires: string[];
}

/**
 * A goal is a list of options. An option is a list of groups, and a group is a list of
 * interchangeable items. The goal is met when, for at least one option, the notebook holds
 * some item from every group. Groups keep "any one of these records" as a choice for the
 * search to make, so the alternatives are never multiplied out.
 */
type Option = string[][];
type Goal = Option[];
/** The most survivor sets a result lists. */
const MAX_SURVIVOR_SETS = 50;

class WorkLimitReached extends Error {}
class Budget {
  used = 0;
  constructor(private readonly limit: number) {}
  spend(): void {
    if (++this.used > this.limit) throw new WorkLimitReached();
  }
}

// "This suspect said this" is tracked apart from the assertion itself: a lie is only
// caught if the liar was the one heard saying it.
const said = (suspect: string, assertion: string) => `\u0001said\u0001${suspect}\u0001${assertion}`;

/**
 * Layer 3 of the case check: the player proof.
 *
 * A player has one session of at most `sessionCap` actions. The solver searches for a whole
 * session, not for clues one at a time: two clues that are each within reach do not help if
 * no single session can hold both. Only authoritative evidence proves or rules out anything.
 * Testimony can unlock further actions and nothing more. Unknown is never an exclusion.
 *
 * Candidate proof uses no answer key. The separate catchability check uses the declared lies.
 */
export function solve(c: Case): SolveResult {
  const assertion = new Map(c.assertions.map((a) => [a.id, a]));
  const death = c.victim.death;
  const cap = c.sessionCap;

  // --- The player's world: actions, what they need and what they give. ---
  const acts: Act[] = [
    ...c.actions.topics.map((t) => ({
      ref: { type: "topic" as const, id: t.id },
      suspect: t.suspect,
      yields: [...t.yields, ...t.yields.map((a) => said(t.suspect, a))],
      requires: t.requires ?? [],
    })),
    ...c.actions.inspections.map((i) => ({
      ref: { type: "inspection" as const, id: i.id },
      yields: i.yields,
      requires: i.requires ?? [],
    })),
  ].map((act, index) => ({ ...act, index, bit: 1n << BigInt(index) }));

  const providers = new Map<string, Act[]>();
  for (const act of acts) {
    for (const item of act.yields) {
      const list = providers.get(item);
      if (list) list.push(act);
      else providers.set(item, [act]);
    }
  }
  const briefing = new Set(c.briefing.evidence);

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
  const met = (goal: Goal, held: Set<string>): string[] | undefined => {
    for (const option of goal) {
      const picks = option.map((group) => group.find((item) => held.has(item)));
      if (picks.every((item) => item !== undefined)) return picks as string[];
    }
    return undefined;
  };

  /** What a notebook shows: who is still open, and who is fully proven. */
  const assess = (held: Set<string>) => {
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

  // --- Search. ---
  // Actions that could ever help toward a goal: those that give one of its items, and
  // those that give something such an action needs, and so on.
  const relevantCache = new Map<Goal, Act[]>();
  const relevantTo = (goal: Goal): Act[] => {
    let list = relevantCache.get(goal);
    if (list) return list;
    const wanted = new Set<string>(goal.flat(2));
    const found = new Set<Act>();
    for (const item of wanted) {
      for (const act of providers.get(item) ?? []) {
        if (found.has(act)) continue;
        found.add(act);
        for (const r of act.requires) wanted.add(r);
      }
    }
    list = [...found].sort((a, b) => a.index - b.index);
    relevantCache.set(goal, list);
    return list;
  };

  const take = (held: Set<string>, act: Act) => {
    const next = new Set(held);
    for (const y of act.yields) next.add(y);
    return next;
  };
  const usable = (act: Act, held: Set<string>, mask: bigint) =>
    !(mask & act.bit) && act.requires.every((r) => held.has(r)) && !act.yields.every((y) => held.has(y));

  /**
   * One legal session of at most `limit` actions that meets every goal, or null if there is
   * none. Complete: the search only ever takes an action that is legal right now and could
   * help the first unmet goal, and any session that works contains such an action.
   */
  const findSession = (goals: Goal[], limit: number, budget: Budget): { path: Act[]; held: Set<string> } | null => {
    const dead = new Set<bigint>();
    const dfs = (path: Act[], held: Set<string>, mask: bigint): { path: Act[]; held: Set<string> } | null => {
      const goal = goals.find((g) => !met(g, held));
      if (!goal) return { path, held };
      if (path.length === limit || dead.has(mask)) return null;
      budget.spend();
      for (const act of relevantTo(goal)) {
        if (!usable(act, held, mask)) continue;
        const result = dfs([...path, act], take(held, act), mask | act.bit);
        if (result) return result;
      }
      dead.add(mask);
      return null;
    };
    return dfs([], new Set(briefing), 0n);
  };

  /** A session within the cap, shortened to the fewest actions when that is cheap to establish. */
  const shortestSession = (goals: Goal[], limit: number, budget: Budget) => {
    const first = findSession(goals, limit, budget);
    if (!first) return null;
    let best = first;
    let minimal = true;
    const polish = new Budget(POLISH_LIMIT);
    try {
      for (let k = 0; k < first.path.length; k++) {
        const shorter = findSession(goals, k, polish);
        if (shorter) {
          best = shorter;
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof WorkLimitReached)) throw error;
      minimal = false;
    }
    return { ...best, minimal };
  };

  // Everything reachable with no cap at all: an upper bound on what any session can show.
  let everything = new Set(briefing);
  let everythingCount = 0;
  for (let progressed = true, mask = 0n; progressed; ) {
    progressed = false;
    for (const act of acts) {
      if (mask & act.bit || !act.requires.every((r) => everything.has(r))) continue;
      mask |= act.bit;
      everything = take(everything, act);
      everythingCount++;
      progressed = true;
    }
  }
  const unbounded = assess(everything);

  const reasons: string[] = [];
  const budget = new Budget(WORK_LIMIT);
  let exhaustive = true;
  const guarded = <T>(work: () => T, fallback: T): T => {
    try {
      return work();
    } catch (error) {
      if (!(error instanceof WorkLimitReached)) throw error;
      exhaustive = false;
      return fallback;
    }
  };

  // --- 1. The accusation: one session that proves one suspect and rules out the rest. ---
  let accused: string | null = null;
  let proofSession: { path: Act[]; held: Set<string> } | null = null;
  let proofGoals: Goal[] = [];
  for (const candidate of unbounded.proven) {
    // Skip the search when even an unlimited session could not meet a goal.
    const goals = accusationGoals(candidate);
    if (!goals.every((g) => met(g, everything))) continue;
    const session = guarded(() => shortestSession(goals, cap, budget), null);
    if (session) {
      accused = candidate;
      proofSession = session;
      proofGoals = goals;
      break;
    }
  }

  // --- 2. Who is still open after the best single session. ---
  let survivorSets: string[][];
  let survivorSetsComplete = true;
  let proven: string[];
  if (accused) {
    survivorSets = [[accused]];
    proven = [accused];
  } else if (everythingCount <= cap) {
    survivorSets = [unbounded.survivors];
    proven = unbounded.proven;
  } else {
    // Not everything fits in one session, so look at every session that does.
    const exclusions = c.suspects.map((s) => exclusionGoal(s.id));
    const helpful = [...new Set(exclusions.flatMap(relevantTo))].sort((a, b) => a.index - b.index);
    const seen = new Set<bigint>();
    const best = new Map<string, string[]>();
    let fewest = Infinity;
    let provenInBest: string[] = [];
    const polish = new Budget(POLISH_LIMIT);
    const walk = (held: Set<string>, mask: bigint, depth: number): void => {
      if (seen.has(mask)) return;
      seen.add(mask);
      polish.spend();
      const view = assess(held);
      if (view.survivors.length < fewest) {
        fewest = view.survivors.length;
        best.clear();
        provenInBest = view.proven;
      }
      if (view.survivors.length === fewest) best.set(view.survivors.join("\u0001"), view.survivors);
      if (depth === cap) return;
      for (const act of helpful) if (usable(act, held, mask)) walk(take(held, act), mask | act.bit, depth + 1);
    };
    try {
      walk(new Set(briefing), 0n, 0);
    } catch (error) {
      if (!(error instanceof WorkLimitReached)) throw error;
      // Too many sessions to look at them all. What was seen is real, but it is only a sample.
      // The case is refused either way, so the verdict itself stays exact.
      survivorSetsComplete = false;
    }
    survivorSets = [...best.values()];
    if (survivorSets.length > MAX_SURVIVOR_SETS) {
      survivorSets = survivorSets.slice(0, MAX_SURVIVOR_SETS);
      survivorSetsComplete = false;
    }
    proven = provenInBest;
  }
  const survivors = survivorSets[0] ?? [];

  // --- 3. Lies: each must be catchable in some single session of its own. ---
  const caughtLies: CaughtLie[] = [];
  const uncaughtLies: { suspect: string; assertion: string }[] = [];
  for (const s of c.suspects) {
    for (const lie of s.lies) {
      const prop = assertion.get(lie)?.prop;
      const rebuttals = prop ? evidenceFor((p) => contradicts(p, prop)) : [];
      // The liar is heard saying it, and any one record against it is in the same notebook.
      const goal: Goal = rebuttals.length > 0 ? [[[said(s.id, lie)], rebuttals]] : [];
      const session = met(goal, everything) ? guarded(() => findSession([goal], cap, budget), null) : null;
      if (session) {
        const statedBy = session.path.find((act) => act.suspect === s.id && act.yields.includes(lie))!.ref.id;
        const contradictedBy = rebuttals.find((e) => session.held.has(e))!;
        caughtLies.push({ suspect: s.id, assertion: lie, statedBy, contradictedBy });
      } else {
        uncaughtLies.push({ suspect: s.id, assertion: lie });
      }
    }
  }

  // --- 4. The verdict, with reasons a writer can act on. ---
  for (const s of c.suspects) {
    const here = met(suspectGoals.get(s.id)!.positive[0]!, everything);
    const elsewhere = evidenceFor(offScene(s.id)).some((e) => everything.has(e));
    if (here && elsewhere) reasons.push(`reachable evidence both places ${s.id} at the scene and somewhere else`);
  }
  if (!accused) {
    const provable = unbounded.proven.length === 1 && unbounded.survivors.length === 1;
    if (provable && exhaustive) {
      // The evidence exists, but no single session can gather it.
      const goals = accusationGoals(unbounded.proven[0]!);
      const full = guarded(() => shortestSession(goals, acts.length, new Budget(POLISH_LIMIT)), null);
      reasons.push(
        full?.minimal
          ? `the proof needs ${full.path.length} actions, but a session allows ${cap}`
          : `the proof needs more than ${cap} actions, which is all a session allows`,
      );
    }
    if (unbounded.proven.length === 0) {
      const gaps = unbounded.survivors.map((id) => {
        const positive = suspectGoals.get(id)!.positive;
        const missing = ["opportunity", "means", "motive"].filter((_name, i) => !met(positive[i]!, everything));
        return `${id} (unproven: ${missing.join(", ")})`;
      });
      reasons.push(`no suspect has opportunity, means and motive proven by reachable evidence: ${gaps.join("; ")}`);
    } else if (unbounded.proven.length > 1) {
      reasons.push(`more than one suspect is fully proven: [${unbounded.proven.join(", ")}]`);
    }
    if (survivors.length > 1) {
      const others = survivorSets.length > 1 ? ` (another session leaves [${survivorSets[1]!.join(", ")}])` : "";
      // A case over the cap may have far more sessions than can be listed.
      reasons.push(`[${survivors.join(", ")}] all still fit: no reachable evidence rules out ${survivors.length - 1} of them${others}`);
    } else if (survivors.length === 0) {
      reasons.push("reachable evidence rules out every suspect");
    }
  }
  for (const lie of uncaughtLies) {
    const prop = assertion.get(lie.assertion)!.prop;
    // Every lie by the accused must be catchable, and so must anyone's claim about a fact
    // that opportunity, means or motive rests on.
    const matters =
      lie.suspect === accused ||
      unbounded.proven.includes(lie.suspect) ||
      prop.kind === "motive" ||
      (prop.kind === "at" && prop.slot === death.slot) ||
      (prop.kind === "means" && prop.means === c.victim.means);
    if (matters) {
      reasons.push(`the lie ${lie.assertion} by ${lie.suspect} cannot be caught: no single session holds both the statement and an independent record against it`);
    }
  }
  if (!exhaustive) {
    reasons.push("the solver reached its work limit before settling this case, so it is refused");
  }

  // --- 5. The proof a player could follow. ---
  let proof: SolveResult["proof"] = null;
  if (proofSession && reasons.length === 0) {
    const cited = new Set<string>();
    for (const goal of proofGoals) for (const item of met(goal, proofSession.held)!) cited.add(item);
    proof = { actions: proofSession.path.map((act) => act.ref), evidence: [...cited] };
  }

  return { solvable: reasons.length === 0, survivors, survivorSets, survivorSetsComplete, proven, proof, caughtLies, uncaughtLies, reasons, exhaustive };
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
  const reasons = [...result.reasons];
  // The player proof never looks at the answer key, so compare the two here.
  if (result.solvable && result.proven[0] !== validation.case.culprit.suspect) {
    reasons.push(`the reachable evidence proves ${result.proven[0]}, but the hidden culprit is ${validation.case.culprit.suspect}`);
  }
  return { accepted: reasons.length === 0, validation, solve: result, reasons };
}
