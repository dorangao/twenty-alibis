import { playDetective, type DetectiveReply, type DetectiveReport } from "../agents/detective";
import type { Case } from "../case/schema";
import type { Metered } from "../metered";
import type { SkeletonBrief } from "./plot";
import { planTrial, readSaved, replyPath, savedReply, writeAttempt, writeWhole, type Standing, type StoredAttempt, type TrialAttempt, type TrialConfig } from "./trial";
import { rebuildCase, SHUFFLE_VERSION, type WriteReport } from "./write";

/**
 * A pilot: for each attempt, write a case, then let the detective play it.
 *
 * It answers the question the writer's own gates cannot: can an agent that sees only what a
 * player sees solve a generated case? The counts it produces are kept apart, because they
 * mean different things: attempted, accepted by the gates, played, solved.
 *
 * The rules:
 *  - The cap is in the request ids: an attempt's are "<id>:skeleton", "<id>:people" and
 *    "<id>:d1" to "<id>:d<maxTurns>", and the spend store sends an id once, ever.
 *  - Every reply is saved as it arrives, the writer's and the detective's.
 *  - Nothing is trusted because a file says so. A saved case is made again from the two
 *    saved replies, and only if the store shows both were sent and settled. A game's result
 *    is worked out again from the saved detective replies. So the totals of a pilot can be
 *    rebuilt at any time, by any run, from the replies and the store alone.
 *  - A game that has been started is never started again: a game cannot be picked up in the
 *    middle.
 *  - A run that did not send a request writes nothing about it. Two runs at once cannot
 *    send the same request, and the one that lost cannot write over the other's results.
 *  - A run stops at the first request that is refused, fails, or comes back unconfirmed.
 */

export interface PilotConfig extends TrialConfig {
  /** The most turns one detective game may take. The plan counts on exactly this many. */
  maxTurns: number;
}

export type GameStanding =
  /** The detective would play, if there is an accepted case when its turn comes. */
  | { kind: "play"; most: number; saved?: Case }
  | { kind: "closed"; most: 0; why: [en: string, zh: string] };

export interface PilotPlan {
  rows: { attempt: TrialAttempt; writer: Standing; game: GameStanding; most: number }[];
  /** Requests of this pilot whose outcome the store does not know. While there are any, nothing is sent. */
  unresolved: StoredAttempt[];
  /** The most requests a run would send now. */
  most: number;
}

export const gamePath = (config: TrialConfig, id: string) => `${config.dir}/${id}.game.json`;
export const detectivePath = (config: TrialConfig, id: string) => `${config.dir}/${id}.detective.json`;

const briefOf = (config: TrialConfig, attempt: TrialAttempt): SkeletonBrief => ({ theme: attempt.theme, suspects: config.suspects, rooms: config.rooms });
const settled = (stored: readonly StoredAttempt[], id: string) => stored.some((a) => a.attemptId === id && a.state === "settled");

/**
 * The case of an attempt, made again from its two saved replies. It is given only when the
 * store shows both requests were sent and settled, both saved replies are whole and are this
 * attempt's, they carry the same salt and the current reordering rule, the people reply was
 * written against the order that salt gives, and the result passes every gate. Otherwise
 * null with the reason.
 */
export function savedCase(config: TrialConfig, attempt: TrialAttempt, stored: readonly StoredAttempt[]): { ok: true; c: Case } | { ok: false; why: string } {
  for (const stage of ["skeleton", "people"] as const) {
    if (!settled(stored, `${attempt.id}:${stage}`)) return { ok: false, why: `the store has no settled ${stage} request for this attempt` };
  }
  const brief = briefOf(config, attempt);
  const skeleton = savedReply(readSaved(replyPath(config, attempt.id, "skeleton")), attempt.id, "skeleton", brief);
  if (!skeleton.ok) return { ok: false, why: skeleton.why[0] };
  const people = savedReply(readSaved(replyPath(config, attempt.id, "people")), attempt.id, "people", brief);
  if (!people.ok) return { ok: false, why: people.why[0] };
  const salt = skeleton.reply.salt;
  if (typeof salt !== "string" || salt === "" || people.reply.salt !== salt) return { ok: false, why: "the two saved replies do not carry the same salt" };
  if (skeleton.reply.shuffleVersion !== SHUFFLE_VERSION || people.reply.shuffleVersion !== SHUFFLE_VERSION) return { ok: false, why: "the saved replies were written under another reordering rule" };
  const built = rebuildCase({ attemptId: attempt.id, brief, skeleton: skeleton.value, people: people.value, salt });
  // The people reply names people by place. It must have been written against the very order this salt gives.
  if (!built.shown || JSON.stringify(people.reply.shown) !== JSON.stringify(built.shown)) return { ok: false, why: "the saved people reply was not written against this skeleton's order" };
  if (built.failedAt || !built.case) return { ok: false, why: `rebuilt from the saved replies, the case is refused at ${built.failedAt}: ${built.reasons[0] ?? ""}` };
  return { ok: true, c: built.case };
}

export function planPilot(config: PilotConfig, stored: readonly StoredAttempt[]): PilotPlan {
  const mine = stored.filter((a) => config.attempts.some((t) => a.attemptId.startsWith(`${t.id}:`)));
  const writers = planTrial(config, stored);
  const rows = writers.rows.map(({ attempt, standing }) => {
    let game: GameStanding;
    if (mine.some((a) => a.attemptId.startsWith(`${attempt.id}:d`))) game = { kind: "closed", most: 0, why: ["a game was already started for this case", "这个案件已经开过一局"] };
    else if (standing.kind !== "closed") game = { kind: "play", most: config.maxTurns };
    else {
      const saved = savedCase(config, attempt, stored);
      game = saved.ok ? { kind: "play", most: config.maxTurns, saved: saved.c } : { kind: "closed", most: 0, why: [`no case to play: ${saved.why}`, `没有可玩的案件：${saved.why}`] };
    }
    return { attempt, writer: standing, game, most: standing.most + game.most };
  });
  const unresolved = mine.filter((a) => a.state !== "settled");
  return { rows, unresolved, most: unresolved.length > 0 ? 0 : rows.reduce((sum, r) => sum + r.most, 0) };
}

export interface PilotEntry {
  attempt: TrialAttempt;
  /** The writer's report, when the writer ran in this run. */
  writer?: WriteReport;
  /** The detective's report, when a game was played in this run. */
  game?: DetectiveReport;
  ms: number;
}

export interface PilotRun {
  /** What this run did. It is not the state of the pilot: for that, see `pilotTotals`. */
  entries: PilotEntry[];
  stoppedBy?: string;
  blocked: boolean;
}

/** Run what the plan says. The caller has made sure paid requests are authorized; the spend guard refuses them otherwise. */
export async function runPilot(config: PilotConfig, deps: { metered: Metered; stored: readonly StoredAttempt[]; onEntry?: (entry: PilotEntry) => void; now?: () => number }): Promise<PilotRun> {
  const now = deps.now ?? Date.now;
  const plan = planPilot(config, deps.stored);
  if (plan.unresolved.length > 0) return { entries: [], blocked: true };
  const run: PilotRun = { entries: [], blocked: false };
  for (const row of plan.rows) {
    if (row.most === 0) continue;
    const started = now();
    const entry: PilotEntry = { attempt: row.attempt, ms: 0 };
    let c: Case | undefined = row.game.kind === "play" ? row.game.saved : undefined;

    if (row.writer.kind !== "closed") {
      entry.writer = await writeAttempt(config, row.attempt, row.writer, deps.metered);
      if (entry.writer.accepted) c = entry.writer.case;
    }
    const stopped = entry.writer?.problem;
    if (!stopped && c && row.game.kind === "play") {
      const replies: DetectiveReply[] = [];
      const game = await playDetective({
        metered: deps.metered,
        c,
        gameId: row.attempt.id,
        maxTurns: config.maxTurns,
        cacheKey: `case:${row.attempt.id}`,
        // Saved before it is read or acted on: the whole list so far, written whole each turn.
        // Only a reply that arrived gets here, so only the run that sent the request writes.
        onReply: (reply) => {
          replies.push(reply);
          writeWhole(detectivePath(config, row.attempt.id), `${JSON.stringify(replies, null, 2)}\n`);
        },
      });
      entry.game = game;
      // A run whose first detective request was refused has no game to report, and must not
      // write over the report of the run that did play it.
      if (replies.length > 0) {
        writeWhole(
          gamePath(config, row.attempt.id),
          `${JSON.stringify({ outcome: game.outcome, verdict: game.verdict ?? null, problem: game.problem ?? null, turns: game.turns, actions: game.actions, requests: game.requests, costNano: game.costNano, detectiveCostNano: game.detectiveCostNano, suspectCostNano: game.suspectCostNano, steps: game.steps }, null, 2)}\n`,
        );
      }
    }
    entry.ms = now() - started;
    run.entries.push(entry);
    deps.onEntry?.(entry);
    const problem = stopped ?? entry.game?.problem;
    if (problem) {
      run.stoppedBy = problem;
      break;
    }
  }
  return run;
}

/** What one run did, in four counts. A run that only resumed a game shows no attempt: these describe the run, not the pilot. */
export function runCounts(run: PilotRun): { attempted: number; accepted: number; played: number; solved: number } {
  return {
    attempted: run.entries.filter((e) => e.writer && e.writer.requests > 0).length,
    accepted: run.entries.filter((e) => e.writer?.accepted).length,
    // A game counts as played only if it ended without a problem: with a verdict, or by giving up.
    played: run.entries.filter((e) => e.game && e.game.requests > 0 && !e.game.problem).length,
    solved: run.entries.filter((e) => e.game?.outcome === "solved" && !e.game.problem).length,
  };
}

/**
 * The game of an attempt, worked out again from its saved detective replies: the same
 * detective code, fed the saved replies in order instead of a model. Every saved reply must
 * be this game's, in order, settled, and known to the store as settled. The result is what
 * the scorer says now, not what a report file said then.
 */
export async function savedGame(config: PilotConfig, attempt: TrialAttempt, c: Case, stored: readonly StoredAttempt[]): Promise<{ ok: true; game: DetectiveReport } | { ok: false; why: string }> {
  const text = readSaved(detectivePath(config, attempt.id));
  if (text === null) return { ok: false, why: "no detective replies are saved" };
  let replies: DetectiveReply[];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("not a list");
    replies = parsed as DetectiveReply[];
  } catch {
    return { ok: false, why: "the saved detective replies are damaged" };
  }
  for (const [i, reply] of replies.entries()) {
    const id = `${attempt.id}:d${i + 1}`;
    if (reply?.attemptId !== id || reply.turn !== i + 1) return { ok: false, why: `saved detective reply ${i + 1} is not this game's turn ${i + 1}` };
    if (reply.settled !== true || reply.breached !== false || !settled(stored, id)) return { ok: false, why: `the cost of detective reply ${i + 1} is not confirmed` };
  }
  // A game the store knows more turns of than were saved cannot be worked out again.
  if (stored.some((a) => a.attemptId === `${attempt.id}:d${replies.length + 1}`)) return { ok: false, why: "the store knows of a later turn whose reply was not saved" };
  let next = 0;
  const replay: Metered = async (request) => {
    const reply = replies[next];
    if (!reply || request.attemptId !== reply.attemptId) return { ok: false, attemptId: request.attemptId, sent: false, reason: "not-dispatched" };
    next++;
    return { ok: true, attemptId: request.attemptId, response: { text: reply.text, toolCalls: [], ...(reply.usage ? { usage: reply.usage } : {}), ...(reply.finishReason ? { finishReason: reply.finishReason } : {}) }, costNano: 0, settled: true, breached: false };
  };
  const game = await playDetective({ metered: replay, c, gameId: attempt.id, maxTurns: config.maxTurns });
  // Replayed to the end of what was saved, and the game must not have asked for more.
  if (next !== replies.length) return { ok: false, why: "the saved replies do not replay to the end" };
  return { ok: true, game };
}

export interface PilotTotals {
  /** Attempts whose first request the store shows as sent. */
  attempted: number;
  /** Attempts whose case, made again from the saved replies, passes every gate. */
  accepted: number;
  /** Accepted cases with a whole game that ended without a problem. */
  played: number;
  /** Played games in which the scorer, run again, says "solved". */
  solved: number;
  rows: { id: string; attempted: boolean; accepted: boolean; game: DetectiveReport["outcome"] | "not played"; turns: number; note: string }[];
}

/**
 * The state of the pilot, rebuilt from the saved replies and the store's records. It does
 * not depend on which run did what, or on any report file, so it is the same after a
 * restart, after a resumed game, and after a run that sent nothing.
 */
export async function pilotTotals(config: PilotConfig, stored: readonly StoredAttempt[]): Promise<PilotTotals> {
  const rows: PilotTotals["rows"] = [];
  for (const attempt of config.attempts) {
    const attempted = stored.some((a) => a.attemptId === `${attempt.id}:skeleton`);
    const saved = savedCase(config, attempt, stored);
    if (!saved.ok) {
      rows.push({ id: attempt.id, attempted, accepted: false, game: "not played", turns: 0, note: attempted ? saved.why : "" });
      continue;
    }
    const game = await savedGame(config, attempt, saved.c, stored);
    if (!game.ok || game.game.problem) rows.push({ id: attempt.id, attempted, accepted: true, game: "not played", turns: 0, note: game.ok ? `the saved game ended on a problem: ${game.game.problem}` : game.why });
    else rows.push({ id: attempt.id, attempted, accepted: true, game: game.game.outcome, turns: game.game.turns, note: "" });
  }
  return {
    attempted: rows.filter((r) => r.attempted).length,
    accepted: rows.filter((r) => r.accepted).length,
    played: rows.filter((r) => r.game !== "not played").length,
    solved: rows.filter((r) => r.game === "solved").length,
    rows,
  };
}
