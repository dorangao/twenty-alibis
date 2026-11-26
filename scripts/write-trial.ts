/**
 * A paid trial of the case writer: a few fresh plots, each two requests, no repairs.
 * 案件生成器的付费试验：几份新剧情，每份两次请求，不做修补。
 *
 *   npm run trial:writer -- --plan   say exactly what a run would send now; sends nothing
 *   npm run trial:writer             run it (needs `npm run spend -- allow-paid "..."` first)
 *
 * The cap is in the request ids. Each attempt has two fixed ids ("<attempt>:skeleton",
 * "<attempt>:people"), and the spend store sends an id once, ever, however many times or
 * from however many terminals this script is started. What has already gone out is read
 * from the store's own durable records, not from the local trace.
 *
 * Every reply is saved the moment it arrives, in cases/generated/, before anything judges
 * it. So an attempt whose skeleton went out but whose people request did not can be picked
 * up again from the saved skeleton, spending only the people request. An attempt whose
 * skeleton went out and was not saved is closed.
 *
 * The run stops at the first request that is refused, fails, or comes back unconfirmed, and
 * an attempt that ends that way is not counted as accepted or refused.
 *
 * It uses the "local" envelope only. Whether it may run at all is a person's decision, made
 * by authorizing paid requests; nothing in this file grants that. And if any of its requests is
 * still reserved or was kept after a failure, it sends nothing until that is reconciled.
 *
 * History. Batch a (writer-a-1 to 3, Nov 25, 2026) sent three skeleton requests. All three
 * were refused at the skeleton stage and their replies were not saved, so that batch is
 * closed. This file now runs batch b.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRuntime } from "../src/runtime";
import { nanoToUsd } from "../src/spend/pricing";
import { PEOPLE_OUTPUT_TOKENS, SKELETON_OUTPUT_TOKENS, writeCase, type WriteReport } from "../src/writer/write";
import { both, say } from "./say";

/** The one envelope this trial uses. The ids are once-only per envelope, so another envelope would be a second set. */
const TRIAL_ENVELOPE = "local";
const SUSPECTS = 20;
const ROOMS = 6;
const ATTEMPTS: { id: string; theme: string }[] = [
  { id: "writer-b-1", theme: "a mountain observatory cut off by snow" },
  { id: "writer-b-2", theme: "a river steamer moored for the night" },
  { id: "writer-b-3", theme: "a tea estate house during the monsoon" },
];
const DIR = "cases/generated";
const usd = (nano: number) => `$${nanoToUsd(nano).toFixed(6)}`;
const savedSkeleton = (id: string) => `${DIR}/${id}.skeleton.json`;

const runtime = await createRuntime(process.env);
const envelope = runtime.config.envelope;
if (envelope !== TRIAL_ENVELOPE) {
  say(`This trial uses the "${TRIAL_ENVELOPE}" envelope only; this terminal is set to "${envelope}". Nothing was sent.`, `本试验只使用额度 "${TRIAL_ENVELOPE}"，当前终端设置的是 "${envelope}"。未发送任何内容。`);
  await runtime.close();
  process.exit(1);
}
const mine = (await runtime.store.attempts(envelope)).filter((a) => ATTEMPTS.some((t) => a.attemptId === `${t.id}:skeleton` || a.attemptId === `${t.id}:people`));
const known = new Set(mine.map((a) => a.attemptId));
/** Requests of this trial whose outcome the store does not know: still reserved, or kept after a failure. */
const unresolved = mine.filter((a) => a.state !== "settled");

type Standing =
  /** Neither request has gone out: both would be sent. */
  | { kind: "fresh"; most: 2 }
  /** The skeleton went out and was saved; the people request has not gone out: only that one would be sent. */
  | { kind: "resume"; most: 1 }
  /** Nothing more can be sent for this attempt. */
  | { kind: "closed"; most: 0; why: [string, string] };

function standing(id: string): Standing {
  const skeletonSent = known.has(`${id}:skeleton`);
  const peopleSent = known.has(`${id}:people`);
  if (peopleSent) return { kind: "closed", most: 0, why: ["both requests have gone out", "两个请求都已发出"] };
  if (!skeletonSent) return { kind: "fresh", most: 2 };
  if (existsSync(savedSkeleton(id))) return { kind: "resume", most: 1 };
  return { kind: "closed", most: 0, why: ["the skeleton went out but its reply was not saved", "骨架请求已发出，但回复没有保存"] };
}
const plan = ATTEMPTS.map((a) => ({ ...a, standing: standing(a.id) }));
const most = plan.reduce((sum, a) => sum + a.standing.most, 0);

say(
  `${ATTEMPTS.length} attempts of ${SUSPECTS} suspects and ${ROOMS} rooms. Each sends at most 2 requests (output limits ${SKELETON_OUTPUT_TOKENS} and ${PEOPLE_OUTPUT_TOKENS} tokens). At most ${ATTEMPTS.length * 2} requests in all, ever.`,
  `共 ${ATTEMPTS.length} 次尝试，每次 ${SUSPECTS} 名嫌疑人、${ROOMS} 个房间。每次最多 2 个请求（输出上限 ${SKELETON_OUTPUT_TOKENS} 和 ${PEOPLE_OUTPUT_TOKENS} 个 token）。总共最多 ${ATTEMPTS.length * 2} 个请求，且只此一次。`,
);
const paidOpen = Boolean((await runtime.store.totals(envelope)).paidAllowed);
/** Why nothing can be sent right now, or null when a run would send. */
const blocked: [string, string] | null =
  unresolved.length > 0
    ? ["blocked: requests of this trial are unresolved", "受阻：本试验有请求结果不明"]
    : !paidOpen
      ? ["blocked: paid requests are not authorized", "受阻：未授权付费请求"]
      : null;
for (const a of plan) {
  const state =
    a.standing.kind === "closed"
      ? both(`closed: ${a.standing.why[0]}`, `已关闭：${a.standing.why[1]}`)
      : blocked
        ? both(...blocked)
        : a.standing.kind === "resume"
          ? both("would resume from its saved skeleton: 1 request", "将从已保存的骨架继续：1 个请求")
          : both("would run: 2 requests", "将会执行：2 个请求");
  console.log(`  ${a.id}  ${state}  |  ${a.theme}`);
}
if (unresolved.length > 0) {
  say(
    `${unresolved.length} request(s) of this trial have an unknown outcome (${unresolved.map((a) => `${a.attemptId}: ${a.state}`).join(", ")}). Reconcile them with the dashboard first (npm run spend -- attempts). A run now would send nothing.`,
    `本试验有 ${unresolved.length} 个请求结果不明（${unresolved.map((a) => `${a.attemptId}: ${a.state}`).join("，")}）。请先对照后台核对（npm run spend -- attempts）。现在运行不会发送任何内容。`,
  );
} else if (!paidOpen) {
  say(`Paid requests are not authorized, so a run now would send nothing. Once a person authorizes them, a run would send at most ${most} request(s).`, `未授权付费请求，现在运行不会发送任何内容。经人授权后，一次运行最多发送 ${most} 个请求。`);
} else {
  say(`A run now would send at most ${most} request(s).`, `现在运行最多发送 ${most} 个请求。`);
}

if (process.argv.includes("--plan")) {
  await runtime.close();
  process.exit(0);
}

if (unresolved.length > 0) {
  await runtime.close();
  process.exit(1);
}
const before = await runtime.store.totals(envelope);
if (!before.paidAllowed) {
  say("Paid requests are not authorized on this envelope. Nothing was sent.", "该额度未授权付费请求。未发送任何内容。");
  await runtime.close();
  process.exit(1);
}
say(`Envelope "${envelope}": ${usd(before.committedNano)} committed before the run.`, `额度 "${envelope}"：运行前已占用 ${usd(before.committedNano)}。`);

mkdirSync(DIR, { recursive: true });
const reports: { id: string; theme: string; ms: number; report: WriteReport }[] = [];
for (const a of plan) {
  if (a.standing.kind === "closed") continue;
  console.log(`\n${a.id}  ${a.theme}${a.standing.kind === "resume" ? `  ${both("(from its saved skeleton)", "（从已保存的骨架继续）")}` : ""}`);
  const startedAt = Date.now();
  const report = await writeCase({
    metered: runtime.metered,
    attemptId: a.id,
    brief: { theme: a.theme, suspects: SUSPECTS, rooms: ROOMS },
    ...(a.standing.kind === "resume" ? { skeleton: JSON.parse(readFileSync(savedSkeleton(a.id), "utf8")) as unknown } : {}),
    // Saved before anything judges it: a reply that was paid for is never thrown away.
    onReply: (stage, value) => writeFileSync(`${DIR}/${a.id}.${stage}.json`, `${JSON.stringify(value, null, 2)}\n`),
  });
  const ms = Date.now() - startedAt;
  reports.push({ id: a.id, theme: a.theme, ms, report });
  for (const u of report.usage) console.log(`  ${u.step.padEnd(16)} in ${u.inputTokens} (cached ${u.cachedTokens}) | out ${u.outputTokens} (reasoning ${u.reasoningTokens ?? "?"}) | finish ${u.finishReason ?? "?"}`);
  console.log(`  ${report.accepted ? both("ACCEPTED", "通过") : both(`refused at: ${report.failedAt}`, `未通过，停在：${report.failedAt}`)} | ${report.requests} request(s) | ${usd(report.costNano)} | ${ms} ms`);
  for (const reason of report.reasons.slice(0, 12)) console.log(`    - ${reason}`);
  if (report.reasons.length > 12) console.log(`    - (${report.reasons.length - 12} more)`);
  for (const note of report.notes) console.log(`    note: ${note}`);
  if (report.case) {
    const c = report.case;
    console.log(`  ${c.title.en} · ${c.title.zh} | ${c.suspects.length} suspects, ${c.locations.length} rooms`);
    if (report.quality) console.log(`  shortlist ${report.quality.shortlist.length} | proof ${report.quality.proofActions} actions, ${report.quality.interviews} interview(s)`);
  }
  // The file holds whatever the attempt got to. If that is a case, it holds the answer. The folder is ignored by git.
  writeFileSync(
    `${DIR}/${a.id}.json`,
    `${JSON.stringify({ accepted: report.accepted, failedAt: report.failedAt ?? null, problem: report.problem ?? null, reasons: report.reasons, notes: report.notes, quality: report.quality ?? null, usage: report.usage, case: report.case ?? null }, null, 2)}\n`,
  );
  if (report.problem) {
    say(`STOPPED: ${report.problem}. No further attempt is started.`, `已停止：${report.problem}。不再开始后面的尝试。`);
    break;
  }
}

console.log();
say("Summary", "汇总");
const accepted = reports.filter((r) => r.report.accepted).length;
const requests = reports.reduce((sum, r) => sum + r.report.requests, 0);
const cost = reports.reduce((sum, r) => sum + r.report.costNano, 0);
for (const r of reports) {
  console.log(`  ${r.id}  ${r.report.accepted ? "accepted" : `refused at ${r.report.failedAt}`}  ${r.report.requests} request(s)  ${usd(r.report.costNano)}  ${r.ms} ms`);
  for (const note of r.report.notes) console.log(`      note: ${note}`);
}
say(`${reports.length} attempt(s) started, ${accepted} accepted. ${requests} request(s), ${usd(cost)} confirmed.`, `开始了 ${reports.length} 次尝试，通过 ${accepted} 次。共 ${requests} 个请求，已确认费用 ${usd(cost)}。`);
const after = await runtime.store.totals(envelope);
say(
  `Envelope now: settled ${usd(after.settledNano)}, kept for unknown outcomes ${usd(after.retainedNano)}, committed ${usd(after.committedNano)}.${after.suspended ? ` SUSPENDED: ${after.suspended}` : ""}`,
  `额度现状：已结算 ${usd(after.settledNano)}，结果不明而保留 ${usd(after.retainedNano)}，已占用 ${usd(after.committedNano)}。${after.suspended ? "额度已停用。" : ""}`,
);
await runtime.close();
process.exit(reports.some((r) => r.report.problem) ? 1 : 0);
