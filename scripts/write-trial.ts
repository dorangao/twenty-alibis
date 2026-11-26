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
 * An attempt whose skeleton id is already in the store is not started again, finished or
 * not: its skeleton reply is gone, so the people request could not be built from it.
 * The run stops at the first request that is refused, fails, or comes back unconfirmed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRuntime } from "../src/runtime";
import { nanoToUsd } from "../src/spend/pricing";
import { PEOPLE_OUTPUT_TOKENS, SKELETON_OUTPUT_TOKENS, writeCase, type WriteReport } from "../src/writer/write";
import { both, say } from "./say";

const SUSPECTS = 20;
const ROOMS = 6;
const ATTEMPTS: { id: string; theme: string }[] = [
  { id: "writer-a-1", theme: "a mountain observatory cut off by snow" },
  { id: "writer-a-2", theme: "a river steamer moored for the night" },
  { id: "writer-a-3", theme: "a tea estate house during the monsoon" },
];
const usd = (nano: number) => `$${nanoToUsd(nano).toFixed(6)}`;

const runtime = await createRuntime(process.env);
const envelope = runtime.config.envelope;
const known = new Set((await runtime.store.attempts(envelope)).map((a) => a.attemptId));
const started = (id: string) => known.has(`${id}:skeleton`) || known.has(`${id}:people`);
const todo = ATTEMPTS.filter((a) => !started(a.id));

say(
  `${ATTEMPTS.length} attempts of ${SUSPECTS} suspects and ${ROOMS} rooms. Each sends at most 2 requests (output limits ${SKELETON_OUTPUT_TOKENS} and ${PEOPLE_OUTPUT_TOKENS} tokens). At most ${ATTEMPTS.length * 2} requests in all, ever.`,
  `共 ${ATTEMPTS.length} 次尝试，每次 ${SUSPECTS} 名嫌疑人、${ROOMS} 个房间。每次最多 2 个请求（输出上限 ${SKELETON_OUTPUT_TOKENS} 和 ${PEOPLE_OUTPUT_TOKENS} 个 token）。总共最多 ${ATTEMPTS.length * 2} 个请求，且只此一次。`,
);
for (const a of ATTEMPTS) {
  const state = started(a.id) ? both("already started, will not be sent again", "此前已开始，不会重发") : both("would run", "将会执行");
  console.log(`  ${a.id}  ${state}  |  ${a.theme}`);
}
say(`A run now would send at most ${todo.length * 2} request(s).`, `现在运行最多发送 ${todo.length * 2} 个请求。`);

if (process.argv.includes("--plan")) {
  await runtime.close();
  process.exit(0);
}

const before = await runtime.store.totals(envelope);
if (!before.paidAllowed) {
  say("Paid requests are not authorized on this envelope. Nothing was sent.", "该额度未授权付费请求。未发送任何内容。");
  await runtime.close();
  process.exit(1);
}
say(`Envelope "${envelope}": ${usd(before.committedNano)} committed before the run.`, `额度 "${envelope}"：运行前已占用 ${usd(before.committedNano)}。`);

mkdirSync("cases/generated", { recursive: true });
const reports: { id: string; theme: string; ms: number; report: WriteReport }[] = [];
for (const a of todo) {
  console.log(`\n${a.id}  ${a.theme}`);
  const startedAt = Date.now();
  const report = await writeCase({ metered: runtime.metered, attemptId: a.id, brief: { theme: a.theme, suspects: SUSPECTS, rooms: ROOMS } });
  const ms = Date.now() - startedAt;
  reports.push({ id: a.id, theme: a.theme, ms, report });
  for (const u of report.usage) console.log(`  ${u.step.padEnd(16)} in ${u.inputTokens} (cached ${u.cachedTokens}) | out ${u.outputTokens} (reasoning ${u.reasoningTokens ?? "?"}) | finish ${u.finishReason ?? "?"}`);
  console.log(`  ${report.accepted ? both("ACCEPTED", "通过") : both(`refused at: ${report.failedAt}`, `未通过，停在：${report.failedAt}`)} | ${report.requests} request(s) | ${usd(report.costNano)} | ${ms} ms`);
  for (const reason of report.reasons.slice(0, 12)) console.log(`    - ${reason}`);
  if (report.case) {
    const c = report.case;
    console.log(`  ${c.title.en} · ${c.title.zh} | ${c.suspects.length} suspects, ${c.locations.length} rooms`);
    if (report.quality) console.log(`  shortlist ${report.quality.shortlist.length} | proof ${report.quality.proofActions} actions, ${report.quality.interviews} interview(s)`);
    // The file holds the whole case, answer included. The folder is ignored by git.
    writeFileSync(`cases/generated/${a.id}.json`, `${JSON.stringify({ accepted: report.accepted, failedAt: report.failedAt ?? null, reasons: report.reasons, case: c }, null, 2)}\n`);
  }
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
for (const r of reports) console.log(`  ${r.id}  ${r.report.accepted ? "accepted" : `refused at ${r.report.failedAt}`}  ${r.report.requests} request(s)  ${usd(r.report.costNano)}  ${r.ms} ms`);
say(`${reports.length} attempt(s) started, ${accepted} accepted. ${requests} request(s), ${usd(cost)} confirmed.`, `开始了 ${reports.length} 次尝试，通过 ${accepted} 次。共 ${requests} 个请求，已确认费用 ${usd(cost)}。`);
const after = await runtime.store.totals(envelope);
say(
  `Envelope now: settled ${usd(after.settledNano)}, kept for unknown outcomes ${usd(after.retainedNano)}, committed ${usd(after.committedNano)}.${after.suspended ? ` SUSPENDED: ${after.suspended}` : ""}`,
  `额度现状：已结算 ${usd(after.settledNano)}，结果不明而保留 ${usd(after.retainedNano)}，已占用 ${usd(after.committedNano)}。${after.suspended ? "额度已停用。" : ""}`,
);
await runtime.close();
process.exit(reports.some((r) => r.report.problem) ? 1 : 0);
