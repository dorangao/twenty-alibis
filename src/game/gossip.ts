import { isOpen, type Held } from "../case/access";
import type { Case, Text, Topic } from "../case/schema";

/**
 * Gossip: between the player's actions, suspects talk to each other.
 *
 * The truth is frozen and no suspect's own statement ever changes. Gossip changes one thing:
 * who can repeat whose statement. An event says "A told B what A says when asked T", where T
 * is one of A's own topics. After it, B can be asked "What did A tell you?", and answers with
 * A's statement, attributed to A.
 *
 * What keeps this fair:
 *  - One hop. A suspect passes on its own statements, never something it heard.
 *  - Only what is open. A may tell a topic only if that topic is open to the player at the
 *    moment of the round, by the same rule the solver and the topic menu use. So hearsay
 *    never carries a statement the player could not have had, for one action, right then.
 *  - A statement is not evidence, heard at first or second hand. Scoring is untouched.
 *
 * So gossip only adds ways to reach statements that were already reachable. Any proof the
 * solver found for the case still works with gossip on.
 *
 * Who speaks, about what, and to whom they might speak is decided here, by code, from the
 * case and the session alone. The one thing left open is which of the candidates a speaker
 * picks. With the model on, the speaker's agent picks; with it off, code takes the first.
 */

/** A round is due each time this many more actions have been used. */
export const GOSSIP_EVERY = 4;
/** The same, in a case too short to reach that: one with fewer than eight topics and inspections of its own. */
export const GOSSIP_EVERY_SHORT = 2;
/** The most rounds one session has. */
export const GOSSIP_ROUNDS = 3;
/** The most suspects who speak in one round. */
export const GOSSIP_SPEAKERS = 8;
/** The most requests in flight at once. Each holds a full worst case in the spend guard. */
export const GOSSIP_WAVE = 4;
/** The most people a speaker chooses between. */
export const GOSSIP_CANDIDATES = 4;

export interface GossipEvent {
  /** Who spoke. */
  from: string;
  /** Who heard it. */
  to: string;
  /** Which of the speaker's own topics was passed on: everything the speaker states on it, as one bundle. */
  topic: string;
  /** Who picked the listener: the speaker's agent, or code. */
  by: "code" | "model";
}

export interface GossipRound {
  /** 1 for the first round. */
  n: number;
  /** Actions used when the round ran. */
  at: number;
  events: GossipEvent[];
  /**
   * Who was to pick the listeners. "code": the session has the model off, and code picked
   * every one. "model": each speaker's agent was to pick, except where there was one candidate.
   */
  chosenBy: "code" | "model";
  /** Suspects who had something to tell and someone to tell it to. */
  speakers: number;
  /** Of those, how many were to ask the model. A speaker with one candidate is not asked. */
  calls: number;
  /** Requests that left this machine. */
  requests: number;
  /** Of those, the ones whose cost is not confirmed: they failed on the way, or came back unsettled. Their holds stay with the spend guard. */
  unconfirmed: number;
  /** Choices that were refused before anything was sent. Nothing was charged for them. */
  refused: number;
  /** The confirmed cost of the requests that came back. */
  costNano: number;
  /** Set when a request was refused, failed, or came back with its cost unconfirmed. No further wave was sent after it. */
  problem?: string;
  /**
   * True while the round's requests are out. A round is written down like this before its
   * first request, so a server that is lost in the middle leaves the game with the round
   * closed and empty, and its requests are never sent again. What such a round sent, if
   * anything, is not known here: only the spend guard's own count says.
   */
  pending?: true;
}

export interface GossipState {
  rounds: GossipRound[];
}

/** What one speaker is to do in a round: one statement, and the people it may go to. */
export interface GossipPlan {
  speaker: string;
  /** The speaker's place in the case's list of suspects. It names the speaker's request and the hearsay topic. */
  index: number;
  topic: string;
  /** People who have not heard this from the speaker, in the order they are offered. Never empty. */
  candidates: string[];
}

/**
 * How this case's hearsay topics begin: "~g", or that with more "~" in front, as many as it
 * takes for no topic of the case's own to begin the same way. A case may name its topics
 * anything, so the game picks a name the case has left free.
 */
export function hearsayPrefix(c: Case): string {
  let prefix = "~g";
  while (c.actions.topics.some((t) => t.id.startsWith(prefix))) prefix = `~${prefix}`;
  return prefix;
}

/** The id of the topic "what did the speaker tell you in round n". */
export const hearsayId = (c: Case, round: number, speakerIndex: number): string => `${hearsayPrefix(c)}${round}-${speakerIndex}`;

const HEARSAY_REST = /^([1-9]\d?)-(0|[1-9]\d{0,3})$/;

/** The event a hearsay topic id stands for, if there is one in this session. */
export function hearsayEvent(c: Case, state: GossipState | undefined, id: string): { round: number; event: GossipEvent; topic: Topic } | null {
  if (!state) return null;
  const prefix = hearsayPrefix(c);
  const match = id.startsWith(prefix) ? HEARSAY_REST.exec(id.slice(prefix.length)) : null;
  if (!match) return null;
  const round = Number(match[1]);
  const speaker = c.suspects[Number(match[2])];
  const event = speaker ? state.rounds.find((r) => r.n === round)?.events.find((e) => e.from === speaker.id) : undefined;
  const topic = event ? c.actions.topics.find((t) => t.id === event.topic && t.suspect === event.from) : undefined;
  return event && topic ? { round, event, topic } : null;
}

/** The hearsay topics a suspect can be asked now: one for each thing it has been told. */
export function hearsayTopics(c: Case, state: GossipState | undefined, suspect: string): { id: string; label: Text; round: number; from: string }[] {
  if (!state) return [];
  const out: { id: string; label: Text; round: number; from: string }[] = [];
  for (const round of state.rounds) {
    for (const event of round.events) {
      if (event.to !== suspect) continue;
      const index = c.suspects.findIndex((s) => s.id === event.from);
      const speaker = c.suspects[index];
      if (!speaker) continue;
      out.push({ id: hearsayId(c, round.n, index), label: { en: `What did ${speaker.name.en} tell you?`, zh: `${speaker.name.zh}跟你说了什么？` }, round: round.n, from: event.from });
    }
  }
  return out;
}

/** How many actions lie between two rounds in this case. */
export function gossipEvery(c: Case): number {
  return c.actions.topics.length + c.actions.inspections.length < 2 * GOSSIP_EVERY ? GOSSIP_EVERY_SHORT : GOSSIP_EVERY;
}

/**
 * True when a round should run before the player's next new action. Never after the
 * accusation, and never when no action is left to use what it would bring.
 */
export function roundDue(c: Case, session: { actions: number; gossip?: GossipState; verdict?: unknown }): boolean {
  const state = session.gossip;
  if (!state || session.verdict !== undefined) return false;
  if (state.rounds.length >= GOSSIP_ROUNDS) return false;
  if (session.actions >= c.sessionCap) return false;
  return session.actions >= gossipEvery(c) * (state.rounds.length + 1);
}

/**
 * Who speaks in round `n`, what each passes on, and to whom it may go.
 *
 * Speakers are taken in the case's order, starting where the round before would have stopped,
 * so over the rounds everyone gets a turn. A suspect speaks if one of its own topics is open
 * to the player, states something, and at least one other suspect has not heard it from them.
 * Of such topics it passes on the one fewest have heard, the earlier one on a tie. The candidates are the
 * people who have not heard it, in an order that turns with the round and the speaker.
 */
export function planRound(c: Case, state: GossipState, held: Held, n: number): GossipPlan[] {
  const people = c.suspects;
  const told = new Map<string, Set<string>>();
  for (const round of state.rounds) {
    for (const e of round.events) {
      const key = `${e.from}\u0000${e.topic}`;
      if (!told.has(key)) told.set(key, new Set());
      told.get(key)!.add(e.to);
    }
  }
  const plans: GossipPlan[] = [];
  const start = ((n - 1) * GOSSIP_SPEAKERS) % people.length;
  for (let step = 0; step < people.length && plans.length < GOSSIP_SPEAKERS; step++) {
    const index = (start + step) % people.length;
    const speaker = people[index]!;
    let best: { topic: string; heard: number; fresh: string[] } | null = null;
    for (const topic of c.actions.topics) {
      if (topic.suspect !== speaker.id || topic.yields.length === 0 || !isOpen(topic, held)) continue;
      const heard = told.get(`${speaker.id}\u0000${topic.id}`) ?? new Set<string>();
      const fresh = people.filter((p) => p.id !== speaker.id && !heard.has(p.id)).map((p) => p.id);
      if (fresh.length === 0) continue;
      if (!best || heard.size < best.heard) best = { topic: topic.id, heard: heard.size, fresh };
    }
    if (!best) continue;
    const turn = (n + index) % best.fresh.length;
    const candidates = [...best.fresh.slice(turn), ...best.fresh.slice(0, turn)].slice(0, GOSSIP_CANDIDATES);
    plans.push({ speaker: speaker.id, index, topic: best.topic, candidates });
  }
  return plans;
}

/** The round as it is written down before any request is sent: closed, empty, and marked pending. */
export function pendingRound(n: number, at: number, plans: readonly GossipPlan[]): GossipRound {
  return { n, at, events: [], chosenBy: "model", speakers: plans.length, calls: plans.filter((p) => p.candidates.length > 1).length, requests: 0, unconfirmed: 0, refused: 0, costNano: 0, pending: true };
}
