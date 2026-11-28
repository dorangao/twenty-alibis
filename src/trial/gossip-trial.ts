import { GOSSIP_OUTPUT_TOKENS, gossipMessages } from "../agents/gossip-turn";
import { isOpen } from "../case/access";
import type { Case } from "../case/schema";
import { GOSSIP_ROUNDS, planRound, type GossipPlan } from "../game/gossip";
import { ask, gossipDue, gossipRound, heldBy, inspect, startSession, type Session } from "../game/session";
import type { Metered, MeteredResult } from "../metered";
import { parseRunArgs } from "../run-args";
import { LOW_TIER, nanoToUsd } from "../spend/pricing";
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
 * What bounds it:
 *  - The ids. A request is "<trial id>:g<round>:<speaker's place in the case>". Which
 *    speakers a round has depends on the case and the walker alone, never on what a model
 *    replied, so the whole list is known before anything is sent, and the spend store sends
 *    an id once, ever.
 *  - One run, ever. If the store holds any request of this trial, nothing is sent: a trial
 *    that stopped half way is read from its saved report, not picked up again.
 *  - The trial's own cap. Before a round, the most that round could cost is added to what
 *    the trial has spent; if that passes the cap, the round is not started.
 *  - It stops after the first round in which a request was refused, failed or came back with
 *    its cost unconfirmed, or that cost more than the trial counted on.
 */
export interface GossipTrialConfig {
  /** Names the trial and begins every request id. */
  id: string;
  /** How many rounds to run: at most the game's own limit. */
  rounds: number;
  /** The most the trial may spend, by its own count. */
  capNano: number;
}

export const TRIAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Refuse a config this cannot run, before anything is connected. */
export function checkTrial(config: GossipTrialConfig): void {
  if (!TRIAL_ID.test(config.id)) throw new Error(`a trial id is lower-case words joined by hyphens, not "${config.id}"`);
  if (!Number.isInteger(config.rounds) || config.rounds < 1 || config.rounds > GOSSIP_ROUNDS) throw new Error(`a trial runs 1 to ${GOSSIP_ROUNDS} rounds`);
  if (!Number.isInteger(config.capNano) || config.capNano <= 0) throw new Error("the cap must be a positive whole number of nano-dollars");
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
 * The most one choice can cost, as the trial counts it: every byte of its messages taken as
 * a whole token, an allowance for the rest of the body, and the whole output limit, at the
 * lower price (a request this small is far below the line where the price rises). The spend
 * guard's own hold is much larger and is what protects the budget; this figure is only what
 * the trial's cap adds up, and a round that costs more than it stops the trial.
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
  /** The most the round could cost, with the candidates code would offer after code's own picks. A run counts again with the real ones. */
  ceilingNano: number;
}

export interface GossipTrialPlan {
  rounds: PlannedRound[];
  /** Every request id this trial can ever send. */
  ids: string[];
  ceilingNano: number;
  /** The first round the cap would refuse, if any, by this plan's count. */
  refusedAt: number | null;
}

/**
 * What the trial would send, worked out with no model: the walker plays, and code picks every
 * listener. The ids are exact. The ceilings are close: in a real run the candidates of later
 * rounds depend on whom the agents told before.
 */
export async function planGossipTrial(c: Case, config: GossipTrialConfig): Promise<GossipTrialPlan> {
  checkTrial(config);
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
  let refusedAt: number | null = null;
  for (const round of rounds) {
    total += round.ceilingNano;
    if (refusedAt === null && total > config.capNano) refusedAt = round.n;
  }
  return { rounds, ids: rounds.flatMap((r) => r.ids), ceilingNano: total, refusedAt };
}

/**
 * What happened to one request.
 *   picked       sent, cost confirmed, and the reply named one of the candidates
 *   unusable     sent and confirmed, but the reply picked nobody: cut off, or not one of the letters
 *   unconfirmed  sent and priced, but the store did not confirm the cost, or the envelope was suspended
 *   failed       sent, outcome unknown: its full hold stays charged
 *   refused      not sent
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
  /** Why nothing was sent, for a refusal. */
  reason?: string;
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
  capNano: number;
  rounds: RoundRow[];
  choices: ChoiceRow[];
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

export async function runGossipTrial(c: Case, config: GossipTrialConfig, deps: GossipTrialDeps): Promise<GossipTrialRun> {
  checkTrial(config);
  const now = deps.now ?? Date.now;
  let closed: StoredAttempt[] = [];
  const admitted = await asOnlyRunner(deps.lock, deps.metered, async (metered): Promise<GossipTrialReport | null> => {
    closed = heldByTrial(config, await readStored(deps.stored));
    if (closed.length > 0) return null;
    const report: GossipTrialReport = { id: config.id, caseId: c.id, capNano: config.capNano, rounds: [], choices: [], complete: false };
    let s = startSession(c, config.id, { gossip: true });
    let spent = 0;
    for (let n = 1; n <= config.rounds; n++) {
      s = await walk(c, s);
      if (!gossipDue(c, s)) {
        report.stoppedBy = `no round was due after ${s.actions} action(s)`;
        break;
      }
      const plans = callers(c, s, n);
      const ceilingNano = plans.reduce((sum, p) => sum + choiceCeilingNano(c, p), 0);
      if (spent + ceilingNano > config.capNano) {
        report.stoppedBy = `round ${n} could cost up to $${nanoToUsd(ceilingNano).toFixed(6)}, which with $${nanoToUsd(spent).toFixed(6)} spent passes the cap of $${nanoToUsd(config.capNano).toFixed(6)}`;
        break;
      }
      const seen: { id: string; ms: number; result: MeteredResult }[] = [];
      const watched: Metered = async (request) => {
        const began = now();
        const result = await metered(request);
        seen.push({ id: request.attemptId, ms: now() - began, result });
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
        report.choices.push(choiceRow(id, n, plan, sent.ms, sent.result, told?.to));
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
      spent += round.costNano;
      if (round.problem !== undefined) report.stoppedBy = `round ${n}: ${round.problem}`;
      else if (round.costNano > ceilingNano) report.stoppedBy = `round ${n} cost more than the trial counted on`;
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

function choiceRow(id: string, round: number, plan: GossipPlan, ms: number, result: MeteredResult, to: string | undefined): ChoiceRow {
  const base = { id, round, speaker: plan.speaker, candidates: [...plan.candidates], ms };
  if (!result.ok) return result.sent ? { ...base, outcome: "failed", costNano: 0 } : { ...base, outcome: "refused", reason: result.reason, costNano: 0 };
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
 * The trial's command line, as a function: read the arguments, say the plan, and run it if
 * that was asked for and is allowed. Returns the exit code. An argument it does not know
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
  const plan = await planGossipTrial(c, config);
  const person = (id: string) => c.suspects.find((s) => s.id === id)?.name ?? { en: id, zh: id };

  say(
    `Gossip trial "${config.id}" on "${c.title.en}": ${plan.rounds.length} round(s), at most ${plan.ids.length} request(s), ever. Each asks one speaker's agent whom to tell, at minimal effort and at most ${GOSSIP_OUTPUT_TOKENS} output tokens. The player's actions between rounds are made by code and send nothing.`,
    `私下交谈试验 "${config.id}"，案件《${c.title.zh}》：${plan.rounds.length} 轮，总共最多 ${plan.ids.length} 个请求，且只此一次。每个请求让一位说话者的智能体选择告诉谁，最低推理强度，输出最多 ${GOSSIP_OUTPUT_TOKENS} 个 token。两轮之间玩家的行动由代码完成，不发送任何内容。`,
  );
  for (const round of plan.rounds) {
    print(`  ${both(`round ${round.n}, after ${round.at} actions`, `第 ${round.n} 轮，在 ${round.at} 次行动之后`)}: ${round.ids.length} × ${both("request", "请求")}, ${both(`at most ${usd(round.ceilingNano)}`, `最多 ${usd(round.ceilingNano)}`)}`);
    print(`    ${round.ids.join(" ")}`);
  }
  say(
    `By the trial's own count this is at most ${usd(plan.ceilingNano)}; its cap is ${usd(config.capNano)}.${plan.refusedAt !== null ? ` Round ${plan.refusedAt} would not be started: it could pass the cap.` : ""}`,
    `按试验自己的算法，最多 ${usd(plan.ceilingNano)}；上限为 ${usd(config.capNano)}。${plan.refusedAt !== null ? `第 ${plan.refusedAt} 轮不会开始：它可能超过上限。` : ""}`,
  );

  const runtime = await deps.runtime();
  const envelope = runtime.config.envelope;
  if (envelope !== deps.envelope) {
    say(`This trial uses the "${deps.envelope}" envelope only; this terminal is set to "${envelope}". Nothing was sent.`, `本试验只使用额度 "${deps.envelope}"，当前终端设置的是 "${envelope}"。未发送任何内容。`);
    await runtime.close();
    return 1;
  }
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
    say(`Paid requests are not authorized on this envelope, so a run now would send nothing. Once a person authorizes them, a run would send at most ${plan.ids.length} request(s).`, `该额度未授权付费请求，现在运行不会发送任何内容。经人授权后，一次运行最多发送 ${plan.ids.length} 个请求。`);
  } else {
    say(`A run now would send at most ${plan.ids.length} request(s).`, `现在运行最多发送 ${plan.ids.length} 个请求。`);
  }
  if (args.plan || !paidOpen) {
    await runtime.close();
    return args.plan ? 0 : 1;
  }

  const before = await runtime.store.totals(envelope);
  say(`Envelope "${envelope}": ${usd(before.committedNano)} committed before the run.`, `额度 "${envelope}"：运行前已占用 ${usd(before.committedNano)}。`);
  const run = await runGossipTrial(c, config, { metered: runtime.metered, lock: runtime.runLock, stored: () => runtime.store.attempts(envelope), ...(deps.save ? { save: deps.save } : {}) });
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
      print(`  ${row.id.padEnd(18)} ${person(row.speaker).en} · ${person(row.speaker).zh} ${result}`);
      print(`    ${String(row.ms).padStart(6)} ms | in ${row.input ?? "?"} (cached ${row.cached ?? "?"}) | out ${row.output ?? "?"} (reasoning ${row.reasoning ?? "?"}) | finish ${row.finish ?? "?"} | ${usd(row.costNano)} | ${offered}`);
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
  const after = await runtime.store.totals(envelope);
  say(
    `Envelope now: settled ${usd(after.settledNano)}, kept for unknown outcomes ${usd(after.retainedNano)}, committed ${usd(after.committedNano)}.${after.suspended ? ` SUSPENDED: ${after.suspended}` : ""}`,
    `额度现状：已结算 ${usd(after.settledNano)}，结果不明而保留 ${usd(after.retainedNano)}，已占用 ${usd(after.committedNano)}。${after.suspended ? "额度已停用。" : ""}`,
  );
  await runtime.close();
  return report.complete ? 0 : 1;
}
