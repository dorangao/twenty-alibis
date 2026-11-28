import { GOSSIP_OUTPUT_TOKENS, gossipMessages } from "../agents/gossip-turn";
import { isOpen } from "../case/access";
import type { Case } from "../case/schema";
import { GOSSIP_ROUNDS, GOSSIP_WAVE, planRound, type GossipPlan } from "../game/gossip";
import { ask, gossipDue, gossipRound, heldBy, inspect, startSession, type Session } from "../game/session";
import type { Metered, MeteredResult } from "../metered";
import { parseRunArgs } from "../run-args";
import { LOW_TIER, absoluteWorstNano, nanoToUsd, usdToNano } from "../spend/pricing";
import type { RunLock } from "../spend/run-lock";
import type { EnvelopeTotals } from "../spend/store";
import { asOnlyRunner, readStored, type StoredAttempt, type StoredSource } from "../writer/trial";

/**
 * A paid trial of gossip: a few rounds in which each speaker's agent picks whom to tell.
 *
 * The game around the rounds costs nothing. A walker uses the player's actions with the model
 * off (the first open topic not yet asked, else the first open inspection), so the only
 * requests are the speakers' choices, sent by the same `gossipRound` the game uses.
 *
 * What a request will be billed is not known before it is sent: the API takes a limit on
 * output and none on billed input. So the trial keeps two figures apart and never calls the
 * first one a limit on the bill:
 *  - An estimate of each request (`choiceCeilingNano`), and a STOP set against it: before
 *    every send, what the trial has confirmed plus the estimate of each request in flight
 *    must fit under the stop, and once any request has cost more than its estimate nothing
 *    more is sent. This keeps an ordinary run small. It does not bound a bill.
 *  - The spend guard's own hold for a request (a full context window at the higher price,
 *    plus the output limit), and a BOUND set against it: before every send, what the trial
 *    has confirmed plus a full hold for each of its requests in flight or unresolved, this
 *    one included, must fit under the bound. This is the most the trial can be charged,
 *    for as long as the guard's own hold is.
 * Both are given by the operator at run time. Neither has a default, and none is in the
 * repository.
 *
 * What else bounds it:
 *  - The ids. A request is "<trial id>:g<round>:<speaker's place in the case>". Which
 *    speakers a round has depends on the case and the walker alone, never on what a model
 *    replied, so the whole list is known before anything is sent, the spend store sends an
 *    id once, ever, and an id that is not on the list is refused here.
 *  - One run, ever. If the store holds any request of this trial, nothing is sent: a trial
 *    that stopped half way is read from its saved report, not picked up again.
 *  - It stops after the first round in which a request was refused, failed or came back with
 *    its cost unconfirmed.
 */
export interface GossipTrialConfig {
  /** Names the trial and begins every request id. */
  id: string;
  /** How many rounds to run: at most the game's own limit. */
  rounds: number;
}

export interface GossipTrialLimits {
  /** The stop: confirmed spend plus the trial's estimate of every request in flight may not pass it. Not a limit on the bill. */
  stopNano: number;
  /** The bound: confirmed spend plus the spend guard's full hold for every request in flight or unresolved may not pass it. */
  boundNano: number;
}

/** What the spend guard holds for one of this trial's requests when it spends money. */
export const CHOICE_HOLD_NANO = absoluteWorstNano(GOSSIP_OUTPUT_TOKENS);

export const TRIAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Refuse a config this cannot run, before anything is connected. */
export function checkTrial(config: GossipTrialConfig): void {
  if (!TRIAL_ID.test(config.id)) throw new Error(`a trial id is lower-case words joined by hyphens, not "${config.id}"`);
  if (!Number.isInteger(config.rounds) || config.rounds < 1 || config.rounds > GOSSIP_ROUNDS) throw new Error(`a trial runs 1 to ${GOSSIP_ROUNDS} rounds`);
}

export function checkLimits(limits: GossipTrialLimits): void {
  for (const [name, value] of [["stop", limits.stopNano], ["bound", limits.boundNano]] as const) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`the ${name} must be a positive whole number of nano-dollars`);
  }
}

/** The names the operator gives the two limits under. */
export const STOP_ENV = "GOSSIP_TRIAL_STOP_USD";
export const BOUND_ENV = "GOSSIP_TRIAL_BOUND_USD";
/** Plain dollars: digits, and at most nine after the point. No sign, no exponent, nothing a number parser would be generous about. */
const DOLLARS = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,9})?$/;

/**
 * The operator's two limits, read from the environment. `null` when neither is set: a plan
 * can still be said, a run cannot start. A value that is there and cannot be read, or one
 * limit without the other, is an error whatever was asked for.
 */
export function readLimits(env: Record<string, string | undefined>): { ok: true; limits: GossipTrialLimits | null } | { ok: false; why: [en: string, zh: string] } {
  const [stop, bound] = [env[STOP_ENV], env[BOUND_ENV]];
  if (stop === undefined && bound === undefined) return { ok: true, limits: null };
  for (const [name, value] of [[STOP_ENV, stop], [BOUND_ENV, bound]] as const) {
    if (value === undefined) return { ok: false, why: [`${name} is not set, and the other limit is`, `${name} 没有设置，而另一个限额已设置`] };
    if (!DOLLARS.test(value) || usdToNano(Number(value)) <= 0) return { ok: false, why: [`${name} must be a plain positive amount in dollars`, `${name} 必须是一个正的美元金额，写成普通小数`] };
  }
  return { ok: true, limits: { stopNano: usdToNano(Number(stop)), boundNano: usdToNano(Number(bound)) } };
}

/** The model switched off: the walker's questions are worded by code and nothing is sent. */
const off: Metered = async (request) => ({ ok: false, attemptId: request.attemptId, sent: false, reason: "kill-switch" });
/** A model that must not be reached: used where code picks every listener. */
const never: Metered = async () => {
  throw new Error("the plan of a gossip trial made a request");
};

/** Use the player's actions, at no cost, until a round is due or nothing new is left to do. */
export async function walk(c: Case, session: Session): Promise<Session> {
  let s = session;
  while (!gossipDue(c, s) && s.actions < c.sessionCap) {
    const held = heldBy(s);
    const topic = c.actions.topics.find((t) => isOpen(t, held) && !s.turns.some((r) => r.turn.suspect === t.suspect && r.turn.topic === t.id));
    if (topic) {
      const asked = await ask(off, c, s, { suspect: topic.suspect, topic: topic.id, language: "en" });
      if (!asked.recorded) throw new Error(`the walker's question to ${topic.suspect} was not kept`);
      s = asked.session;
      continue;
    }
    const look = c.actions.inspections.find((i) => isOpen(i, held) && !s.inspections.includes(i.id));
    if (!look) break;
    s = inspect(c, s, look.id).session;
  }
  return s;
}

/** Tokens allowed for the parts of a request body that are not its messages: the schema, the settings, the chat format. */
const BODY_ALLOWANCE_TOKENS = 1_000;

/**
 * The trial's estimate of one choice, made generous: every byte of its messages taken as a
 * whole token, an allowance for the rest of the body, and the whole output limit, at the
 * lower price. It is an estimate and not a bound: nothing in the API promises that billed
 * input stays under it. The stop adds these up, and a request that costs more than its own
 * ends the trial. What a request can cost at most is `CHOICE_HOLD_NANO`.
 */
export function choiceCeilingNano(c: Case, plan: GossipPlan): number {
  const bytes = Buffer.byteLength(JSON.stringify(gossipMessages(c, plan).messages), "utf8");
  return (bytes + BODY_ALLOWANCE_TOKENS) * LOW_TIER.input + GOSSIP_OUTPUT_TOKENS * LOW_TIER.output;
}

const idOf = (config: GossipTrialConfig, round: number, plan: GossipPlan): string => `${config.id}:g${round}:${plan.index}`;
/** The speakers of a round who are to ask the model: those with someone to choose between. */
const callers = (c: Case, session: Session, n: number): GossipPlan[] => planRound(c, session.gossip!, heldBy(session), n).filter((p) => p.candidates.length > 1);

export interface PlannedRound {
  n: number;
  /** Actions used when the round runs. */
  at: number;
  ids: string[];
  /** The trial's estimate of the round, with the candidates code would offer after code's own picks. A run estimates again with the real ones. */
  ceilingNano: number;
}

export interface GossipTrialPlan {
  rounds: PlannedRound[];
  /** Every request id this trial can ever send. */
  ids: string[];
  /** The trial's estimate of all of it. Not a bound. */
  ceilingNano: number;
  /** The most the spend guard holds for this trial at one moment: a full hold for each request of the largest wave. */
  heldAtOnceNano: number;
  /**
   * With limits given: the first round they would not let start if every request before it
   * cost its whole estimate, and which of the two refuses it. For round 1 this is exact,
   * since nothing has been spent yet. For a later round it is a forecast only: a run counts
   * what the earlier rounds really cost, which is usually less, and may go further.
   */
  refused: { round: number; by: "stop" | "bound" } | null;
  /** The most requests a run can send: every id, or none when the limits do not let round 1 start. This one is binding. */
  most: number;
  /** How many requests go out if every one costs its whole estimate. A forecast, never more than `most`. */
  forecast: number;
}

/** What the two limits count while a trial runs. */
export interface TrialCount {
  /** Costs the store has confirmed. */
  confirmed: number;
  /** Requests out now, and what the trial estimated for them. */
  flying: number;
  flyingEstimate: number;
  /** Requests that were sent and have no confirmed cost. Each keeps a full hold. */
  unresolved: number;
  /** The first request that cost more than its estimate, if one did. */
  over: string | null;
}

export type TrialRefusal = "trial-unplanned" | "trial-over-estimate" | "trial-bound" | "trial-stop";

/**
 * The trial's own admission of one request, asked at every physical send before the spend
 * guard is. `estimate` is the trial's estimate of this request, or undefined for an id that
 * is not in the round's plan: such a request is never sent.
 */
export function refusalFor(count: TrialCount, limits: GossipTrialLimits, estimate: number | undefined): TrialRefusal | null {
  if (estimate === undefined) return "trial-unplanned";
  if (count.over !== null) return "trial-over-estimate";
  if (count.confirmed + (count.flying + count.unresolved + 1) * CHOICE_HOLD_NANO > limits.boundNano) return "trial-bound";
  if (count.confirmed + count.flyingEstimate + estimate > limits.stopNano) return "trial-stop";
  return null;
}

/**
 * Whether a round may start. Under the bound: a wave of full holds must still fit when the
 * round's earlier waves have cost their whole estimate, so that a round which starts is not
 * cut short by its own ordinary spending. Under the stop: every request of it, by estimate.
 */
function roundFits(limits: GossipTrialLimits, confirmed: number, unresolved: number, calls: number, ceilingNano: number): "stop" | "bound" | null {
  if (confirmed + ceilingNano + (unresolved + Math.min(GOSSIP_WAVE, calls)) * CHOICE_HOLD_NANO > limits.boundNano) return "bound";
  if (confirmed + ceilingNano > limits.stopNano) return "stop";
  return null;
}

/**
 * What the trial would send, worked out with no model: the walker plays, and code picks every
 * listener. The ids are exact. The ceilings are close: in a real run the candidates of later
 * rounds depend on whom the agents told before.
 */
export async function planGossipTrial(c: Case, config: GossipTrialConfig, limits: GossipTrialLimits | null = null): Promise<GossipTrialPlan> {
  checkTrial(config);
  if (limits) checkLimits(limits);
  const rounds: PlannedRound[] = [];
  let s = startSession(c, config.id, { gossip: true });
  for (let n = 1; n <= config.rounds; n++) {
    s = await walk(c, s);
    if (!gossipDue(c, s)) break;
    const plans = callers(c, s, n);
    rounds.push({ n, at: s.actions, ids: plans.map((p) => idOf(config, n, p)), ceilingNano: plans.reduce((sum, p) => sum + choiceCeilingNano(c, p), 0) });
    s = (await gossipRound(never, c, s, { model: false })).session;
  }
  let total = 0;
  let refused: GossipTrialPlan["refused"] = null;
  for (const round of rounds) {
    const by: "stop" | "bound" | null = limits && !refused ? roundFits(limits, total, 0, round.ids.length, round.ceilingNano) : null;
    if (by) refused = { round: round.n, by };
    total += round.ceilingNano;
  }
  const widest = Math.min(GOSSIP_WAVE, Math.max(0, ...rounds.map((r) => r.ids.length)));
  const ids = rounds.flatMap((r) => r.ids);
  const stoppedAt = refused?.round;
  const forecast = rounds.filter((r) => stoppedAt === undefined || r.n < stoppedAt).reduce((sum, r) => sum + r.ids.length, 0);
  return { rounds, ids, ceilingNano: total, heldAtOnceNano: widest * CHOICE_HOLD_NANO, refused, most: stoppedAt === 1 ? 0 : ids.length, forecast };
}

/**
 * What happened to one request.
 *   picked       sent, cost confirmed, and the reply named one of the candidates
 *   unusable     sent and confirmed, but the reply picked nobody: cut off, or not one of the letters
 *   unconfirmed  sent and priced, but the store did not confirm the cost, or the envelope was suspended
 *   failed       sent, outcome unknown: its full hold stays charged
 *   refused      not sent: by the spend guard, or by the trial's own stop or bound (`reason` says which)
 */
export type ChoiceOutcome = "picked" | "unusable" | "unconfirmed" | "failed" | "refused";

export interface ChoiceRow {
  id: string;
  round: number;
  speaker: string;
  /** The people offered, in the order of their letters. */
  candidates: string[];
  outcome: ChoiceOutcome;
  /** Who was picked, and the place they held in the list (0 for "a"). */
  to?: string;
  place?: number;
  /** Why nothing was sent, for a refusal: the spend guard's reason, or "trial-stop", "trial-bound", "trial-over-estimate", "trial-unplanned". */
  reason?: string;
  /** The trial's estimate of this request. */
  ceilingNano: number;
  ms: number;
  input?: number;
  cached?: number;
  output?: number;
  reasoning?: number;
  finish?: string;
  /** The confirmed cost. Zero when nothing was confirmed. */
  costNano: number;
}

export interface RoundRow {
  n: number;
  at: number;
  /** Wall-clock time of the whole round: its waves, one after another. */
  ms: number;
  speakers: number;
  calls: number;
  requests: number;
  /** Who told whom, and who picked. What was said is the speaker's own topic, in `topic`. */
  events: { from: string; to: string; topic: string; by: "code" | "model" }[];
  unconfirmed: number;
  refused: number;
  costNano: number;
  ceilingNano: number;
  problem?: string;
}

export interface GossipTrialReport {
  id: string;
  caseId: string;
  limits: GossipTrialLimits;
  rounds: RoundRow[];
  choices: ChoiceRow[];
  /** Requests that were sent and whose cost is not confirmed. Each keeps a full hold with the spend guard. */
  unresolved: number;
  /** What those holds add up to: money the envelope must count as spent until someone settles them, not a charge that was seen. */
  unresolvedHoldNano: number;
  /** Why the trial ended before its last round, when it did. */
  stoppedBy?: string;
  /** True when every planned round ran and none had a problem. */
  complete: boolean;
}

export type GossipTrialRun =
  /** Another run holds the lease. Nothing was sent. */
  | { kind: "locked" }
  /** The store already holds requests of this trial. Nothing was sent. */
  | { kind: "closed"; held: StoredAttempt[] }
  | { kind: "ran"; report: GossipTrialReport };

export interface GossipTrialDeps {
  metered: Metered;
  lock: RunLock;
  /** The store's records, read once this run holds the lease. */
  stored: StoredSource;
  /** Called with the report as it stands after each round, so that a run that dies leaves what it learned. */
  save?: (report: GossipTrialReport) => void;
  now?: () => number;
}

/** The store's records that belong to this trial. */
export const heldByTrial = (config: GossipTrialConfig, stored: readonly StoredAttempt[]): StoredAttempt[] => stored.filter((a) => a.attemptId.startsWith(`${config.id}:`));

export async function runGossipTrial(c: Case, config: GossipTrialConfig, limits: GossipTrialLimits, deps: GossipTrialDeps): Promise<GossipTrialRun> {
  checkTrial(config);
  checkLimits(limits);
  const now = deps.now ?? Date.now;
  let closed: StoredAttempt[] = [];
  const admitted = await asOnlyRunner(deps.lock, deps.metered, async (metered): Promise<GossipTrialReport | null> => {
    closed = heldByTrial(config, await readStored(deps.stored));
    if (closed.length > 0) return null;
    const report: GossipTrialReport = { id: config.id, caseId: c.id, limits: { ...limits }, rounds: [], choices: [], unresolved: 0, unresolvedHoldNano: 0, complete: false };
    let s = startSession(c, config.id, { gossip: true });
    // What the two limits count. All of it is changed without an await in between, so four requests admitted together each see the ones before.
    const count: TrialCount & { refusal: TrialRefusal | null } = { confirmed: 0, flying: 0, flyingEstimate: 0, unresolved: 0, over: null, refusal: null };
    for (let n = 1; n <= config.rounds; n++) {
      s = await walk(c, s);
      if (!gossipDue(c, s)) {
        report.stoppedBy = `no round was due after ${s.actions} action(s)`;
        break;
      }
      const plans = callers(c, s, n);
      const estimates = new Map(plans.map((p) => [idOf(config, n, p), choiceCeilingNano(c, p)]));
      const ceilingNano = [...estimates.values()].reduce((sum, x) => sum + x, 0);
      const refusedBy = roundFits(limits, count.confirmed, count.unresolved, plans.length, ceilingNano);
      if (refusedBy === "bound") {
        report.stoppedBy = `round ${n} was not started: with $${nanoToUsd(count.confirmed).toFixed(6)} confirmed and its estimate of $${nanoToUsd(ceilingNano).toFixed(6)}, a wave of ${Math.min(GOSSIP_WAVE, plans.length)} request(s) holding $${nanoToUsd(CHOICE_HOLD_NANO).toFixed(6)} each passes the bound`;
        break;
      }
      if (refusedBy === "stop") {
        report.stoppedBy = `round ${n} was not started: with $${nanoToUsd(count.confirmed).toFixed(6)} confirmed, its estimate of $${nanoToUsd(ceilingNano).toFixed(6)} passes the stop`;
        break;
      }
      const seen: { id: string; ms: number; result: MeteredResult; trial?: string }[] = [];
      const watched: Metered = async (request) => {
        const id = request.attemptId;
        const estimate = estimates.get(id);
        // The trial's own admission, before the spend guard's, at every physical send.
        const why = refusalFor(count, limits, estimate);
        if (why !== null || estimate === undefined) {
          count.refusal ??= why;
          const result: MeteredResult = { ok: false, attemptId: id, sent: false, reason: "envelope-exhausted" };
          seen.push({ id, ms: 0, result, trial: why ?? "trial-unplanned" });
          return result;
        }
        count.flying++;
        count.flyingEstimate += estimate;
        const began = now();
        let result: MeteredResult;
        try {
          result = await metered(request);
        } catch (error) {
          // Nothing is known about a request that ended like this: it keeps its full hold here too.
          count.flying--;
          count.flyingEstimate -= estimate;
          count.unresolved++;
          throw error;
        }
        count.flying--;
        count.flyingEstimate -= estimate;
        if (result.ok && result.settled) {
          count.confirmed += result.costNano;
          if (result.costNano > estimate) count.over ??= id;
        } else if (result.ok || result.sent) {
          count.unresolved++;
        }
        seen.push({ id, ms: now() - began, result });
        return result;
      };
      const began = now();
      const done = await gossipRound(watched, c, s, { model: true, cacheKey: `gossip:${c.id}` });
      const ms = now() - began;
      s = done.session;
      const round = done.round;
      for (const plan of plans) {
        const id = idOf(config, n, plan);
        const sent = seen.find((x) => x.id === id);
        // After a wave with a problem no further wave goes out: such a speaker was never asked.
        if (!sent) continue;
        const told = round.events.find((e) => e.from === plan.speaker && e.by === "model");
        report.choices.push(choiceRow(id, n, plan, estimates.get(id)!, sent, told?.to));
      }
      report.rounds.push({
        n,
        at: round.at,
        ms,
        speakers: round.speakers,
        calls: round.calls,
        requests: round.requests,
        events: round.events.map((e) => ({ from: e.from, to: e.to, topic: e.topic, by: e.by })),
        unconfirmed: round.unconfirmed,
        refused: round.refused,
        costNano: round.costNano,
        ceilingNano,
        ...(round.problem !== undefined ? { problem: round.problem } : {}),
      });
      report.unresolved = count.unresolved;
      report.unresolvedHoldNano = count.unresolved * CHOICE_HOLD_NANO;
      if (count.over !== null) report.stoppedBy = `round ${n}: ${count.over} cost more than the trial's estimate of it`;
      else if (count.refusal !== null) report.stoppedBy = `round ${n}: the trial refused a request (${count.refusal})`;
      else if (round.problem !== undefined) report.stoppedBy = `round ${n}: ${round.problem}`;
      if (report.stoppedBy === undefined && n === config.rounds) report.complete = true;
      deps.save?.(report);
      if (report.stoppedBy !== undefined) break;
    }
    // A stop before a round began has not been saved yet.
    deps.save?.(report);
    return report;
  });
  if (!admitted.ok) return { kind: "locked" };
  return admitted.value === null ? { kind: "closed", held: closed } : { kind: "ran", report: admitted.value };
}

function choiceRow(id: string, round: number, plan: GossipPlan, ceilingNano: number, sent: { ms: number; result: MeteredResult; trial?: string }, to: string | undefined): ChoiceRow {
  const { ms, result } = sent;
  const base = { id, round, speaker: plan.speaker, candidates: [...plan.candidates], ms, ceilingNano };
  if (!result.ok) return result.sent ? { ...base, outcome: "failed", costNano: 0 } : { ...base, outcome: "refused", reason: sent.trial ?? result.reason, costNano: 0 };
  const usage = result.response.usage;
  const counts = {
    ...(usage ? { input: usage.inputTokens, cached: usage.cachedTokens, output: usage.outputTokens } : {}),
    ...(usage?.reasoningTokens !== undefined ? { reasoning: usage.reasoningTokens } : {}),
    ...(result.response.finishReason !== undefined ? { finish: result.response.finishReason } : {}),
  };
  if (!result.settled || result.breached) return { ...base, ...counts, outcome: "unconfirmed", costNano: result.settled ? result.costNano : 0 };
  if (to === undefined) return { ...base, ...counts, outcome: "unusable", costNano: result.costNano };
  return { ...base, ...counts, outcome: "picked", to, place: plan.candidates.indexOf(to), costNano: result.costNano };
}

/** The figures a reader wants from a report, worked out one way for the printout and the tests. */
export function trialSummary(report: GossipTrialReport) {
  const sent = report.choices.filter((r) => r.outcome !== "refused");
  const picked = sent.filter((r) => r.outcome === "picked");
  const sum = (pick: (r: ChoiceRow) => number | undefined) => sent.reduce((total, r) => total + (pick(r) ?? 0), 0);
  const times = sent.map((r) => r.ms).sort((a, b) => a - b);
  const places = [0, 1, 2, 3].map((place) => picked.filter((r) => r.place === place).length);
  const costNano = sum((r) => r.costNano);
  return {
    requests: sent.length,
    picked: picked.length,
    unusable: sent.filter((r) => r.outcome === "unusable").length,
    cutOff: sent.filter((r) => r.outcome === "unusable" && r.finish !== "stop").length,
    /** How often the first, second, third and fourth person offered was the one picked. */
    places,
    input: sum((r) => r.input),
    cached: sum((r) => r.cached),
    output: sum((r) => r.output),
    reasoning: sum((r) => r.reasoning),
    costNano,
    medianMs: times.length > 0 ? times[Math.floor((times.length - 1) / 2)]! : 0,
    slowestMs: times.at(-1) ?? 0,
    /** Events of any kind, the ones code applied for a speaker with a single candidate included. */
    events: report.rounds.reduce((total, r) => total + r.events.length, 0),
    perPickNano: picked.length > 0 ? Math.round(costNano / picked.length) : null,
    /** The trial's estimate of the requests that were sent, to set beside what they cost. */
    estimateNano: sum((r) => r.ceilingNano),
    unresolved: report.unresolved,
    unresolvedHoldNano: report.unresolvedHoldNano,
  };
}

// ---- The command line ----

/** What the command line needs from the real spend guard. Tests hand it a fake. */
export interface GossipTrialRuntime {
  metered: Metered;
  store: { attempts(envelope: string): Promise<readonly StoredAttempt[]>; totals(envelope: string): Promise<EnvelopeTotals> };
  runLock: RunLock;
  config: { envelope: string };
  close(): Promise<void>;
}

export interface GossipTrialCliDeps {
  c: Case;
  config: GossipTrialConfig;
  /** Where the operator's two limits are read from. */
  env: Record<string, string | undefined>;
  /** The one envelope this trial may use. */
  envelope: string;
  /** Connects to the spend guard. Called only once the arguments have been read and accepted. */
  runtime: () => Promise<GossipTrialRuntime>;
  print: (line: string) => void;
  save?: (report: GossipTrialReport) => void;
}

const both = (en: string, zh: string): string => `${en} · ${zh}`;
const usd = (nano: number) => `$${nanoToUsd(nano).toFixed(6)}`;
const LETTERS = "abcdefgh";

/**
 * The trial's command line, as a function: read the arguments and the operator's limits, say
 * the plan, and run it if that was asked for and is allowed. Returns the exit code. An
 * argument it does not know, a limit it cannot read, or a run asked for with no limits set
 * ends it before anything is connected.
 */
export async function gossipTrialCli(argv: readonly string[], deps: GossipTrialCliDeps): Promise<number> {
  const { c, config, print } = deps;
  const say = (en: string, zh: string): void => print(both(en, zh));
  const args = parseRunArgs(argv, { allowGame: false });
  if (!args.ok) {
    say(`${args.why[0]}. Usage: [--plan]. Nothing was sent.`, `${args.why[1]}。用法：[--plan]。未发送任何内容。`);
    return 1;
  }
  const read = readLimits(deps.env);
  if (!read.ok) {
    say(`${read.why[0]}. Nothing was sent.`, `${read.why[1]}。未发送任何内容。`);
    return 1;
  }
  const limits = read.limits;
  if (!limits && !args.plan) {
    say(
      `A run needs both of its limits, set by the person running it: ${STOP_ENV} and ${BOUND_ENV}. Neither has a default. Nothing was sent.`,
      `运行需要由操作者设定两个限额：${STOP_ENV} 和 ${BOUND_ENV}。两者都没有默认值。未发送任何内容。`,
    );
    return 1;
  }
  const plan = await planGossipTrial(c, config, limits);
  const person = (id: string) => c.suspects.find((s) => s.id === id)?.name ?? { en: id, zh: id };

  say(
    `Gossip trial "${config.id}" on "${c.title.en}": ${plan.rounds.length} round(s), at most ${plan.ids.length} request(s), ever. Each asks one speaker's agent whom to tell, at minimal effort and at most ${GOSSIP_OUTPUT_TOKENS} output tokens. The player's actions between rounds are made by code and send nothing.`,
    `私下交谈试验 "${config.id}"，案件《${c.title.zh}》：${plan.rounds.length} 轮，总共最多 ${plan.ids.length} 个请求，且只此一次。每个请求让一位说话者的智能体选择告诉谁，最低推理强度，输出最多 ${GOSSIP_OUTPUT_TOKENS} 个 token。两轮之间玩家的行动由代码完成，不发送任何内容。`,
  );
  for (const round of plan.rounds) {
    print(`  ${both(`round ${round.n}, after ${round.at} actions`, `第 ${round.n} 轮，在 ${round.at} 次行动之后`)}: ${round.ids.length} × ${both("request", "请求")}, ${both(`estimated at ${usd(round.ceilingNano)}`, `估计 ${usd(round.ceilingNano)}`)}`);
    print(`    ${round.ids.join(" ")}`);
  }
  say(
    `What a request will be billed is not known before it is sent: the API limits output, not billed input. So there are two figures. The trial's estimate of all ${plan.ids.length} request(s) is ${usd(plan.ceilingNano)}: a guess made generous, not a limit. What the spend guard holds is ${usd(CHOICE_HOLD_NANO)} for each request in flight, ${usd(plan.heldAtOnceNano)} at the most at one moment: that is the most the bill can be while they are out.`,
    `一个请求会被计多少费，发送之前无法确知：接口只限制输出，不限制计费的输入。所以有两个数字。试验对全部 ${plan.ids.length} 个请求的估计是 ${usd(plan.ceilingNano)}：这是放宽了的估计，不是限额。额度守卫为每个在途请求保留 ${usd(CHOICE_HOLD_NANO)}，同一时刻最多保留 ${usd(plan.heldAtOnceNano)}：请求在途时，账单最多就是这么多。`,
  );
  if (limits) {
    say(
      `Limits set for this run: stop ${usd(limits.stopNano)} (confirmed spend plus the estimate of each request in flight; after a request that costs more than its estimate, nothing more is sent), bound ${usd(limits.boundNano)} (confirmed spend plus a full hold for each request in flight or unresolved). Of the bound, ${usd(plan.heldAtOnceNano)} is what four requests hold while they are out together; only what is left over is room for the running total of confirmed costs.`,
      `本次运行设定的限额：停止线 ${usd(limits.stopNano)}（已确认花费加上每个在途请求的估计；一旦有请求的费用超过估计，就不再发送），硬上限 ${usd(limits.boundNano)}（已确认花费加上每个在途或结果不明的请求的全额保留）。硬上限里有 ${usd(plan.heldAtOnceNano)} 是四个请求同时在途时的保留额；剩下的部分才是留给已确认费用累计的空间。`,
    );
    if (plan.refused) {
      const which: [string, string] = plan.refused.by === "bound" ? ["a wave of full holds passes the bound", "一批请求的全额保留超过硬上限"] : ["its estimate passes the stop", "它的估计超过停止线"];
      if (plan.refused.round === 1)
        say(`With these limits round 1 would not start: ${which[0]}. Nothing would be sent.`, `按这些限额，第 1 轮不会开始：${which[1]}。不会发送任何内容。`);
      else
        say(
          `A forecast, not a limit: if every request cost its whole estimate, round ${plan.refused.round} would not start (${which[0]}) and ${plan.forecast} request(s) would go out. A run counts what the earlier rounds really cost, which is usually less, so it may go further: up to all ${plan.most}.`,
          `这是预测，不是限额：如果每个请求都花掉它的全部估计，第 ${plan.refused.round} 轮不会开始（${which[1]}），会发出 ${plan.forecast} 个请求。运行时按前面几轮的实际费用计算，通常更少，所以可能走得更远：最多全部 ${plan.most} 个。`,
        );
    }
  } else {
    say(`No limits are set (${STOP_ENV}, ${BOUND_ENV}), so a run would refuse to start.`, `没有设定限额（${STOP_ENV}、${BOUND_ENV}），运行会拒绝开始。`);
  }

  const runtime = await deps.runtime();
  const envelope = runtime.config.envelope;
  if (envelope !== deps.envelope) {
    say(`This trial uses the "${deps.envelope}" envelope only; this terminal is set to "${envelope}". Nothing was sent.`, `本试验只使用额度 "${deps.envelope}"，当前终端设置的是 "${envelope}"。未发送任何内容。`);
    await runtime.close();
    return 1;
  }
  // The binding figure: every id, or none when round 1 cannot start. A forecast is said apart from it, above.
  const most = plan.most;
  const held = heldByTrial(config, await runtime.store.attempts(envelope));
  const paidOpen = Boolean((await runtime.store.totals(envelope)).paidAllowed);
  if (held.length > 0) {
    const open = held.filter((a) => a.state !== "settled");
    say(
      `This trial is closed: the spend store already holds ${held.length} of its request(s)${open.length > 0 ? `, ${open.length} of them with an unknown outcome (${open.map((a) => a.attemptId).join(", ")})` : ""}. A trial runs once; nothing can be sent.`,
      `本试验已结束：额度存储里已有它的 ${held.length} 个请求${open.length > 0 ? `，其中 ${open.length} 个结果不明（${open.map((a) => a.attemptId).join("，")}）` : ""}。一次试验只运行一次，不能再发送任何内容。`,
    );
    await runtime.close();
    return args.plan ? 0 : 1;
  }
  if (!paidOpen) {
    say(`Paid requests are not authorized on this envelope, so a run now would send nothing. Once a person authorizes them, a run would send at most ${most} request(s).`, `该额度未授权付费请求，现在运行不会发送任何内容。经人授权后，一次运行最多发送 ${most} 个请求。`);
  } else {
    say(`A run now would send at most ${most} request(s).`, `现在运行最多发送 ${most} 个请求。`);
  }
  if (args.plan || !paidOpen || !limits) {
    await runtime.close();
    return args.plan ? 0 : 1;
  }

  const before = await runtime.store.totals(envelope);
  say(`Envelope "${envelope}": ${usd(before.committedNano)} committed before the run.`, `额度 "${envelope}"：运行前已占用 ${usd(before.committedNano)}。`);
  const run = await runGossipTrial(c, config, limits, { metered: runtime.metered, lock: runtime.runLock, stored: () => runtime.store.attempts(envelope), ...(deps.save ? { save: deps.save } : {}) });
  if (run.kind === "locked") {
    say("Another run already holds the lease on this envelope. Nothing was sent.", "另一个进程已经占用这个额度的运行许可。未发送任何内容。");
    await runtime.close();
    return 1;
  }
  if (run.kind === "closed") {
    say("Requests of this trial appeared in the spend store before this run was admitted. Nothing was sent.", "在本次运行获准之前，额度存储里已出现本试验的请求。未发送任何内容。");
    await runtime.close();
    return 1;
  }
  const report = run.report;
  for (const round of report.rounds) {
    print("");
    say(
      `Round ${round.n}, after ${round.at} actions: ${round.speakers} speaker(s), ${round.requests} request(s) in ${round.ms} ms, ${round.events.length} told, ${usd(round.costNano)} confirmed${round.problem ? `, PROBLEM: ${round.problem}` : ""}`,
      `第 ${round.n} 轮，在 ${round.at} 次行动之后：${round.speakers} 位说话者，${round.requests} 个请求，用时 ${round.ms} 毫秒，${round.events.length} 人被告知，已确认费用 ${usd(round.costNano)}${round.problem ? `，出现问题：${round.problem}` : ""}`,
    );
    for (const row of report.choices.filter((r) => r.round === round.n)) {
      const offered = row.candidates.map((id, i) => `${LETTERS[i]} ${person(id).en}`).join(", ");
      const result = row.outcome === "picked" ? `-> ${LETTERS[row.place!]} ${person(row.to!).en} · ${person(row.to!).zh}` : row.outcome === "refused" ? `refused (${row.reason})` : row.outcome;
      if (row.outcome === "refused") {
        print(`  ${row.id.padEnd(18)} ${person(row.speaker).en} · ${person(row.speaker).zh} ${result}`);
        continue;
      }
      print(`  ${row.id.padEnd(18)} ${person(row.speaker).en} · ${person(row.speaker).zh} ${result}`);
      print(`    ${String(row.ms).padStart(6)} ms | in ${row.input ?? "?"} (cached ${row.cached ?? "?"}) | out ${row.output ?? "?"} (reasoning ${row.reasoning ?? "?"}) | finish ${row.finish ?? "?"} | ${usd(row.costNano)} (est. ${usd(row.ceilingNano)}) | ${offered}`);
    }
  }
  print("");
  if (report.stoppedBy) say(`STOPPED: ${report.stoppedBy}. No further round was started.`, `已停止：${report.stoppedBy}。没有再开始后面的轮次。`);
  const total = trialSummary(report);
  say("Summary", "汇总");
  say(
    `${total.requests} request(s) sent: ${total.picked} picked a listener, ${total.unusable} picked nobody (${total.cutOff} cut off). ${total.events} told in all.`,
    `共发出 ${total.requests} 个请求：${total.picked} 个选出了听者，${total.unusable} 个没有选出（其中 ${total.cutOff} 个被截断）。总共 ${total.events} 人被告知。`,
  );
  say(
    `Picked the 1st, 2nd, 3rd, 4th person offered: ${total.places.join(", ")} time(s).`,
    `选中第 1、2、3、4 位候选人的次数：${total.places.join("、")}。`,
  );
  say(
    `Tokens: ${total.input} input (${total.cached} cached), ${total.output} output (${total.reasoning} reasoning). Confirmed cost ${usd(total.costNano)}${total.perPickNano !== null ? `, ${usd(total.perPickNano)} for each listener picked` : ""}. A request took ${total.medianMs} ms at the median, ${total.slowestMs} ms at the slowest.`,
    `Token：输入 ${total.input}（其中缓存 ${total.cached}），输出 ${total.output}（其中推理 ${total.reasoning}）。已确认费用 ${usd(total.costNano)}${total.perPickNano !== null ? `，每选出一位听者 ${usd(total.perPickNano)}` : ""}。单个请求用时中位数 ${total.medianMs} 毫秒，最慢 ${total.slowestMs} 毫秒。`,
  );
  say(
    `Against the trial's estimate of ${usd(total.estimateNano)} for the requests it sent, they cost ${usd(total.costNano)} confirmed.${total.unresolved > 0 ? ` ${total.unresolved} request(s) have no confirmed cost: the spend guard keeps ${usd(total.unresolvedHoldNano)} for them until they are settled by hand. That is money held, not a charge that was seen.` : ""}`,
    `试验对已发送请求的估计是 ${usd(total.estimateNano)}，已确认的实际费用是 ${usd(total.costNano)}。${total.unresolved > 0 ? `有 ${total.unresolved} 个请求的费用未确认：额度守卫为它们保留 ${usd(total.unresolvedHoldNano)}，直到人工结算。这是保留的额度，不是已看到的扣费。` : ""}`,
  );
  const after = await runtime.store.totals(envelope);
  say(
    `Envelope now: settled ${usd(after.settledNano)}, kept for unknown outcomes ${usd(after.retainedNano)}, committed ${usd(after.committedNano)}.${after.suspended ? ` SUSPENDED: ${after.suspended}` : ""}`,
    `额度现状：已结算 ${usd(after.settledNano)}，结果不明而保留 ${usd(after.retainedNano)}，已占用 ${usd(after.committedNano)}。${after.suspended ? "额度已停用。" : ""}`,
  );
  await runtime.close();
  return report.complete ? 0 : 1;
}
