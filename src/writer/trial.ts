import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Metered } from "../metered";
import { memoryRunLock, type RunLock } from "../spend/run-lock";
import type { SkeletonBrief } from "./plot";
import { checkSkeleton, SHUFFLE_VERSION, writeCase, type ReplyRecord, type WriteReport } from "./write";

/**
 * A trial of the case writer: a fixed list of attempts, each at most two requests.
 *
 * This is the part of the paid trial that can be tested without paying: what would run, what
 * is saved, and what may be picked up again. The script around it only connects it to the
 * real spend guard and prints.
 *
 * Three rules:
 *  - The cap is in the request ids. An attempt's two ids are fixed, and the spend store sends
 *    an id once, ever. What has gone out is read from the store's durable records.
 *  - Every reply is saved the moment it arrives, exactly as it arrived: complete or cut off,
 *    JSON or not, with how it ended, what it used and whether its cost was confirmed. The
 *    file is written whole or not at all.
 *  - An attempt whose skeleton went out but whose people request did not may be resumed, and
 *    only from a saved skeleton that is intact, is this attempt's, ended normally, had its cost
 *    confirmed, and passes today's skeleton check. The plan and the run decide this with the
 *    same function, so the plan cannot promise a request the run will not send.
 */

export interface TrialAttempt {
  id: string;
  theme: string;
}

export interface TrialConfig {
  attempts: readonly TrialAttempt[];
  suspects: number;
  rooms: number;
  /** Where replies and reports are saved. */
  dir: string;
}

/** One of the store's durable attempt records. */
export interface StoredAttempt {
  attemptId: string;
  state: string;
}

/** A reply as saved on disk: the reply itself, and the brief it answered. */
export interface SavedReply extends ReplyRecord {
  brief: SkeletonBrief;
  /** Which reordering rule the attempt used. */
  shuffleVersion: number;
}

export type Standing =
  /** Neither request has gone out: both would be sent. */
  | { kind: "fresh"; most: 2 }
  /** The skeleton went out and its saved reply is good; only the people request would be sent. */
  | { kind: "resume"; most: 1; skeleton: unknown; salt?: string }
  /** Nothing more can be sent for this attempt. */
  | { kind: "closed"; most: 0; why: [en: string, zh: string] };

export interface TrialPlan {
  rows: { attempt: TrialAttempt; standing: Standing }[];
  /** Requests of this trial whose outcome the store does not know. While there are any, nothing is sent. */
  unresolved: StoredAttempt[];
  /** The most requests a run would send now. */
  most: number;
}

const briefOf = (config: TrialConfig, attempt: TrialAttempt): SkeletonBrief => ({ theme: attempt.theme, suspects: config.suspects, rooms: config.rooms });
export const replyPath = (config: TrialConfig, id: string, stage: "skeleton" | "people") => `${config.dir}/${id}.${stage}.json`;
export const reportPath = (config: TrialConfig, id: string) => `${config.dir}/${id}.json`;

/** The store's records, given as they are or fetched when asked for. A run fetches them after it holds the lock. */
export type StoredSource = readonly StoredAttempt[] | (() => readonly StoredAttempt[] | Promise<readonly StoredAttempt[]>);
export const readStored = async (source: StoredSource): Promise<readonly StoredAttempt[]> => (typeof source === "function" ? source() : source);

/** In-process locks, one per folder, used when the caller gives no lock of its own. */
const localLocks = new Map<string, RunLock>();
const localLock = (dir: string): RunLock => {
  let lock = localLocks.get(dir);
  if (!lock) localLocks.set(dir, (lock = memoryRunLock()));
  return lock;
};

/**
 * Do the work as the one admitted runner (see `RunLock`). The lease is taken first; the work
 * gets a wrapper that renews it before every request and refuses the request if the lease is
 * no longer this run's. The lease is given up however the work ends.
 */
export async function asOnlyRunner<T>(lock: RunLock, metered: Metered, work: (metered: Metered) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  const lease = await lock.acquire();
  if (!lease) return { ok: false };
  const guarded: Metered = async (request) => {
    // Lost the lease (it ran out and another run took it): send nothing more.
    if (!(await lease.renew())) return { ok: false, attemptId: request.attemptId, sent: false, reason: "kill-switch" };
    return metered(request);
  };
  try {
    return { ok: true, value: await work(guarded) };
  } finally {
    await lease.release();
  }
}

/** Write a file whole or not at all: to a temporary name first, then renamed into place. */
export function writeWhole(path: string, text: string): void {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) mkdirSync(dir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/**
 * Can stage 2 run from this saved skeleton reply? `text` is the file's contents, or null
 * when there is no file. Every way it can be unusable has its own answer.
 */
export function savedSkeleton(text: string | null, attemptId: string, brief: SkeletonBrief): { ok: true; skeleton: unknown; salt?: string } | { ok: false; why: [en: string, zh: string] } {
  const saved = savedReply(text, attemptId, "skeleton", brief);
  if (!saved.ok) return saved;
  const checked = checkSkeleton(saved.value, brief);
  if (!checked.ok) return { ok: false, why: [`the saved skeleton is refused by the skeleton check: ${checked.reasons[0] ?? ""}`, `保存的骨架未通过骨架检查：${checked.reasons[0] ?? ""}`] };
  return { ok: true, skeleton: saved.value, ...(typeof saved.reply.salt === "string" && saved.reply.salt !== "" ? { salt: saved.reply.salt } : {}) };
}

const LABEL = { skeleton: ["skeleton", "骨架"], people: ["people reply", "人物回复"] } as const;

/**
 * Read one saved reply back and decide whether it can be used: the file is whole, it is this
 * attempt's reply for this stage and this brief, its cost was confirmed, it ended normally,
 * and its text is JSON. `text` is the file's contents, or null when there is no file.
 */
export function savedReply(
  text: string | null,
  attemptId: string,
  stage: "skeleton" | "people",
  brief: SkeletonBrief,
): { ok: true; reply: Partial<SavedReply>; value: unknown } | { ok: false; why: [en: string, zh: string] } {
  const [en, zh] = LABEL[stage];
  const no = (e: string, z: string) => ({ ok: false as const, why: [e, z] as [string, string] });
  if (text === null) return stage === "skeleton" ? no("the skeleton went out but its reply was not saved", "骨架请求已发出，但回复没有保存") : no("the people reply was not saved", "人物回复没有保存");
  let saved: Partial<SavedReply>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    saved = parsed as Partial<SavedReply>;
  } catch {
    return no(`the saved ${en} file is damaged`, `保存的${zh}文件已损坏`);
  }
  const sameBrief = saved.brief?.theme === brief.theme && saved.brief?.suspects === brief.suspects && saved.brief?.rooms === brief.rooms;
  if (saved.attemptId !== `${attemptId}:${stage}` || saved.stage !== stage || !sameBrief) return no(`the saved ${en} belongs to another attempt`, `保存的${zh}属于另一次尝试`);
  if (saved.settled !== true || saved.breached !== false) return no(`the saved ${en}'s cost was not confirmed`, `保存的${zh}费用未确认`);
  if (saved.finishReason === "length" || typeof saved.text !== "string") return no(`the saved ${en} was cut off`, `保存的${zh}被截断`);
  if (saved.finishReason !== "stop") return no(`the saved ${en} did not end normally`, `保存的${zh}不是正常结束的`);
  let value: unknown;
  try {
    value = JSON.parse(saved.text) as unknown;
  } catch {
    return no(`the saved ${en} is not JSON`, `保存的${zh}不是 JSON`);
  }
  return { ok: true, reply: saved, value };
}

/** A file's text, or null when it is not there or cannot be read. */
export const readSaved = (path: string): string | null => {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** What a run would do now, given the store's records and what is saved on disk. */
export function planTrial(config: TrialConfig, stored: readonly StoredAttempt[]): TrialPlan {
  const ids = new Set(config.attempts.flatMap((a) => [`${a.id}:skeleton`, `${a.id}:people`]));
  const mine = stored.filter((a) => ids.has(a.attemptId));
  const known = new Set(mine.map((a) => a.attemptId));
  const rows = config.attempts.map((attempt) => {
    let standing: Standing;
    if (known.has(`${attempt.id}:people`)) standing = { kind: "closed", most: 0, why: ["both requests have gone out", "两个请求都已发出"] };
    else if (!known.has(`${attempt.id}:skeleton`)) standing = { kind: "fresh", most: 2 };
    else {
      const saved = savedSkeleton(readSaved(replyPath(config, attempt.id, "skeleton")), attempt.id, briefOf(config, attempt));
      standing = saved.ok ? { kind: "resume", most: 1, skeleton: saved.skeleton, ...(saved.salt ? { salt: saved.salt } : {}) } : { kind: "closed", most: 0, why: saved.why };
    }
    return { attempt, standing };
  });
  const unresolved = mine.filter((a) => a.state !== "settled");
  return { rows, unresolved, most: unresolved.length > 0 ? 0 : rows.reduce((sum, r) => sum + r.standing.most, 0) };
}

/**
 * One attempt's writing, with everything it produces saved: each reply as it arrives, and
 * at the end whatever the attempt got to. If that is a case, its file holds the answer.
 * The report file is a convenience for people. Nothing in the code trusts it: a saved case
 * is always made again from the saved replies.
 */
export async function writeAttempt(config: TrialConfig, attempt: TrialAttempt, standing: Exclude<Standing, { kind: "closed" }>, metered: Metered): Promise<WriteReport> {
  const brief = briefOf(config, attempt);
  const report = await writeCase({
    metered,
    attemptId: attempt.id,
    brief,
    // A resumed attempt keeps the salt its skeleton was saved with: one attempt, one salt.
    ...(standing.kind === "resume" ? { skeleton: standing.skeleton, ...(standing.salt ? { salt: standing.salt } : {}) } : {}),
    // Saved before anything parses or judges it.
    onReply: (reply) => writeWhole(replyPath(config, attempt.id, reply.stage), `${JSON.stringify({ ...reply, brief, shuffleVersion: SHUFFLE_VERSION } satisfies SavedReply, null, 2)}\n`),
  });
  // Only a run that sent something for this attempt has anything to report. A run whose
  // request was refused because another run had already sent it must not write over what
  // that run saved, even if it sent an earlier request of the attempt itself. The run lock
  // keeps two runs apart; this is the second line.
  if (report.requests > 0 && report.problem !== "refused:duplicate-attempt") {
    writeWhole(
      reportPath(config, attempt.id),
      `${JSON.stringify({ accepted: report.accepted, failedAt: report.failedAt ?? null, problem: report.problem ?? null, reasons: report.reasons, notes: report.notes, quality: report.quality ?? null, usage: report.usage, salt: report.salt, shuffleVersion: SHUFFLE_VERSION, case: report.case ?? null }, null, 2)}\n`,
    );
  }
  return report;
}

export interface TrialRun {
  reports: { attempt: TrialAttempt; resumed: boolean; ms: number; report: WriteReport }[];
  /** Set when the run ended early because a request was refused, failed or came back unconfirmed. */
  stoppedBy?: string;
  /** True when nothing was sent: requests of this trial are unresolved, or another run holds the lock. */
  blocked: boolean;
  /** Set when another run already held the lease. */
  lockedBy?: string;
}

/**
 * Run what the plan says. The caller has already made sure paid requests are authorized; the
 * spend guard refuses them otherwise. `onAttempt` is called after each attempt, for printing.
 */
export interface RunDeps {
  metered: Metered;
  /** The store's records. Give a function, so they are read after the lease is held. */
  stored: StoredSource;
  /** The one-runner lease. A paid run passes the store's; without one, a lock inside this process is used. */
  lock?: RunLock;
  now?: () => number;
}

export async function runTrial(config: TrialConfig, deps: RunDeps & { onAttempt?: (entry: TrialRun["reports"][number]) => void }): Promise<TrialRun> {
  const admitted = await asOnlyRunner(deps.lock ?? localLock(config.dir), deps.metered, (metered) => runTrialAdmitted(config, { ...deps, metered }));
  return admitted.ok ? admitted.value : { reports: [], blocked: true, lockedBy: "another run" };
}

async function runTrialAdmitted(config: TrialConfig, deps: RunDeps & { onAttempt?: (entry: TrialRun["reports"][number]) => void }): Promise<TrialRun> {
  const now = deps.now ?? Date.now;
  // Read after the lease is held: nothing else is writing now, so this is the state to plan from.
  const plan = planTrial(config, await readStored(deps.stored));
  if (plan.unresolved.length > 0) return { reports: [], blocked: true };
  const run: TrialRun = { reports: [], blocked: false };
  for (const { attempt, standing } of plan.rows) {
    if (standing.kind === "closed") continue;
    const started = now();
    const report = await writeAttempt(config, attempt, standing, deps.metered);
    const entry = { attempt, resumed: standing.kind === "resume", ms: now() - started, report };
    run.reports.push(entry);
    deps.onAttempt?.(entry);
    if (report.problem) {
      run.stoppedBy = report.problem;
      break;
    }
  }
  return run;
}
