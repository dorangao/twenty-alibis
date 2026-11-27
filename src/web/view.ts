import { renderAssertion, type Lang } from "../agents/render";
import type { LineSource } from "../agents/suspect-turn";
import type { Case, Text } from "../case/schema";
import { NOTE_MARK, PROOF_RULES } from "../game/rules";
import { actionsLeft, inspectionMenu, notebook, reveal, topicMenu, type Missing, type Session } from "../game/session";

/**
 * What a page may be shown.
 *
 * The page never receives a case. It receives this: one projection of a case and a session,
 * built here and nowhere else, field by field. Nothing is copied across wholesale, so a
 * field added to the case file tomorrow does not reach a browser unless someone writes it
 * down here.
 *
 * Before the accusation the view holds only what the player has been given or has found:
 * the public briefing, the evidence held, the statements heard, and the topics and
 * inspections open now. It holds no culprit, no assertion, no whereabouts, no evidence not
 * yet held, and nothing that is still locked. After the accusation it also holds the verdict
 * and the reveal.
 *
 * Ids: a page needs an id only to name something back to the server, so only suspects, open
 * topics, open inspections and held evidence carry one. Statements are keyed by where they
 * were heard, never by the case file's assertion id.
 */

/** A case as the library lists it. */
export interface CaseCard {
  id: string;
  title: Text;
  setting: Text;
  suspects: number;
  rooms: number;
  actions: number;
}

export interface View {
  session: string;
  caseId: string;
  title: Text;
  setting: Text;
  victim: { name: Text; cause: Text; died: { slot: string; room: Text }; found: { slot: string; room: Text } };
  /** The rules of proof, the same text the terminal and the detective are given. */
  rules: Text[];
  /** How an item that proves nothing is marked. */
  noteMark: Text;
  people: { id: string; name: Text; role: Text; persona: Text }[];
  rooms: Text[];
  slots: string[];
  actions: { used: number; cap: number; left: number };
  /** Whether a question in the player's own words can be asked: only when the model is on. */
  model: "on" | "off";
  evidence: { id: string; text: Text; note: boolean }[];
  statements: { key: string; turn: number; suspect: string; text: Text; contradictedBy: string[] }[];
  topics: { suspect: string; id: string; label: Text; heard: boolean }[];
  inspections: { id: string; label: Text; done: boolean }[];
  transcript: {
    n: number;
    suspect: string;
    question: string;
    line: string;
    language: Lang;
    /** Where the line came from: the model, or code. */
    source: LineSource;
    /** How many statements this turn put in the notebook. */
    noted: number;
  }[];
  /** This session's confirmed model use. */
  cost: { requests: number; nano: number };
  over: boolean;
  verdict?: {
    accused: string;
    cited: string[];
    outcome: "solved" | "right-but-unproven" | "wrong";
    missing: Missing[];
    open: string[];
    accusedRuledOut: boolean;
    actions: number;
  };
  reveal?: {
    culprit: string;
    motive: Text;
    timeline: { suspect: string; at: { slot: string; room: Text }[] }[];
    lies: { suspect: string; text: Text; heard: boolean; caught: boolean }[];
  };
}

const UNKNOWN: Text = { en: "?", zh: "？" };

export function caseCard(c: Case): CaseCard {
  return { id: c.id, title: { ...c.title }, setting: { ...c.setting }, suspects: c.suspects.length, rooms: c.locations.length, actions: c.sessionCap };
}

export function viewOf(c: Case, s: Session, model: "on" | "off"): View {
  const room = (id: string): Text => {
    const found = c.locations.find((l) => l.id === id);
    return found ? { ...found.name } : UNKNOWN;
  };
  const book = notebook(c, s);
  const view: View = {
    session: s.id,
    caseId: c.id,
    title: { ...c.title },
    setting: { ...c.setting },
    victim: {
      name: { ...c.victim.name },
      cause: { ...c.victim.cause },
      died: { slot: c.victim.death.slot, room: room(c.victim.death.location) },
      found: { slot: c.victim.found.slot, room: room(c.victim.found.location) },
    },
    rules: PROOF_RULES.map((rule) => ({ en: rule.en, zh: rule.zh })),
    noteMark: { en: NOTE_MARK.en, zh: NOTE_MARK.zh },
    people: c.suspects.map((x) => ({ id: x.id, name: { ...x.name }, role: { ...x.role }, persona: { ...x.persona } })),
    rooms: c.locations.map((l) => ({ ...l.name })),
    slots: [...c.slots],
    actions: { used: s.actions, cap: c.sessionCap, left: actionsLeft(c, s) },
    model,
    evidence: book.evidence.map((e) => ({ id: e.id, text: { ...e.text }, note: !e.authoritative })),
    statements: book.statements.map((st, i) => ({
      key: `${st.turn}.${i}`,
      turn: st.turn,
      suspect: st.suspect,
      text: { en: st.en, zh: st.zh },
      contradictedBy: book.contradictions.filter((x) => x.suspect === st.suspect && x.assertion === st.assertion).map((x) => x.evidence),
    })),
    topics: c.suspects.flatMap((x) => topicMenu(c, s, x.id).map((m) => ({ suspect: x.id, id: m.id, label: { ...m.label }, heard: m.heard }))),
    inspections: inspectionMenu(c, s).map((m) => ({ id: m.id, label: { ...m.label }, done: m.done })),
    transcript: s.turns.map((r) => ({
      n: r.n,
      suspect: r.turn.suspect,
      question: r.question,
      line: r.turn.line,
      language: r.turn.language,
      source: r.turn.source,
      noted: r.turn.statements.length,
    })),
    cost: { requests: s.turns.reduce((sum, r) => sum + r.turn.requests, 0), nano: s.turns.reduce((sum, r) => sum + r.turn.costNano, 0) },
    over: s.verdict !== undefined,
  };
  if (s.verdict) {
    const v = s.verdict;
    view.verdict = { accused: v.accused, cited: [...v.cited], outcome: v.outcome, missing: [...v.missing], open: [...v.open], accusedRuledOut: v.accusedRuledOut, actions: v.actions };
    const truth = reveal(c, s);
    const assertion = new Map(c.assertions.map((a) => [a.id, a]));
    view.reveal = {
      culprit: truth.culprit,
      motive: { ...(c.motives.find((m) => m.id === truth.motive)?.text ?? UNKNOWN) },
      timeline: truth.timeline.map((row) => ({ suspect: row.suspect, at: c.slots.map((slot) => ({ slot, room: room(row.whereabouts[slot] ?? "") })) })),
      lies: truth.lies.map((lie) => {
        const a = assertion.get(lie.assertion);
        return {
          suspect: lie.suspect,
          text: a ? { en: renderAssertion(c, lie.suspect, a, "en"), zh: renderAssertion(c, lie.suspect, a, "zh") } : UNKNOWN,
          heard: lie.heard,
          caught: lie.caught,
        };
      }),
    };
  }
  return view;
}
