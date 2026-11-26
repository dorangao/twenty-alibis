/**
 * A paid trial of the case writer: a few fresh plots, each two requests, no repairs.
 * 案件生成器的付费试验：几份新剧情，每份两次请求，不做修补。
 *
 *   npm run trial:writer -- --plan   say exactly what a run would send now; sends nothing
 *   npm run trial:writer             run it (needs `npm run spend -- allow-paid "..."` first)
 *
 * What runs, what is saved and what may be resumed is decided in src/writer/trial.ts, which
 * is tested without a model. This file connects it to the real spend guard and prints.
 *
 * The cap is in the request ids. Each attempt has two fixed ids ("<attempt>:skeleton",
 * "<attempt>:people"), and the spend store sends an id once, ever, however many times or
 * from however many terminals this script is started. What has already gone out is read
 * from the store's own durable records, not from the local trace.
 *
 * Every reply is saved the moment it arrives, exactly as it arrived, in cases/generated/.
 * An attempt whose skeleton went out but whose people request did not can be picked up from
 * its saved skeleton, if that file is intact, is this attempt's, was complete and confirmed,
 * and passes today's skeleton check. Otherwise the attempt is closed, and the plan says why.
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
import { createRuntime } from "../src/runtime";
import { nanoToUsd } from "../src/spend/pricing";
import { planTrial, runTrial, type TrialConfig } from "../src/writer/trial";
import { PEOPLE_OUTPUT_TOKENS, SKELETON_OUTPUT_TOKENS } from "../src/writer/write";
import { both, say } from "./say";

/** The one envelope this trial uses. The ids are once-only per envelope, so another envelope would be a second set. */
const TRIAL_ENVELOPE = "local";
const config: TrialConfig = {
  attempts: [
    { id: "writer-b-1", theme: "a mountain observatory cut off by snow" },
    { id: "writer-b-2", theme: "a river steamer moored for the night" },
    { id: "writer-b-3", theme: "a tea estate house during the monsoon" },
  ],
  suspects: 20,
  rooms: 6,
  dir: "cases/generated",
};
const usd = (nano: number) => `$${nanoToUsd(nano).toFixed(6)}`;

const runtime = await createRuntime(process.env);
const envelope = runtime.config.envelope;
if (envelope !== TRIAL_ENVELOPE) {
  say(`This trial uses the "${TRIAL_ENVELOPE}" envelope only; this terminal is set to "${envelope}". Nothing was sent.`, `本试验只使用额度 "${TRIAL_ENVELOPE}"，当前终端设置的是 "${envelope}"。未发送任何内容。`);
  await runtime.close();
  process.exit(1);
}
const stored = await runtime.store.attempts(envelope);
const plan = planTrial(config, stored);
const paidOpen = Boolean((await runtime.store.totals(envelope)).paidAllowed);

say(
  `${config.attempts.length} attempts of ${config.suspects} suspects and ${config.rooms} rooms. Each sends at most 2 requests (output limits ${SKELETON_OUTPUT_TOKENS} and ${PEOPLE_OUTPUT_TOKENS} tokens). At most ${config.attempts.length * 2} requests in all, ever.`,
  `共 ${config.attempts.length} 次尝试，每次 ${config.suspects} 名嫌疑人、${config.rooms} 个房间。每次最多 2 个请求（输出上限 ${SKELETON_OUTPUT_TOKENS} 和 ${PEOPLE_OUTPUT_TOKENS} 个 token）。总共最多 ${config.attempts.length * 2} 个请求，且只此一次。`,
);
/** Why nothing can be sent right now, or null when a run would send. */
const blocked: [string, string] | null =
  plan.unresolved.length > 0
    ? ["blocked: requests of this trial are unresolved", "受阻：本试验有请求结果不明"]
    : !paidOpen
      ? ["blocked: paid requests are not authorized", "受阻：未授权付费请求"]
      : null;
for (const { attempt, standing } of plan.rows) {
  const state =
    standing.kind === "closed"
      ? both(`closed: ${standing.why[0]}`, `已关闭：${standing.why[1]}`)
      : blocked
        ? both(...blocked)
        : standing.kind === "resume"
          ? both("would resume from its saved skeleton: 1 request", "将从已保存的骨架继续：1 个请求")
          : both("would run: 2 requests", "将会执行：2 个请求");
  console.log(`  ${attempt.id}  ${state}  |  ${attempt.theme}`);
}
/** What a run would send if nothing blocked it. */
const most = plan.rows.reduce((sum, r) => sum + r.standing.most, 0);
if (plan.unresolved.length > 0) {
  say(
    `${plan.unresolved.length} request(s) of this trial have an unknown outcome (${plan.unresolved.map((a) => `${a.attemptId}: ${a.state}`).join(", ")}). Reconcile them with the dashboard first (npm run spend -- attempts). A run now would send nothing.`,
    `本试验有 ${plan.unresolved.length} 个请求结果不明（${plan.unresolved.map((a) => `${a.attemptId}: ${a.state}`).join("，")}）。请先对照后台核对（npm run spend -- attempts）。现在运行不会发送任何内容。`,
  );
} else if (!paidOpen) {
  say(`Paid requests are not authorized, so a run now would send nothing. Once a person authorizes them, a run would send at most ${most} request(s).`, `未授权付费请求，现在运行不会发送任何内容。经人授权后，一次运行最多发送 ${most} 个请求。`);
} else {
  say(`A run now would send at most ${most} request(s).`, `现在运行最多发送 ${most} 个请求。`);
}

if (process.argv.includes("--plan") || plan.unresolved.length > 0) {
  await runtime.close();
  process.exit(process.argv.includes("--plan") ? 0 : 1);
}
if (!paidOpen) {
  say("Paid requests are not authorized on this envelope. Nothing was sent.", "该额度未授权付费请求。未发送任何内容。");
  await runtime.close();
  process.exit(1);
}
const before = await runtime.store.totals(envelope);
say(`Envelope "${envelope}": ${usd(before.committedNano)} committed before the run.`, `额度 "${envelope}"：运行前已占用 ${usd(before.committedNano)}。`);

const run = await runTrial(config, {
  metered: runtime.metered,
  stored,
  onAttempt: ({ attempt, resumed, ms, report }) => {
    console.log(`\n${attempt.id}  ${attempt.theme}${resumed ? `  ${both("(from its saved skeleton)", "（从已保存的骨架继续）")}` : ""}`);
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
  },
});
if (run.stoppedBy) say(`STOPPED: ${run.stoppedBy}. No further attempt was started.`, `已停止：${run.stoppedBy}。没有再开始后面的尝试。`);

console.log();
say("Summary", "汇总");
const accepted = run.reports.filter((r) => r.report.accepted).length;
const requests = run.reports.reduce((sum, r) => sum + r.report.requests, 0);
const cost = run.reports.reduce((sum, r) => sum + r.report.costNano, 0);
for (const r of run.reports) {
  console.log(`  ${r.attempt.id}  ${r.report.accepted ? "accepted" : `refused at ${r.report.failedAt}`}  ${r.report.requests} request(s)  ${usd(r.report.costNano)}  ${r.ms} ms`);
  for (const note of r.report.notes) console.log(`      note: ${note}`);
}
say(`${run.reports.length} attempt(s) started, ${accepted} accepted. ${requests} request(s), ${usd(cost)} confirmed.`, `开始了 ${run.reports.length} 次尝试，通过 ${accepted} 次。共 ${requests} 个请求，已确认费用 ${usd(cost)}。`);
const after = await runtime.store.totals(envelope);
say(
  `Envelope now: settled ${usd(after.settledNano)}, kept for unknown outcomes ${usd(after.retainedNano)}, committed ${usd(after.committedNano)}.${after.suspended ? ` SUSPENDED: ${after.suspended}` : ""}`,
  `额度现状：已结算 ${usd(after.settledNano)}，结果不明而保留 ${usd(after.retainedNano)}，已占用 ${usd(after.committedNano)}。${after.suspended ? "额度已停用。" : ""}`,
);
await runtime.close();
process.exit(run.stoppedBy ? 1 : 0);
