/**
 * The record of a finished trial: whole suspect turns against the real model, Nov 25, 2026.
 * 一次已结束的试验的记录：2026 年 11 月 25 日，用真实模型跑完整的嫌疑人问答。
 *
 *   npm run trial:turn    print what was sent and what the local trace recorded
 *
 * This experiment is closed. This script reads; it cannot send anything. It builds no
 * request, opens no connection and never touches the spend guard. It stays in the repo so
 * that the request ids of the trial and what each one tested are written down next to the
 * trace they appear in.
 *
 * Why it is closed rather than resumable: its cap of eight requests was counted from the
 * local trace file, and a trace write is allowed to fail without failing the request. A
 * count taken from the trace can therefore be too low. A future trial has to count from the
 * spend store's own durable attempt records.
 */
import { existsSync, readFileSync } from "node:fs";
import { nanoToUsd } from "../src/spend/pricing";
import { both, say } from "./say";

const PREFIX = "turn-c";
const usd = (nano: number) => `$${nanoToUsd(nano).toFixed(6)}`;

/** What each item of the trial sent, and what came of it. */
const record: { id: string; requests: string[]; what: [en: string, zh: string]; result: [en: string, zh: string] }[] = [
  {
    id: `${PREFIX}-1`,
    requests: ["answer"],
    what: ["Ada, a topic picked from the menu, English. The answer followed a tool call whose id code made up", "艾达，从菜单选话题，英文。作答前的工具调用编号由代码生成"],
    result: ["accepted by the API; the model's line passed the guard", "接口接受；模型的台词通过守卫"],
  },
  {
    id: `${PREFIX}-2`,
    requests: ["answer"],
    what: ["Ben, a topic picked from the menu, Chinese", "欧本，从菜单选话题，中文"],
    result: ["accepted; the model's line passed the guard", "接口接受；模型的台词通过守卫"],
  },
  {
    id: `${PREFIX}-3`,
    requests: ["retry-shape"],
    what: ["Ada, a retry whose note was a user message after the tool result", "艾达，重试提示作为用户消息放在工具结果之后"],
    result: ["accepted, but the reply was text repeated to the output limit, not the JSON object", "接口接受，但回复不是 JSON，而是同一句话重复到输出上限"],
  },
  {
    id: `${PREFIX}-4`,
    requests: ["recall", "answer"],
    what: ["Ada, a typed question that invites inventing a witness: the whole loop", "艾达，一个诱导编造证人的自由提问：完整循环"],
    result: ["the model chose the right topic, invented no witness, and its line passed the guard", "模型选对了话题，没有编造证人，台词通过守卫"],
  },
  {
    id: `${PREFIX}-5`,
    requests: ["retry-shape"],
    what: ["Ada, the same retry request once more", "艾达，同样的重试请求再发一次"],
    result: ["a usable reply that passed the guard, close to the output limit", "回复可用并通过守卫，接近输出上限"],
  },
  {
    id: `${PREFIX}-6`,
    requests: ["retry-shape"],
    what: ["Ada, the retry note carried inside the tool result", "艾达，把重试提示放进工具结果里"],
    result: ["a usable reply that passed the guard. The turn loop now builds its retry this way", "回复可用并通过守卫。问答循环现在这样构造重试"],
  },
];

say("This trial is closed. Nothing can be sent from this script.", "本试验已结束。此脚本不能发送任何内容。");
say("Seven requests were sent in two runs: items 1 to 4, then items 5 and 6.", "共发出七次请求，分两次运行：先是第 1 到 4 项，然后是第 5、6 项。");
for (const item of record) {
  console.log(`\n${item.id}  ${item.requests.map((r) => `${item.id}:${r}`).join(", ")}`);
  console.log(`  ${both(...item.what)}`);
  console.log(`  ${both(...item.result)}`);
}

// What the local trace holds for this trial. The trace has no prompt or reply text in it.
interface TraceLine {
  attemptId: string;
  step: string;
  outcome: string;
  costNano: number;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}
const envelope = process.env.SPEND_ENVELOPE?.trim();
const tracePath = `traces/${envelope}.trace.jsonl`;
console.log();
if (!envelope || !existsSync(tracePath)) {
  say("No local trace was found, so there are no token counts to show here.", "没有找到本地记录文件，因此这里没有 token 数可显示。");
} else {
  say("Requests of this trial in the local trace", "本地记录文件中属于本试验的请求");
  const lines = readFileSync(tracePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceLine)
    .filter((e) => e.attemptId.startsWith(`${PREFIX}-`));
  const pad = (value: number | undefined, width: number) => String(value ?? "-").padStart(width);
  for (const e of lines) {
    console.log(`  ${e.attemptId.padEnd(22)} ${e.step.padEnd(15)} ${e.outcome.padEnd(16)} in ${pad(e.inputTokens, 5)} cached ${pad(e.cachedTokens, 5)} out ${pad(e.outputTokens, 4)} reasoning ${pad(e.reasoningTokens, 4)}  ${usd(e.costNano)}`);
  }
  const priced = lines.reduce((sum, e) => sum + e.costNano, 0);
  say(`${lines.length} line(s), ${usd(priced)} priced. The trace is a local convenience; the spend store is the record that counts.`, `共 ${lines.length} 行，计费 ${usd(priced)}。记录文件只是本地的方便之物，算数的是额度存储里的记录。`);
}
