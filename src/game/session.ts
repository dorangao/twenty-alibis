import { languageOf } from "../agents/line-guard";
import type { Lang } from "../agents/render";
import { deflection, suspectTurn, type SuspectTurn } from "../agents/suspect-turn";
import { isOpen } from "../case/access";
import { proofRules } from "../case/proof";
import type { Case, Evidence, Text } from "../case/schema";
import { contradicts } from "../case/truth";
import type { Metered } from "../metered";

/**
 * One player's game on one case.
 *
 * A session is plain data, so it can be stored and picked up again. Every function here
 * takes a session and returns a new one; none of them changes its argument.
 *
 * The rules, all of them code:
 *  - A new question and a new inspection each cost one action. A session has `sessionCap`
 *    actions. Hearing a topic again, asking the very same question again, or looking at a
 *    record again costs nothing and sends nothing: the saved result is returned. A question
 *    in other words is a new question.
 *  - What is open depends on what the player holds, by the same rule the solver uses.
 *  - The notebook holds records and statements. A statement is worded by code. A contradiction
 *    is shown when a held, authoritative record and a heard statement cannot both be true.
 *  - An accusation is scored with the solver's own rules of proof, on the evidence the
 *    player cites. It ends the session. Only then can the truth be revealed.
 */

export type SessionErrorCode =
  /** The session has ended with an accusation. */
  | "over"
  /** No actions left. */
  | "cap"
  /** No such suspect, or no such topic or inspection open to this player. A locked one and a missing one look the same. */
  | "not-available"
  | "bad-question"
  /** An accusation cited evidence the player does not hold. */
  | "not-held";

export class SessionError extends Error {
  override readonly name = "SessionError";
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A question may not be longer than this many characters. */
export const MAX_QUESTION_CHARS = 300;

export interface TurnRecord {
  /** The question's number in the session. Numbers rise but may skip: a question that was refused and not kept still used one. */
  n: number;
  question: string;
  /** The topics that were open to this suspect when the question was asked. */
  menu: string[];
  turn: SuspectTurn;
}

export type Missing = "opportunity" | "means" | "motive";

export interface Verdict {
  accused: string;
  /** The evidence the player cited. */
  cited: string[];
  /**
   * solved             the right person, and the cited evidence proves it and rules out everyone else
   * right-but-unproven the right person, but the cited evidence leaves a gap
   * wrong              not the culprit
   */
  outcome: "solved" | "right-but-unproven" | "wrong";
  /** What the cited evidence fails to prove about the accused. */
  missing: Missing[];
  /** Other suspects the cited evidence does not rule out. */
  open: string[];
  /** True when the cited evidence itself rules the accused out. */
  accusedRuledOut: boolean;
  /** Actions used when the accusation was made. */
  actions: number;
}

export interface Session {
  id: string;
  caseId: string;
  /** Actions used so far. */
  actions: number;
  /** Evidence held, in the order it was gained. The briefing comes first. */
  evidence: string[];
  /** Inspections made, in order. */
  inspections: string[];
  /**
   * Questions that reached a suspect, kept or not. It numbers a question's requests, so the
   * same request id is never used for two different questions.
   */
  asked: number;
  turns: TurnRecord[];
  verdict?: Verdict;
}

export function startSession(c: Case, id: string): Session {
  return { id, caseId: c.id, actions: 0, evidence: [...c.briefing.evidence], inspections: [], asked: 0, turns: [] };
}

/** Everything the player holds: evidence, and the statements they have heard. */
export function heldBy(session: Session): Set<string> {
  return new Set([...session.evidence, ...session.turns.flatMap((t) => t.turn.statements.map((s) => s.assertion))]);
}

export const actionsLeft = (c: Case, session: Session): number => Math.max(0, c.sessionCap - session.actions);

function check(c: Case, session: Session): void {
  if (session.caseId !== c.id) throw new Error(`session ${session.id} belongs to case ${session.caseId}, not ${c.id}`);
}
function mustBeLive(session: Session): void {
  if (session.verdict) throw new SessionError("over", "the session ended with an accusation");
}

// ---- What is on offer ----

/** The topics a suspect can be asked about now. `heard` is true when its statements are already in the notebook. */
export function topicMenu(c: Case, session: Session, suspect: string): { id: string; label: Text; heard: boolean }[] {
  check(c, session);
  const held = heldBy(session);
  return c.actions.topics
    .filter((t) => t.suspect === suspect && isOpen(t, held))
    .map((t) => ({ id: t.id, label: t.label, heard: session.turns.some((r) => r.turn.suspect === suspect && r.turn.topic === t.id) }));
}

/** The records and places a player can look at now. */
export function inspectionMenu(c: Case, session: Session): { id: string; label: Text; done: boolean }[] {
  check(c, session);
  const held = heldBy(session);
  return c.actions.inspections.filter((i) => isOpen(i, held)).map((i) => ({ id: i.id, label: i.label, done: session.inspections.includes(i.id) }));
}

// ---- Actions ----

export function inspect(c: Case, session: Session, inspectionId: string): { session: Session; evidence: Evidence[]; repeated: boolean } {
  check(c, session);
  mustBeLive(session);
  const inspection = c.actions.inspections.find((i) => i.id === inspectionId && isOpen(i, heldBy(session)));
  if (!inspection) throw new SessionError("not-available", `nothing to inspect called ${inspectionId}`);
  const evidence = c.evidence.filter((e) => inspection.yields.includes(e.id));
  if (session.inspections.includes(inspectionId)) return { session, evidence, repeated: true };
  if (actionsLeft(c, session) === 0) throw new SessionError("cap", "no actions left");
  return {
    session: {
      ...session,
      actions: session.actions + 1,
      inspections: [...session.inspections, inspectionId],
      evidence: [...session.evidence, ...inspection.yields.filter((id) => !session.evidence.includes(id))],
    },
    evidence,
    repeated: false,
  };
}

export interface AskArgs {
  suspect: string;
  /** A topic picked from the menu. */
  topic?: string;
  /** The player's own words. Needed when no topic is given. */
  question?: string;
  /** The language to use for a menu topic. A typed question sets its own. A topic heard before is replayed in its own language unless one is named. */
  language?: Lang;
  cacheKey?: string;
}

export interface AskResult {
  session: Session;
  turn: SuspectTurn;
  /**
   * True when a saved turn was returned: nothing was sent and no action was used. If another
   * language was asked for, the turn is a view in that language, worded by code.
   */
  replayed: boolean;
  /**
   * False when the spend guard refused the question before anything was sent and there was
   * no statement to give: the turn is not kept, no action is used, and it may be asked again.
   * The returned session still differs from the one passed in: its question counter moved on.
   */
  recorded: boolean;
}

/** Ask a suspect one question: a topic from its menu, or the player's own words. */
export async function ask(metered: Metered, c: Case, session: Session, args: AskArgs): Promise<AskResult> {
  check(c, session);
  mustBeLive(session);
  if (!c.suspects.some((s) => s.id === args.suspect)) throw new SessionError("not-available", `no suspect called ${args.suspect}`);
  const held = heldBy(session);
  // The topics open to this suspect now. An earlier question is "the same question" only if these were the same then.
  const menu = c.actions.topics.filter((t) => t.suspect === args.suspect && isOpen(t, held)).map((t) => t.id);
  const typed = args.question?.trim() ?? "";

  let question: string;
  if (args.topic !== undefined) {
    const topic = c.actions.topics.find((t) => t.id === args.topic && t.suspect === args.suspect && isOpen(t, held));
    if (!topic) throw new SessionError("not-available", `${args.suspect} has no topic called ${args.topic}`);
    // Already heard, by the menu or because an earlier question landed on it: give the saved turn.
    const saved = session.turns.find((r) => r.turn.suspect === args.suspect && r.turn.topic === topic.id);
    if (saved) {
      const language = typed !== "" ? languageOf(typed) : (args.language ?? saved.turn.language);
      return { session, turn: inLanguage(session, saved, language), replayed: true, recorded: true };
    }
    question = typed || topic.label[args.language ?? "en"];
  } else {
    question = typed;
    if (question === "") throw new SessionError("bad-question", "a question needs a topic or some words");
    // The same words to the same suspect with the same topics open: the same answer, for nothing.
    // A turn that hit a problem is not replayed, so the question can be asked again.
    const wanted = sameWords(question);
    const saved = session.turns.find(
      (r) =>
        r.turn.suspect === args.suspect &&
        r.turn.problem === undefined &&
        sameWords(r.question) === wanted &&
        // A record stored before menus were kept has none: it is never taken for the same question.
        Array.isArray(r.menu) &&
        r.menu.length === menu.length &&
        r.menu.every((id, i) => id === menu[i]),
    );
    if (saved) return { session, turn: saved.turn, replayed: true, recorded: true };
  }
  if ([...question].length > MAX_QUESTION_CHARS) throw new SessionError("bad-question", `a question may have at most ${MAX_QUESTION_CHARS} characters`);
  if (actionsLeft(c, session) === 0) throw new SessionError("cap", "no actions left");

  const n = session.asked + 1;
  const turn = await suspectTurn({
    metered,
    c,
    suspect: args.suspect,
    held,
    question,
    turnId: `${session.id}:${n}`,
    ...(args.topic !== undefined ? { topic: args.topic } : {}),
    ...(args.cacheKey ? { cacheKey: args.cacheKey } : {}),
  });

  // Nothing left this machine and there is nothing to note down: as if it was never asked.
  if (turn.requests === 0 && turn.statements.length === 0) return { session: { ...session, asked: n }, turn, replayed: false, recorded: false };
  return { session: { ...session, asked: n, actions: session.actions + 1, turns: [...session.turns, { n, question, menu, turn }] }, turn, replayed: false, recorded: true };
}

/** Two questions are the same when they differ only in case, width or spacing. Nothing cleverer is attempted. */
const sameWords = (question: string): string => question.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * A saved turn, shown in another language. The model's line exists in one language only, so
 * the other language gets the statements as code words them, or the fixed line when there
 * are none. This is a view: the saved turn is not changed and nothing is sent.
 */
function inLanguage(session: Session, saved: TurnRecord, language: Lang): SuspectTurn {
  const turn = saved.turn;
  if (turn.language === language) return turn;
  return turn.statements.length > 0
    ? { ...turn, language, line: turn.statements.map((s) => s[language]).join(" "), source: "rendered" }
    : { ...turn, language, line: deflection(language, `${session.id}:${saved.n}`), source: "deflection" };
}

// ---- The notebook ----

export interface Notebook {
  evidence: { id: string; kind: Evidence["kind"]; authoritative: boolean; text: Text }[];
  /** Each statement once, at the turn it was first heard, worded by code. */
  statements: { turn: number; suspect: string; assertion: string; en: string; zh: string }[];
  /** A heard statement and a held authoritative record that cannot both be true. */
  contradictions: { suspect: string; assertion: string; evidence: string }[];
}

export function notebook(c: Case, session: Session): Notebook {
  check(c, session);
  const evidence = session.evidence.flatMap((id) => c.evidence.filter((e) => e.id === id));
  const statements: Notebook["statements"] = [];
  for (const record of session.turns) {
    for (const s of record.turn.statements) {
      if (statements.some((x) => x.suspect === record.turn.suspect && x.assertion === s.assertion)) continue;
      statements.push({ turn: record.n, suspect: record.turn.suspect, assertion: s.assertion, en: s.en, zh: s.zh });
    }
  }
  const prop = new Map(c.assertions.map((a) => [a.id, a.prop]));
  const contradictions: Notebook["contradictions"] = [];
  for (const s of statements) {
    const said = prop.get(s.assertion);
    if (!said) continue;
    for (const e of evidence) {
      if (!e.authoritative) continue;
      if (e.proves.some((id) => prop.has(id) && contradicts(prop.get(id)!, said))) contradictions.push({ suspect: s.suspect, assertion: s.assertion, evidence: e.id });
    }
  }
  return { evidence: evidence.map((e) => ({ id: e.id, kind: e.kind, authoritative: e.authoritative, text: e.text })), statements, contradictions };
}

// ---- The accusation ----

const MISSING: Missing[] = ["opportunity", "means", "motive"];

/**
 * Name a suspect and cite evidence. The cited evidence is judged by the solver's own rules:
 * it must prove opportunity, means and a motive for the accused, and rule out everyone else.
 * Any set of held evidence that does so is accepted. Statements prove nothing.
 */
export function accuse(c: Case, session: Session, args: { suspect: string; evidence: readonly string[] }): { session: Session; verdict: Verdict } {
  check(c, session);
  mustBeLive(session);
  if (!c.suspects.some((s) => s.id === args.suspect)) throw new SessionError("not-available", `no suspect called ${args.suspect}`);
  const cited = [...new Set(args.evidence)];
  const unheld = cited.filter((id) => !session.evidence.includes(id));
  if (unheld.length > 0) throw new SessionError("not-held", `not in the notebook: ${unheld.join(", ")}`);

  const rules = proofRules(c);
  const shown = new Set(cited);
  const goals = rules.suspectGoals.get(args.suspect)!;
  const missing = MISSING.filter((_name, i) => !rules.met(goals.positive[i]!, shown));
  const accusedRuledOut = rules.met(goals.exclusion, shown) !== undefined;
  const open = rules.assess(shown).survivors.filter((id) => id !== args.suspect);
  const right = args.suspect === c.culprit.suspect;
  const proven = missing.length === 0 && open.length === 0 && !accusedRuledOut;

  const verdict: Verdict = {
    accused: args.suspect,
    cited,
    outcome: !right ? "wrong" : proven ? "solved" : "right-but-unproven",
    missing,
    open,
    accusedRuledOut,
    actions: session.actions,
  };
  return { session: { ...session, verdict }, verdict };
}

export interface Reveal {
  culprit: string;
  motive: string;
  /** Where everyone really was, slot by slot. */
  timeline: { suspect: string; whereabouts: Record<string, string> }[];
  /** Every false statement in the case: whether this player heard it, and whether their notebook contradicted it. */
  lies: { suspect: string; assertion: string; heard: boolean; caught: boolean }[];
}

/** The hidden truth. It is given out only after the session has ended with an accusation. */
export function reveal(c: Case, session: Session): Reveal {
  check(c, session);
  if (!session.verdict) throw new SessionError("not-available", "the truth is revealed only after an accusation");
  const book = notebook(c, session);
  return {
    culprit: c.culprit.suspect,
    motive: c.culprit.motive,
    timeline: c.suspects.map((s) => ({ suspect: s.id, whereabouts: { ...s.whereabouts } })),
    lies: c.suspects.flatMap((s) =>
      s.lies.map((assertion) => ({
        suspect: s.id,
        assertion,
        heard: book.statements.some((x) => x.suspect === s.id && x.assertion === assertion),
        caught: book.contradictions.some((x) => x.suspect === s.id && x.assertion === assertion),
      })),
    ),
  };
}
