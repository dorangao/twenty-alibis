import { playDetective, type DetectiveReply, type Move } from "../agents/detective";
import type { Case, Text } from "../case/schema";
import { solve } from "../case/solver";
import { accuse, ask, inspect, SessionError, startSession, type Session } from "../game/session";
import type { Metered } from "../metered";
import { costNano, MODEL } from "../spend/pricing";
import { caseVersion } from "./api";
import type { SessionRecord } from "./sessions";
import { handlesOf, viewOf, withHandles, type View } from "./view";

/**
 * A replay: a solved game, written down as the page would have seen it.
 *
 * It is a list of frames. The first is the opening view; each one after it is the view after
 * one move, with a word on what the move was. The views are made by the same function that
 * makes them for a live game (`viewOf`), so a replay holds exactly what a player would have
 * been shown at each step, under the page's own handles, and nothing a player would not have
 * been shown: no culprit, no locked topic, no evidence not yet held, until the last frame,
 * which is the accusation with its verdict and reveal.
 *
 * A replay is a public file. It gives away its case's answer in its last frame, by design.
 * It is only made of a game the scorer calls solved, and the verdict in it is what the
 * scorer says when the replay is made, not what a report said earlier.
 *
 * Playing it back takes no server: no session, no model, no request. The moves are played
 * here, once, with the model off, so every statement in it is worded by code.
 */
export const REPLAY_VERSION = 1;

/** Who chose the moves. */
export type ReplayPlayer =
  /** The case's own solver: the proof it found when it checked the case. No model was involved. */
  | { kind: "solver" }
  /**
   * The detective agent: the model chose every move. `turns` is how many replies it gave,
   * `unused` how many of them could not be used, `costNano` their cost as billed.
   */
  | { kind: "detective"; model: string; turns: number; unused: number; requests: number; costNano: number };

/** A move as the page names it: by handles, with the words the player would have clicked. */
export type ReplayMove =
  | { kind: "ask"; person: string; topic: string; label: Text }
  | { kind: "inspect"; inspection: string; label: Text }
  | { kind: "accuse"; person: string; evidence: string[] };

export interface ReplayFrame {
  /** The move that led here. The first frame has none. */
  move?: ReplayMove;
  view: View;
}

export interface Replay {
  version: typeof REPLAY_VERSION;
  /** The replay's own name: letters, digits and hyphens. */
  id: string;
  title: Text;
  setting: Text;
  suspects: number;
  /** Moves made, the accusation not counted: what the game calls actions. */
  actions: number;
  player: ReplayPlayer;
  frames: ReplayFrame[];
}

/** A replay as a list shows it. */
export interface ReplayCard {
  id: string;
  title: Text;
  setting: Text;
  suspects: number;
  actions: number;
  player: ReplayPlayer;
}

export interface ReplayIndex {
  version: typeof REPLAY_VERSION;
  replays: ReplayCard[];
}

export type ReplayRefusal =
  /** The id is not a plain name. */
  | "bad-id"
  /** A move could not be made: it names something that is not open, or comes after the accusation. */
  | "illegal-move"
  /** The moves do not end in an accusation. */
  | "no-accusation"
  /** They do, and the scorer does not call it solved. */
  | "not-solved"
  /** The case has no proof to follow. */
  | "no-proof"
  /** The saved replies are not one game's, in order, with their cost confirmed. */
  | "bad-replies";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const refuse: Metered = async (request) => ({ ok: false, attemptId: request.attemptId, sent: false, reason: "kill-switch" });

export const cardOf = (replay: Replay): ReplayCard => ({ id: replay.id, title: replay.title, setting: replay.setting, suspects: replay.suspects, actions: replay.actions, player: replay.player });

/**
 * Play `moves` on `c` with the model off and write down the view after each. The moves must
 * be legal in order, end with an accusation, and the scorer must call it solved.
 */
export async function makeReplay(c: Case, moves: readonly Move[], meta: { id: string; player: ReplayPlayer }): Promise<{ ok: true; replay: Replay } | { ok: false; why: ReplayRefusal }> {
  if (!ID.test(meta.id) || meta.id.length > 60) return { ok: false, why: "bad-id" };
  // The session's name is in every view. It is the replay's name: no live session is called this.
  let record: SessionRecord = withHandles(c, { session: startSession(c, `replay-${meta.id}`), owner: "", revision: 1, mode: "off", caseVersion: caseVersion(c), topics: [], inspections: [], createdAt: 0 });
  const frames: ReplayFrame[] = [{ view: viewOf(c, record, "off") }];

  for (const move of moves) {
    // Nothing comes after the accusation: the game itself refuses any move once it is over.
    // The handles the player would have used are the ones on the view before the move.
    const h = handlesOf(c, record);
    let next: Session;
    let shown: ReplayMove;
    try {
      if (move.type === "ask") {
        const topic = c.actions.topics.find((t) => t.id === move.topic);
        if (!topic) return { ok: false, why: "illegal-move" };
        const asked = await ask(refuse, c, record.session, { suspect: topic.suspect, topic: topic.id, language: "en" });
        // A topic heard before gives its saved answer and uses nothing: that is not a move.
        if (asked.replayed || !asked.recorded) return { ok: false, why: "illegal-move" };
        next = asked.session;
        shown = { kind: "ask", person: h.person.handle(topic.suspect), topic: h.topic.handle(topic.id), label: topic.label };
      } else if (move.type === "inspect") {
        const inspection = c.actions.inspections.find((i) => i.id === move.inspection);
        if (!inspection) return { ok: false, why: "illegal-move" };
        const done = inspect(c, record.session, inspection.id);
        if (done.repeated) return { ok: false, why: "illegal-move" };
        next = done.session;
        shown = { kind: "inspect", inspection: h.inspection.handle(inspection.id), label: inspection.label };
      } else {
        next = accuse(c, record.session, { suspect: move.suspect, evidence: move.evidence }).session;
        shown = { kind: "accuse", person: h.person.handle(move.suspect), evidence: move.evidence.map((id) => h.evidence.handle(id)) };
      }
    } catch (error) {
      if (error instanceof SessionError) return { ok: false, why: "illegal-move" };
      throw error;
    }
    record = withHandles(c, { ...record, session: next, revision: record.revision + 1 });
    frames.push({ move: shown, view: viewOf(c, record, "off") });
  }

  const verdict = record.session.verdict;
  if (!verdict) return { ok: false, why: "no-accusation" };
  if (verdict.outcome !== "solved") return { ok: false, why: "not-solved" };
  return { ok: true, replay: { version: REPLAY_VERSION, id: meta.id, title: c.title, setting: c.setting, suspects: c.suspects.length, actions: record.session.actions, player: meta.player, frames } };
}

/** The moves of the proof the solver found for this case, ending with the accusation it supports. */
export async function solverMoves(c: Case): Promise<{ ok: true; moves: Move[] } | { ok: false; why: "no-proof" }> {
  const proof = solve(c).proof;
  if (!proof) return { ok: false, why: "no-proof" };
  const moves: Move[] = proof.actions.map((a) => (a.type === "inspection" ? { type: "inspect", inspection: a.id } : { type: "ask", topic: a.id }));
  // What a player holds at the end of those moves, in the order it was gained: all of it is cited.
  let s = startSession(c, "proof");
  for (const move of moves) {
    if (move.type === "ask") s = (await ask(refuse, c, s, { suspect: c.actions.topics.find((t) => t.id === move.topic)!.suspect, topic: move.topic, language: "en" })).session;
    else if (move.type === "inspect") s = inspect(c, s, move.inspection).session;
  }
  return { ok: true, moves: [...moves, { type: "accuse", suspect: c.culprit.suspect, evidence: [...s.evidence] }] };
}

/**
 * The moves of a detective's game, from its saved replies: the detective's own code is run
 * again with those replies in place of a model, and what it does with them is read off.
 * Nothing is sent. Every reply must be this game's, in order, with its cost confirmed.
 */
export async function detectiveMoves(c: Case, replies: readonly DetectiveReply[]): Promise<{ ok: true; moves: Move[]; player: ReplayPlayer } | { ok: false; why: "bad-replies" }> {
  const first = replies[0];
  const gameId = typeof first?.attemptId === "string" && first.attemptId.endsWith(":d1") ? first.attemptId.slice(0, -":d1".length) : null;
  if (gameId === null || gameId === "") return { ok: false, why: "bad-replies" };
  let cost = 0;
  for (const [i, reply] of replies.entries()) {
    if (reply?.attemptId !== `${gameId}:d${i + 1}` || reply.turn !== i + 1 || reply.settled !== true || reply.breached !== false || !reply.usage) return { ok: false, why: "bad-replies" };
    try {
      cost += costNano(reply.usage);
    } catch {
      return { ok: false, why: "bad-replies" };
    }
  }
  let next = 0;
  const saved: Metered = async (request) => {
    const reply = replies[next];
    if (!reply || request.attemptId !== reply.attemptId) return { ok: false, attemptId: request.attemptId, sent: false, reason: "not-dispatched" };
    next++;
    return { ok: true, attemptId: request.attemptId, response: { text: reply.text, toolCalls: [], usage: reply.usage!, ...(reply.finishReason ? { finishReason: reply.finishReason } : {}) }, costNano: 0, settled: true, breached: false };
  };
  // As many turns as were saved, and no more: the game must end within them.
  const game = await playDetective({ metered: saved, c, gameId, maxTurns: replies.length });
  if (next !== replies.length) return { ok: false, why: "bad-replies" };
  const moves = game.steps.flatMap((step) => (step.used && step.move ? [step.move] : []));
  return { ok: true, moves, player: { kind: "detective", model: MODEL, turns: replies.length, unused: replies.length - moves.length, requests: replies.length, costNano: cost } };
}
