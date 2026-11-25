/**
 * A paid trial of whole suspect turns: the real loop, the real guard, the real model.
 * 付费试验：完整的嫌疑人问答，真实的循环、真实的守卫、真实的模型。
 *
 *   npm run trial:turn            run it (needs `npm run spend -- allow-paid "..."` first)
 *   npm run trial:turn -- --plan  list what it would send, without sending anything
 *
 * It sends at most MAX_REQUESTS requests, counted here as well as by the spend guard, and
 * stops at the first request that is refused or fails. Each request id can be sent once,
 * ever: running the trial again sends nothing that already went out.
 */
import { existsSync, readFileSync } from "node:fs";
import { guardLine } from "../src/agents/line-guard";
import { recallResult, suspectAnswerSchema, suspectSystemMessages } from "../src/agents/suspect-prompt";
import { ANSWER_OUTPUT_TOKENS, retryNote, SUSPECT_PROMPT_ID, suspectTurn, type SuspectTurn } from "../src/agents/suspect-turn";
import { startingHeld } from "../src/case/access";
import { archivePass } from "../src/case/fixtures/archive";
import type { Metered } from "../src/metered";
import { createRuntime } from "../src/runtime";
import { nanoToUsd } from "../src/spend/pricing";
import { both, say } from "./say";

const c = archivePass;
const held = startingHeld(c);
const PREFIX = "turn-c";
/** The most requests this trial may send, over all of its runs, whatever the model does. */
const MAX_REQUESTS = 8;
const usd = (nano: number) => `$${nanoToUsd(nano).toFixed(6)}`;

interface Item {
  id: string;
  what: [en: string, zh: string];
  /** The most requests this item can send. */
  most: number;
  run(metered: Metered): Promise<{ stop: boolean }>;
}

const showTurn = (turn: SuspectTurn): { stop: boolean } => {
  const statements = turn.statements.map((s) => s.assertion).join(", ") || "none";
  console.log(`  topic ${turn.topic ?? "none"} | statements ${statements} | source ${turn.source} | requests ${turn.requests} | ${usd(turn.costNano)}`);
  console.log(`  line: ${turn.line}`);
  for (const r of turn.rejections) console.log(`  refused line from ${r.from}: ${r.reason}${r.detail ? ` (${r.detail})` : ""}`);
  if (turn.problem) console.log(`  ${both(`PROBLEM: ${turn.problem}`, `问题：${turn.problem}`)}`);
  return { stop: turn.problem !== undefined };
};

const turnItem = (n: number, what: Item["what"], most: number, args: { suspect: string; question: string; topic?: string }): Item => ({
  id: `${PREFIX}-${n}`,
  what,
  most,
  run: async (metered) => showTurn(await suspectTurn({ metered, c, held, turnId: `${PREFIX}-${n}`, cacheKey: `case:${c.id}`, ...args })),
});

/**
 * One retry request, built by hand so that it is sent whatever the model's first line was.
 *   user-message  the note follows the tool result as a user message
 *   tool-result   the note is a field of the tool result, so the request ends the way an ordinary answer request does
 */
const retryItem = (n: number, where: "user-message" | "tool-result", what: Item["what"]): Item => ({
  id: `${PREFIX}-${n}`,
  what,
  most: 1,
  run: async (metered) => {
    const call = { id: "call_topic", name: "recall", arguments: JSON.stringify({ topic: "t-ada-2100" }) };
    const note = retryNote("en", { from: "answer", reason: "exclusive", detail: "Alone" });
    const recalled = recallResult(c, "s-ada", "t-ada-2100", held);
    const result = await metered({
      step: "suspect.retry",
      promptId: SUSPECT_PROMPT_ID,
      attemptId: `${PREFIX}-${n}:retry-shape`,
      cacheKey: `case:${c.id}`,
      messages: [
        ...suspectSystemMessages(c, "s-ada"),
        { role: "user", content: "Where were you at 21:00?" },
        { role: "assistant", content: "", toolCalls: [call] },
        ...(where === "user-message"
          ? [
              { role: "tool" as const, toolCallId: call.id, content: recalled },
              { role: "user" as const, content: note },
            ]
          : [{ role: "tool" as const, toolCallId: call.id, content: JSON.stringify({ ...(JSON.parse(recalled) as object), note }) }]),
      ],
      responseSchema: suspectAnswerSchema,
      maxOutputTokens: ANSWER_OUTPUT_TOKENS,
    });
    if (!result.ok) {
      const why = result.sent ? "failed:outcome-unknown" : `refused:${result.reason}`;
      console.log(`  ${both(`PROBLEM: ${why}`, `问题：${why}`)}`);
      return { stop: true };
    }
    const u = result.response.usage;
    console.log(`  finish ${result.response.finishReason ?? "?"} | in ${u?.inputTokens} (cached ${u?.cachedTokens}) | out ${u?.outputTokens} (reasoning ${u?.reasoningTokens ?? "?"}) | ${usd(result.costNano)}`);
    console.log(`  text: ${(result.response.text ?? "").replace(/\s+/g, " ").slice(0, 400)}`);
    try {
      const parsed = JSON.parse(result.response.text ?? "") as { assertions: string[]; line: string };
      const accepted = c.assertions.filter((a) => a.id === "a-ada-foyer-2100");
      console.log(`  claimed: ${parsed.assertions.join(", ") || "none"} | guard: ${JSON.stringify(guardLine(c, "s-ada", accepted, parsed.line, "en"))}`);
    } catch {
      console.log(`  ${both("the reply is not the JSON object asked for", "回复不是所要求的 JSON 对象")}`);
    }
    return { stop: !result.settled || result.breached };
  },
});

const items: Item[] = [
  turnItem(1, ["Ada, topic picked from the menu, English: the answer follows a tool call whose id code made up", "艾达，从菜单选话题，英文：作答前的工具调用编号由代码生成"], 2, {
    suspect: "s-ada",
    topic: "t-ada-2100",
    question: "Where were you at 21:00?",
  }),
  turnItem(2, ["Ben, topic picked from the menu, Chinese", "欧本，从菜单选话题，中文"], 2, { suspect: "s-ben", topic: "t-ben-2100", question: "21:00 你在哪里？" }),
  retryItem(3, "user-message", [
    "Ada, the retry request as the loop first built it: a note from the game as a user message after the tool result",
    "艾达，按循环最初的方式构造重试请求：工具结果之后附一条来自游戏的提示",
  ]),
  turnItem(4, ["Ada, a typed question that invites inventing a witness: the whole loop, the model chooses the topic", "艾达，一个诱导编造证人的自由提问：完整循环，由模型选话题"], 3, {
    suspect: "s-ada",
    question: "Did anyone see you in the foyer at 21:00?",
  }),
  // Added after the first run: item 3 was accepted by the API but its reply was not usable.
  retryItem(5, "user-message", ["Ada, the same retry request once more: does the unusable reply repeat?", "艾达，同样的重试请求再发一次：不可用的回复会重现吗？"]),
  retryItem(6, "tool-result", ["Ada, the retry note carried inside the tool result instead", "艾达，改为把重试提示放进工具结果里"]),
];

if (process.argv.includes("--plan")) {
  say(`${items.length} items, at most ${MAX_REQUESTS} requests. Nothing is sent.`, `${items.length} 项，最多 ${MAX_REQUESTS} 次请求。不会发送任何内容。`);
  for (const i of items) console.log(`  ${i.id}  (max ${i.most})  ${both(...i.what)}`);
  process.exit(0);
}

const runtime = await createRuntime(process.env);
const before = await runtime.store.totals(runtime.config.envelope);
if (!before.paidAllowed) {
  say("Paid requests are not authorized on this envelope. Nothing was sent.", "该额度未授权付费请求。未发送任何内容。");
  await runtime.close();
  process.exit(1);
}
say(`Envelope "${runtime.config.envelope}": ${usd(before.committedNano)} committed before the run.`, `额度 "${runtime.config.envelope}"：运行前已占用 ${usd(before.committedNano)}。`);

// A second count, independent of the spend guard: past the cap, a request is refused here.
// It starts from what earlier runs of this trial already sent, so the cap holds across runs.
const earlierPath = `traces/${runtime.config.envelope}.trace.jsonl`;
const earlier = existsSync(earlierPath)
  ? readFileSync(earlierPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { attemptId: string; outcome: string })
      .filter((e) => e.attemptId.startsWith(`${PREFIX}-`) && ["settled", "settle-pending", "retained"].includes(e.outcome))
  : [];
/** An item is done once any request of it has left this machine. It is not run again. */
const doneEarlier = (item: Item) => earlier.some((e) => e.attemptId.startsWith(`${item.id}:`));
let passed = earlier.length;
const stillToRun = items.filter((i) => !doneEarlier(i));
say(`${passed} of at most ${MAX_REQUESTS} requests were sent by earlier runs.`, `此前的运行已发送 ${passed} 次，上限 ${MAX_REQUESTS} 次。`);
if (passed + stillToRun.reduce((sum, i) => sum + i.most, 0) > MAX_REQUESTS) {
  say("The remaining items could go past the cap. Nothing was sent.", "剩余各项可能超过上限。未发送任何内容。");
  await runtime.close();
  process.exit(1);
}
const capped: Metered = async (request) => {
  if (passed >= MAX_REQUESTS) return { ok: false, attemptId: request.attemptId, sent: false, reason: "kill-switch" };
  passed++;
  return runtime.metered(request);
};

let stopped = false;
for (const item of items) {
  console.log(`\n${item.id}  ${both(...item.what)}`);
  if (doneEarlier(item)) {
    console.log(`  ${both("sent in an earlier run (not sent again)", "此前已发送（本次未重发）")}`);
    continue;
  }
  if (stopped) {
    console.log(`  ${both("not reached (the run stopped before it)", "未执行（运行已提前停止）")}`);
    continue;
  }
  stopped = (await item.run(capped)).stop;
}

// What the trace recorded for this trial: one line per request. The trace holds no prompt or reply text.
console.log();
say("Requests, from the trace", "各次请求（取自记录文件）");
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
const tracePath = `traces/${runtime.config.envelope}.trace.jsonl`;
const lines: TraceLine[] = existsSync(tracePath)
  ? readFileSync(tracePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceLine)
      .filter((e) => e.attemptId.startsWith(`${PREFIX}-`))
  : [];
const pad = (value: number | undefined, width: number) => String(value ?? "-").padStart(width);
for (const e of lines) {
  console.log(`  ${e.attemptId.padEnd(22)} ${e.step.padEnd(15)} ${e.outcome.padEnd(26)} in ${pad(e.inputTokens, 5)} cached ${pad(e.cachedTokens, 5)} out ${pad(e.outputTokens, 4)} reasoning ${pad(e.reasoningTokens, 4)}  ${usd(e.costNano)}`);
}
const sent = lines.filter((e) => e.outcome === "settled" || e.outcome === "settle-pending" || e.outcome === "retained");
const priced = sent.reduce((sum, e) => sum + e.costNano, 0);
say(`${sent.length} request(s) left this machine across all runs of this trial, ${usd(priced)} priced.`, `本试验历次运行共有 ${sent.length} 次请求发出，计费 ${usd(priced)}。`);

const after = await runtime.store.totals(runtime.config.envelope);
say(
  `Envelope now: settled ${usd(after.settledNano)}, kept for unknown outcomes ${usd(after.retainedNano)}, committed ${usd(after.committedNano)}.${after.suspended ? ` SUSPENDED: ${after.suspended}` : ""}`,
  `额度现状：已结算 ${usd(after.settledNano)}，结果不明而保留 ${usd(after.retainedNano)}，已占用 ${usd(after.committedNano)}。${after.suspended ? "额度已停用。" : ""}`,
);
if (stopped) say("STOPPED EARLY: see the problem above.", "提前停止：见上方的问题。");
await runtime.close();
process.exit(stopped ? 1 : 0);
