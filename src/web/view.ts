import { renderAssertion, type Lang } from "../agents/render";
import type { LineSource } from "../agents/suspect-turn";
import type { Case, Text } from "../case/schema";
import { gossipEvery } from "../game/gossip";
import { NOTE_MARK, PROOF_RULES } from "../game/rules";
import { actionsLeft, gossipDue, inspectionMenu, notebook, reveal, topicMenu, type Missing } from "../game/session";
import type { SessionRecord } from "./sessions";

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
 * Nothing in it is named by the case file's own ids. An author's id can say what a thing is
 * ("e-forged-will") or where it stands in the file. The page is given handles instead:
 * people are P1 … in the public roster's order; evidence is E1 … in the order it was gained;
 * topics and inspections are T1 … and I1 …, numbered when they first open to the player and
 * kept from then on (see `SessionRecord`). A request names a handle, and the server takes it
 * only if it is on the current menu or in the notebook.
 */

/** A case as the library lists it. Its id is the library's public name for it. */
export interface CaseCard {
  id: string;
  title: Text;
  setting: Text;
  suspects: number;
  rooms: number;
  actions: number;
}

export interface View {
  /** The session's locator. It is not a credential: see `SessionRecord`. */
  session: string;
  /** Rises each time the session changes. A request to act carries the revision it was made on. */
  revision: number;
  caseId: string;
  title: Text;
  setting: Text;
  victim: { name: Text; cause: Text; died: { slot: string; room: Text }; found: { slot: string; room: Text } };
  /** The rules of proof, the same text the terminal and the detective are given. */
  rules: Text[];
  /** How an item that proves nothing is marked. */
  noteMark: Text;
  people: { handle: string; name: Text; role: Text }[];
  rooms: Text[];
  slots: string[];
  actions: { used: number; cap: number; left: number };
  /** Whether a question in the player's own words can be asked: only when the model is on for this session. */
  model: "on" | "off";
  evidence: { handle: string; text: Text; note: boolean }[];
  /** `from` is set when the person was repeating someone else: whose statement it is. */
  statements: { key: string; turn: number; person: string; text: Text; contradictedBy: string[]; from?: string }[];
  /** `told` is set on a topic that came from gossip: who told this person, and in which round. */
  topics: { handle: string; person: string; label: Text; heard: boolean; told?: { by: string; round: number } }[];
  inspections: { handle: string; label: Text; done: boolean }[];
  transcript: Line[];
  /**
   * Who has spoken with whom between the player's actions. Not there for a session without
   * gossip. It says who told whom, never what: that has to be asked for, from the listener.
   *
   * A round's `state`: "done"; "running" while its server is at work on it; "interrupted"
   * when its server was lost in the middle. An interrupted round is closed and empty, and
   * what it sent, if anything, is not known to the game: only the spend guard's count says.
   */
  gossip?: {
    /** Actions between two rounds. */
    every: number;
    /** True when a round must run before the next new question or inspection. */
    due: boolean;
    rounds: {
      n: number;
      /** Actions used when it ran. */
      after: number;
      state: "done" | "running" | "interrupted";
      /** Who was to pick the listeners. */
      chosenBy: "code" | "model";
      talks: { from: string; to: string; by: "code" | "model" }[];
      /** Speakers who were to ask their agent. Those among them with no talk told nobody. */
      asked: number;
      /** Requests that left the server for this round, and their confirmed cost. */
      requests: number;
      nano: number;
      /**
       * Of those requests, the ones whose cost is not confirmed: they failed on the way or came
       * back unsettled. Their cost, if any, is with the spend guard and not in `nano`. For an
       * interrupted round this is 0 and means nothing: what such a round sent is not known.
       */
      unconfirmed: number;
    }[];
  };
  /**
   * This session's confirmed model use: the requests and cost of the turns and the gossip
   * rounds that were kept. `unfinished` counts questions and gossip rounds that were begun
   * and never finished. What those cost, if anything, is counted by the server's spend
   * guard and is not in `nano`.
   */
  cost: { requests: number; nano: number; unfinished: number };
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
    timeline: { person: string; at: { slot: string; room: Text }[] }[];
    lies: { person: string; text: Text; heard: boolean; caught: boolean }[];
  };
}

/** One exchange as the player saw it. */
export interface Line {
  n: number;
  person: string;
  question: string;
  line: string;
  language: Lang;
  /** Where the line came from: the model, or code. */
  source: LineSource;
  /** How many statements this turn put in the notebook. */
  noted: number;
}

const UNKNOWN: Text = { en: "?", zh: "？" };

export function caseCard(c: Case): CaseCard {
  return { id: c.id, title: { ...c.title }, setting: { ...c.setting }, suspects: c.suspects.length, rooms: c.locations.length, actions: c.sessionCap };
}

/** The handles of one session: how the page's names map to the case's, both ways. */
export function handlesOf(c: Case, record: SessionRecord) {
  const numbered = (prefix: string, ids: readonly string[]) => {
    const handle = new Map(ids.map((id, i) => [id, `${prefix}${i + 1}`]));
    const id = new Map(ids.map((x, i) => [`${prefix}${i + 1}`, x]));
    return { handle: (x: string): string => handle.get(x) ?? "?", id: (h: string): string | undefined => id.get(h) };
  };
  return {
    person: numbered("P", c.suspects.map((x) => x.id)),
    evidence: numbered("E", record.session.evidence),
    topic: numbered("T", record.topics),
    inspection: numbered("I", record.inspections),
  };
}

/**
 * Give a handle to every topic and inspection that is open now and has none yet. They are
 * added in the order a menu lists them, after the ones already numbered.
 */
export function withHandles(c: Case, record: SessionRecord): SessionRecord {
  const s = record.session;
  const topics = [...record.topics];
  for (const x of c.suspects) for (const m of topicMenu(c, s, x.id)) if (!topics.includes(m.id)) topics.push(m.id);
  const inspections = [...record.inspections];
  for (const m of inspectionMenu(c, s)) if (!inspections.includes(m.id)) inspections.push(m.id);
  return { ...record, topics, inspections };
}

/** One turn as the page shows it. */
export function lineOf(c: Case, record: SessionRecord, n: number, question: string, turn: { suspect: string; line: string; language: Lang; source: LineSource; statements: readonly unknown[] }): Line {
  return { n, person: handlesOf(c, record).person.handle(turn.suspect), question, line: turn.line, language: turn.language, source: turn.source, noted: turn.statements.length };
}

/**
 * `interrupted`: the question marked as begun is lost, not in progress. `busy`: a request is
 * at work on the session right now, so a gossip round still marked pending is running, not
 * lost. Only the caller knows either.
 */
export function viewOf(c: Case, record: SessionRecord, model: "on" | "off", interrupted = false, busy = false): View {
  const s = record.session;
  const h = handlesOf(c, record);
  const room = (id: string): Text => {
    const found = c.locations.find((l) => l.id === id);
    return found ? { ...found.name } : UNKNOWN;
  };
  const book = notebook(c, s);
  const rounds = (s.gossip?.rounds ?? []).map((r) => ({ ...r, state: r.lost || (r.pending && !busy) ? ("interrupted" as const) : r.pending ? ("running" as const) : ("done" as const) }));
  const open = new Map(c.suspects.flatMap((x) => topicMenu(c, s, x.id).map((m) => [m.id, { ...m, suspect: x.id }] as const)));
  const openInspections = new Map(inspectionMenu(c, s).map((m) => [m.id, m] as const));
  const view: View = {
    session: s.id,
    revision: record.revision,
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
    people: c.suspects.map((x) => ({ handle: h.person.handle(x.id), name: { ...x.name }, role: { ...x.role } })),
    rooms: c.locations.map((l) => ({ ...l.name })),
    slots: [...c.slots],
    actions: { used: s.actions, cap: c.sessionCap, left: actionsLeft(c, s) },
    model,
    evidence: book.evidence.map((e) => ({ handle: h.evidence.handle(e.id), text: { ...e.text }, note: !e.authoritative })),
    statements: book.statements.map((st, i) => ({
      key: `${st.turn}.${i}`,
      turn: st.turn,
      person: h.person.handle(st.suspect),
      text: { en: st.en, zh: st.zh },
      contradictedBy: book.contradictions.filter((x) => x.suspect === st.suspect && x.assertion === st.assertion && x.source === st.source).map((x) => h.evidence.handle(x.evidence)),
      ...(st.source !== undefined ? { from: h.person.handle(st.source) } : {}),
    })),
    // In handle order, and only what is open now: a handle is kept for good, a place on the menu is not.
    topics: record.topics.flatMap((id) => {
      const m = open.get(id);
      if (!m) return [];
      return [{ handle: h.topic.handle(id), person: h.person.handle(m.suspect), label: { ...m.label }, heard: m.heard, ...(m.gossip !== undefined && m.from !== undefined ? { told: { by: h.person.handle(m.from), round: m.gossip } } : {}) }];
    }),
    inspections: record.inspections.flatMap((id) => {
      const m = openInspections.get(id);
      return m ? [{ handle: h.inspection.handle(id), label: { ...m.label }, done: m.done }] : [];
    }),
    transcript: s.turns.map((r) => lineOf(c, record, r.n, r.question, r.turn)),
    ...(s.gossip
      ? {
          gossip: {
            every: gossipEvery(c),
            due: gossipDue(c, s),
            rounds: rounds.map((r) => ({
              n: r.n,
              after: r.at,
              state: r.state,
              chosenBy: r.chosenBy,
              talks: r.events.map((e) => ({ from: h.person.handle(e.from), to: h.person.handle(e.to), by: e.by })),
              asked: r.calls,
              requests: r.requests,
              nano: r.costNano,
              unconfirmed: r.unconfirmed,
            })),
          },
        }
      : {}),
    cost: {
      requests: s.turns.reduce((sum, r) => sum + r.turn.requests, 0) + rounds.reduce((sum, r) => sum + r.requests, 0),
      nano: s.turns.reduce((sum, r) => sum + r.turn.costNano, 0) + rounds.reduce((sum, r) => sum + r.costNano, 0),
      unfinished: (record.lost ?? 0) + (interrupted ? 1 : 0) + rounds.filter((r) => r.state === "interrupted").length,
    },
    over: s.verdict !== undefined,
  };
  if (s.verdict) {
    const v = s.verdict;
    view.verdict = {
      accused: h.person.handle(v.accused),
      cited: v.cited.map((id) => h.evidence.handle(id)),
      outcome: v.outcome,
      missing: [...v.missing],
      open: v.open.map((id) => h.person.handle(id)),
      accusedRuledOut: v.accusedRuledOut,
      actions: v.actions,
    };
    const truth = reveal(c, s);
    const assertion = new Map(c.assertions.map((a) => [a.id, a]));
    view.reveal = {
      culprit: h.person.handle(truth.culprit),
      motive: { ...(c.motives.find((m) => m.id === truth.motive)?.text ?? UNKNOWN) },
      timeline: truth.timeline.map((row) => ({ person: h.person.handle(row.suspect), at: c.slots.map((slot) => ({ slot, room: room(row.whereabouts[slot] ?? "") })) })),
      lies: truth.lies.map((lie) => {
        const a = assertion.get(lie.assertion);
        return {
          person: h.person.handle(lie.suspect),
          text: a ? { en: renderAssertion(c, lie.suspect, a, "en"), zh: renderAssertion(c, lie.suspect, a, "zh") } : UNKNOWN,
          heard: lie.heard,
          caught: lie.caught,
        };
      }),
    };
  }
  return view;
}
