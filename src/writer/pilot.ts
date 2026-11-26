import { existsSync, readFileSync } from "node:fs";
import { playDetective, type DetectiveReply, type DetectiveReport } from "../agents/detective";
import { CaseSchema, type Case } from "../case/schema";
import { checkCase } from "../case/solver";
import type { Metered } from "../metered";
import { planTrial, reportPath, writeAttempt, writeWhole, type Standing, type StoredAttempt, type TrialAttempt, type TrialConfig } from "./trial";
import type { WriteReport } from "./write";

/**
 * A pilot: for each attempt, write a case, then let the detective play it.
 *
 * It answers the question the writer's own gates cannot: can an agent that sees only what a
 * player sees solve a generated case? The counts it produces are kept apart, because they
 * mean different things: attempted, accepted by the gates, played, solved.
 *
 * The same rules as the writer trial hold. The cap is in the request ids: an attempt's are
 * "<id>:skeleton", "<id>:people" and "<id>:d1" to "<id>:d<maxTurns>", and the spend store
 * sends an id once, ever. Every reply is saved as it arrives. A game that has been started is
 * never started again, because a game cannot be picked up in the middle. A run stops at the
 * first request that is refused, fails, or comes back unconfirmed.
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

/** An accepted case saved by an earlier run, read back and checked again. Null when there is none to trust. */
function savedCase(config: TrialConfig, id: string): Case | null {
  const path = reportPath(config, id);
  if (!existsSync(path)) return null;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as { accepted?: unknown; problem?: unknown; case?: unknown };
    if (saved.accepted !== true || saved.problem) return null;
    const parsed = CaseSchema.safeParse(saved.case);
    // The file is not taken at its word: the case must be this attempt's and pass the gate again.
    return parsed.success && parsed.data.id === id && checkCase(parsed.data).accepted ? parsed.data : null;
  } catch {
    return null;
  }
}

export function planPilot(config: PilotConfig, stored: readonly StoredAttempt[]): PilotPlan {
  const mine = stored.filter((a) => config.attempts.some((t) => a.attemptId.startsWith(`${t.id}:`)));
  const writers = planTrial(config, stored);
  const rows = writers.rows.map(({ attempt, standing }) => {
    let game: GameStanding;
    if (mine.some((a) => a.attemptId.startsWith(`${attempt.id}:d`))) game = { kind: "closed", most: 0, why: ["a game was already started for this case", "这个案件已经开过一局"] };
    else if (standing.kind !== "closed") game = { kind: "play", most: config.maxTurns };
    else {
      const c = savedCase(config, attempt.id);
      game = c ? { kind: "play", most: config.maxTurns, saved: c } : { kind: "closed", most: 0, why: ["there is no accepted case saved to play", "没有已保存的、通过关卡的案件可玩"] };
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
        onReply: (reply) => {
          replies.push(reply);
          writeWhole(detectivePath(config, row.attempt.id), `${JSON.stringify(replies, null, 2)}\n`);
        },
      });
      entry.game = game;
      writeWhole(
        gamePath(config, row.attempt.id),
        `${JSON.stringify({ outcome: game.outcome, verdict: game.verdict ?? null, problem: game.problem ?? null, turns: game.turns, actions: game.actions, requests: game.requests, costNano: game.costNano, detectiveCostNano: game.detectiveCostNano, suspectCostNano: game.suspectCostNano, steps: game.steps }, null, 2)}\n`,
      );
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

/** The four counts a pilot reports, kept apart. */
export function pilotCounts(run: PilotRun): { attempted: number; accepted: number; played: number; solved: number } {
  return {
    attempted: run.entries.filter((e) => e.writer).length,
    accepted: run.entries.filter((e) => e.writer?.accepted).length,
    // A game counts as played only if it ended without a problem: with a verdict, or by giving up.
    played: run.entries.filter((e) => e.game && !e.game.problem).length,
    solved: run.entries.filter((e) => e.game?.outcome === "solved" && !e.game.problem).length,
  };
}
