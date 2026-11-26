/**
 * A paid pilot: write a few cases, then let the detective play each one.
 * 付费试跑：先写几份案件，再让侦探逐个去破。
 *
 *   npm run pilot -- --plan   say exactly what a run would send now; sends nothing
 *   npm run pilot             run it (needs `npm run spend -- allow-paid "..."` first)
 *
 * What runs, what is saved and what may be picked up again is decided in src/writer/pilot.ts
 * and src/writer/trial.ts, which are tested without a model. This file connects them to the
 * real spend guard and prints.
 *
 * The cap is in the request ids. An attempt's are "<id>:skeleton", "<id>:people" and
 * "<id>:d1" to "<id>:d<maxTurns>", and the spend store sends an id once, ever. What has gone
 * out is read from the store's durable records. Every reply is saved as it arrives. A game
 * that has been started is never started again. The run stops at the first request that is
 * refused, fails, or comes back unconfirmed.
 *
 * It uses the "local" envelope only. Whether it may run at all is a person's decision, made
 * by authorizing paid requests; nothing in this file grants that.
 */
import { createRuntime } from "../src/runtime";
import { nanoToUsd } from "../src/spend/pricing";
import { pilotTotals, planPilot, runCounts, runPilot, type PilotConfig } from "../src/writer/pilot";
import { both, say } from "./say";

const PILOT_ENVELOPE = "local";
const config: PilotConfig = {
  attempts: [
    { id: "pilot-a-1", theme: "a vineyard house on the last night of harvest" },
    { id: "pilot-a-2", theme: "a mountain railway hotel during an avalanche warning" },
    { id: "pilot-a-3", theme: "a glassworks on the evening of a royal commission" },
  ],
  suspects: 20,
  rooms: 6,
  dir: "cases/generated",
  // A careful player needs about eight turns: hear the keeper, read the rooms, accuse. Sixteen leaves room to wander.
  maxTurns: 16,
};
const usd = (nano: number) => `$${nanoToUsd(nano).toFixed(6)}`;

const runtime = await createRuntime(process.env);
const envelope = runtime.config.envelope;
if (envelope !== PILOT_ENVELOPE) {
  say(`This pilot uses the "${PILOT_ENVELOPE}" envelope only; this terminal is set to "${envelope}". Nothing was sent.`, `本试跑只使用额度 "${PILOT_ENVELOPE}"，当前终端设置的是 "${envelope}"。未发送任何内容。`);
  await runtime.close();
  process.exit(1);
}
const stored = await runtime.store.attempts(envelope);
const plan = planPilot(config, stored);
const paidOpen = Boolean((await runtime.store.totals(envelope)).paidAllowed);
const perAttempt = 2 + config.maxTurns;

say(
  `${config.attempts.length} attempts of ${config.suspects} suspects and ${config.rooms} rooms. Each sends at most ${perAttempt} requests: 2 to write the case, then up to ${config.maxTurns} detective turns. At most ${config.attempts.length * perAttempt} requests in all, ever.`,
  `共 ${config.attempts.length} 次尝试，每次 ${config.suspects} 名嫌疑人、${config.rooms} 个房间。每次最多 ${perAttempt} 个请求：2 个用于写案件，之后侦探最多 ${config.maxTurns} 轮。总共最多 ${config.attempts.length * perAttempt} 个请求，且只此一次。`,
);
const blocked: [string, string] | null =
  plan.unresolved.length > 0
    ? ["blocked: requests of this pilot are unresolved", "受阻：本试跑有请求结果不明"]
    : !paidOpen
      ? ["blocked: paid requests are not authorized", "受阻：未授权付费请求"]
      : null;
for (const row of plan.rows) {
  const writer = row.writer.kind === "closed" ? `writer closed (${row.writer.why[0]})` : row.writer.kind === "resume" ? "writer: 1 request from its saved skeleton" : "writer: 2 requests";
  const game = row.game.kind === "closed" ? `game closed (${row.game.why[0]})` : `game: up to ${row.game.most} requests`;
  const state = row.most === 0 ? both("nothing to send", "没有可发送的") : blocked ? both(...blocked) : both(`would send up to ${row.most}`, `最多发送 ${row.most} 个`);
  console.log(`  ${row.attempt.id}  ${state}  |  ${writer}; ${game}  |  ${row.attempt.theme}`);
}
const most = plan.rows.reduce((sum, r) => sum + r.most, 0);
if (plan.unresolved.length > 0) {
  say(
    `${plan.unresolved.length} request(s) of this pilot have an unknown outcome (${plan.unresolved.map((a) => `${a.attemptId}: ${a.state}`).join(", ")}). Reconcile them with the dashboard first (npm run spend -- attempts). A run now would send nothing.`,
    `本试跑有 ${plan.unresolved.length} 个请求结果不明（${plan.unresolved.map((a) => `${a.attemptId}: ${a.state}`).join("，")}）。请先对照后台核对（npm run spend -- attempts）。现在运行不会发送任何内容。`,
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

const run = await runPilot(config, {
  metered: runtime.metered,
  // Read again once this run holds the lock: the plan printed above was made before it.
  stored: () => runtime.store.attempts(envelope),
  onEntry: ({ attempt, writer, game, ms }) => {
    console.log(`\n${attempt.id}  ${attempt.theme}  (${ms} ms)`);
    if (writer) {
      for (const u of writer.usage) console.log(`  ${u.step.padEnd(16)} in ${u.inputTokens} (cached ${u.cachedTokens}) | out ${u.outputTokens} (reasoning ${u.reasoningTokens ?? "?"}) | finish ${u.finishReason ?? "?"}`);
      console.log(`  ${writer.accepted ? both("case ACCEPTED", "案件通过") : both(`case refused at: ${writer.failedAt}`, `案件未通过，停在：${writer.failedAt}`)} | ${writer.requests} request(s) | ${usd(writer.costNano)}`);
      for (const reason of writer.reasons.slice(0, 8)) console.log(`    - ${reason}`);
      for (const note of writer.notes) console.log(`    note: ${note}`);
      if (writer.case) console.log(`  ${writer.case.title.en} · ${writer.case.title.zh}`);
    }
    if (game) {
      console.log(`  ${both(`detective: ${game.outcome}`, `侦探：${game.outcome}`)} | ${game.turns} turn(s), ${game.actions} action(s) | ${game.requests} request(s) | ${usd(game.costNano)}`);
      for (const step of game.steps) console.log(`    ${String(step.turn).padStart(2)}. ${step.used ? "" : "(not used) "}${step.did}`);
      if (game.verdict && game.outcome !== "solved") console.log(`    missing: ${game.verdict.missing.join(", ") || "nothing"} | not ruled out: ${game.verdict.open.length}`);
    }
  },
});
if (run.lockedBy) {
  say(`Another run of this pilot is already working in this folder (${run.lockedBy}). Nothing was sent.`, `另一个试跑进程正在这个文件夹里运行（${run.lockedBy}）。未发送任何内容。`);
  await runtime.close();
  process.exit(1);
}
if (run.blocked) {
  say("Requests of this pilot became unresolved before this run was admitted. Nothing was sent.", "在本次运行获准之前，本试跑已有请求结果不明。未发送任何内容。");
  await runtime.close();
  process.exit(1);
}
if (run.stoppedBy) say(`STOPPED: ${run.stoppedBy}. No further attempt was started.`, `已停止：${run.stoppedBy}。没有再开始后面的尝试。`);

console.log();
say("Summary", "汇总");
const counts = runCounts(run);
const requests = run.entries.reduce((sum, e) => sum + (e.writer?.requests ?? 0) + (e.game?.requests ?? 0), 0);
const cost = run.entries.reduce((sum, e) => sum + (e.writer?.costNano ?? 0) + (e.game?.costNano ?? 0), 0);
say(
  `THIS RUN ONLY: wrote ${counts.attempted}, of which accepted ${counts.accepted}; played ${counts.played}, of which solved ${counts.solved}. ${requests} request(s), ${usd(cost)} confirmed.`,
  `仅本次运行：写了 ${counts.attempted} 份，其中通过 ${counts.accepted} 份；对局 ${counts.played} 局，其中破案 ${counts.solved} 局。共 ${requests} 个请求，已确认费用 ${usd(cost)}。`,
);
// The state of the pilot, whichever runs did the work: made again from the saved replies and the store's records.
const totals = await pilotTotals(config, await runtime.store.attempts(envelope));
say(
  `THE PILOT SO FAR, rebuilt from the saved replies and the spend store: attempted ${totals.attempted}, accepted by the gates ${totals.accepted}, played ${totals.played}, solved ${totals.solved}.`,
  `试跑至今（由已保存的回复和额度存储重建）：尝试 ${totals.attempted}，通过关卡 ${totals.accepted}，已对局 ${totals.played}，破案 ${totals.solved}。`,
);
for (const row of totals.rows) console.log(`  ${row.id}  ${row.attempted ? "attempted" : "not attempted"}  ${row.accepted ? "accepted" : "not accepted"}  ${row.game}${row.turns ? ` in ${row.turns} turn(s)` : ""}${row.note ? `  (${row.note})` : ""}`);
const after = await runtime.store.totals(envelope);
say(
  `Envelope now: settled ${usd(after.settledNano)}, kept for unknown outcomes ${usd(after.retainedNano)}, committed ${usd(after.committedNano)}.${after.suspended ? ` SUSPENDED: ${after.suspended}` : ""}`,
  `额度现状：已结算 ${usd(after.settledNano)}，结果不明而保留 ${usd(after.retainedNano)}，已占用 ${usd(after.committedNano)}。${after.suspended ? "额度已停用。" : ""}`,
);
await runtime.close();
process.exit(run.stoppedBy ? 1 : 0);
