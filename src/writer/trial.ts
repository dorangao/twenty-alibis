import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Metered } from "../metered";
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
  const no = (en: string, zh: string) => ({ ok: false as const, why: [en, zh] as [string, string] });
  if (text === null) return no("the skeleton went out but its reply was not saved", "骨架请求已发出，但回复没有保存");
  let saved: Partial<SavedReply>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    saved = parsed as Partial<SavedReply>;
  } catch {
    return no("the saved skeleton file is damaged", "保存的骨架文件已损坏");
  }
  const sameBrief = saved.brief?.theme === brief.theme && saved.brief?.suspects === brief.suspects && saved.brief?.rooms === brief.rooms;
  if (saved.attemptId !== `${attemptId}:skeleton` || saved.stage !== "skeleton" || !sameBrief) return no("the saved skeleton belongs to another attempt", "保存的骨架属于另一次尝试");
  if (saved.settled !== true || saved.breached !== false) return no("the saved skeleton's cost was not confirmed", "保存的骨架费用未确认");
  if (saved.finishReason === "length" || typeof saved.text !== "string") return no("the saved skeleton was cut off", "保存的骨架被截断");
  if (saved.finishReason !== "stop") return no("the saved skeleton did not end normally", "保存的骨架不是正常结束的");
  let skeleton: unknown;
  try {
    skeleton = JSON.parse(saved.text) as unknown;
  } catch {
    return no("the saved skeleton is not JSON", "保存的骨架不是 JSON");
  }
  const checked = checkSkeleton(skeleton, brief);
  if (!checked.ok) return no(`the saved skeleton is refused by the skeleton check: ${checked.reasons[0] ?? ""}`, `保存的骨架未通过骨架检查：${checked.reasons[0] ?? ""}`);
  return { ok: true, skeleton, ...(typeof saved.salt === "string" && saved.salt !== "" ? { salt: saved.salt } : {}) };
}

const read = (path: string): string | null => {
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
      const saved = savedSkeleton(read(replyPath(config, attempt.id, "skeleton")), attempt.id, briefOf(config, attempt));
      standing = saved.ok ? { kind: "resume", most: 1, skeleton: saved.skeleton, ...(saved.salt ? { salt: saved.salt } : {}) } : { kind: "closed", most: 0, why: saved.why };
    }
    return { attempt, standing };
  });
  const unresolved = mine.filter((a) => a.state !== "settled");
  return { rows, unresolved, most: unresolved.length > 0 ? 0 : rows.reduce((sum, r) => sum + r.standing.most, 0) };
}

export interface TrialRun {
  reports: { attempt: TrialAttempt; resumed: boolean; ms: number; report: WriteReport }[];
  /** Set when the run ended early because a request was refused, failed or came back unconfirmed. */
  stoppedBy?: string;
  /** True when nothing was sent because requests of this trial are unresolved. */
  blocked: boolean;
}

/**
 * Run what the plan says. The caller has already made sure paid requests are authorized; the
 * spend guard refuses them otherwise. `onAttempt` is called after each attempt, for printing.
 */
export async function runTrial(config: TrialConfig, deps: { metered: Metered; stored: readonly StoredAttempt[]; onAttempt?: (entry: TrialRun["reports"][number]) => void; now?: () => number }): Promise<TrialRun> {
  const now = deps.now ?? Date.now;
  const plan = planTrial(config, deps.stored);
  if (plan.unresolved.length > 0) return { reports: [], blocked: true };
  const run: TrialRun = { reports: [], blocked: false };
  for (const { attempt, standing } of plan.rows) {
    if (standing.kind === "closed") continue;
    const brief = briefOf(config, attempt);
    const started = now();
    const report = await writeCase({
      metered: deps.metered,
      attemptId: attempt.id,
      brief,
      // A resumed attempt keeps the salt its skeleton was saved with: one attempt, one salt.
      ...(standing.kind === "resume" ? { skeleton: standing.skeleton, ...(standing.salt ? { salt: standing.salt } : {}) } : {}),
      // Saved before anything parses or judges it.
      onReply: (reply) => writeWhole(replyPath(config, attempt.id, reply.stage), `${JSON.stringify({ ...reply, brief, shuffleVersion: SHUFFLE_VERSION } satisfies SavedReply, null, 2)}\n`),
    });
    const entry = { attempt, resumed: standing.kind === "resume", ms: now() - started, report };
    run.reports.push(entry);
    // Whatever the attempt got to. If that is a case, the file holds its answer.
    writeWhole(
      reportPath(config, attempt.id),
      `${JSON.stringify({ accepted: report.accepted, failedAt: report.failedAt ?? null, problem: report.problem ?? null, reasons: report.reasons, notes: report.notes, quality: report.quality ?? null, usage: report.usage, salt: report.salt, shuffleVersion: SHUFFLE_VERSION, case: report.case ?? null }, null, 2)}\n`,
    );
    deps.onAttempt?.(entry);
    if (report.problem) {
      run.stoppedBy = report.problem;
      break;
    }
  }
  return run;
}
