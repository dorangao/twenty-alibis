/**
 * Paid trial batches: a fixed list of requests to Muse Ember, sent one after another.
 * 付费试验批次：固定的一组请求，逐个发送给 Muse Ember。
 *
 *   npm run smoke -- --batch a          send batch a (needs `npm run spend -- allow-paid "..."` first)
 *   npm run smoke -- --batch a --plan   list its requests without sending anything
 *
 * Every request has a fixed id (smoke-<batch>-01 …) and an id can be sent once, ever: running
 * a batch again sends nothing that already went out. A batch stops at the first request that
 * fails, so one wrong field cannot use up the whole batch.
 *
 * The run ends with one line per request saying exactly what happened to it, and the exit
 * code is 0 only when every request was sent, confirmed and gave a usable reply.
 */
import { existsSync, readFileSync } from "node:fs";
import { publicBriefing, recallResult, recallTool, suspectAnswerSchema, suspectSystemMessages } from "../src/agents/suspect-prompt";
import { startingHeld } from "../src/case/access";
import { archivePass } from "../src/case/fixtures/archive";
import type { ChatMessage, ToolCall } from "../src/provider/types";
import { createRuntime } from "../src/runtime";
import { nanoToUsd } from "../src/spend/pricing";
import { runBatch, type TrialOutcome, type TrialStep } from "../src/trial/batch";
import { both, say } from "./say";

const c = archivePass;
// These trials question suspects at the start of a game: the player holds only the briefing.
const held = startingHeld(c);
const batchFlag = process.argv.indexOf("--batch");
const LABEL = batchFlag >= 0 ? String(process.argv[batchFlag + 1]) : "a";
const idOf = (n: number) => `smoke-${LABEL}-${String(n).padStart(2, "0")}`;
const usd = (nano: number) => `$${nanoToUsd(nano).toFixed(6)}`;

const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const text = { type: "string" };
const list = (items: unknown) => ({ type: "array", items });

// The case as the public knows it, without the suspect rules that precede it in a suspect's prompt.
const caseFacts = publicBriefing(c).split("THE CASE, AS EVERYONE KNOWS IT")[1]!.trim();

const detectiveSystem: ChatMessage = {
  role: "system",
  content: [
    "You are the detective in a murder-mystery game. You solve the case by asking suspects about topics and inspecting records.",
    "Only authenticated records can rule anyone out. What a suspect says can point you somewhere, but it proves nothing by itself.",
    "Choose exactly one next action. Accuse only when the records in your notebook prove one person and rule out every other.",
    "",
    "THE CASE",
    caseFacts,
  ].join("\n"),
};
const detectiveSchema = { name: "detective_action", schema: object({ action: { type: "string", enum: ["ask", "inspect", "accuse"] }, target: text, reason: text }) };
const detectiveTurn = `Notebook so far:
- Ada Marlow said: "I was in the foyer at 21:00."
- Ben Okafor said: "I was in the foyer at 21:00."
Actions you can take:
- ask t-ada-2100 (Ada Marlow: Where were you at 21:00?)
- ask t-ben-2100 (Ben Okafor: Where were you at 21:00?)
- inspect i-attendance-log (Inspect the door and desk logs)
- accuse <suspect id>
Choose the next action.`;

const gossipSchema = { name: "gossip", schema: object({ tell: list(object({ to: text, statement: text })) }) };
const gossipTurn = (said: string) => `It is a quiet moment between the detective's questions. You may repeat one thing you have already said to one other person in the house, or say nothing.
What you have said so far: ${said}
People you could speak to: ${c.suspects.map((s) => s.id).join(", ")}.
Reply with at most one entry: whom you tell, and the id of the statement you repeat. An empty list means you say nothing.`;

const writerSystem: ChatMessage = {
  role: "system",
  content: [
    "You write case files for a murder-mystery game. Output data only, in the requested JSON shape.",
    "Every name and description is given in English and in Simplified Chinese.",
    "Rooms connect to form one building. Each time slot is twenty minutes after the last.",
  ].join("\n"),
};
const skeletonSchema = {
  name: "case_skeleton",
  schema: object({
    title_en: text,
    title_zh: text,
    setting_en: text,
    setting_zh: text,
    slots: list(text),
    locations: list(object({ id: text, name_en: text, name_zh: text, adjacent: list(text) })),
    suspects: list(object({ id: text, name_en: text, name_zh: text, role_en: text, role_zh: text })),
  }),
};
const peopleSchema = {
  name: "case_people",
  schema: object({
    culprit: text,
    suspects: list(
      object({
        id: text,
        persona_en: text,
        persona_zh: text,
        whereabouts: list(object({ slot: text, location: text })),
        has_means: { type: "boolean" },
        motive_en: text,
        motive_zh: text,
      }),
    ),
  }),
};

type Step = TrialStep;

const ask = (suspect: string, question: string): ChatMessage[] => [...suspectSystemMessages(c, suspect), { role: "user", content: question }];
const afterRecall = (suspect: string, question: string, call: ToolCall): ChatMessage[] => {
  let topic = "none";
  try {
    topic = String(JSON.parse(call.arguments).topic);
  } catch {
    // unreadable arguments are treated as "none"
  }
  return [...ask(suspect, question), { role: "assistant", content: "", toolCalls: [call] }, { role: "tool", toolCallId: call.id, content: recallResult(c, suspect, topic, held) }];
};
/** A recall step is usable only if it is one call to recall with a topic that suspect has on its menu. */
const recallExpect = (suspect: string) => ({
  kind: "tool" as const,
  name: "recall",
  field: "topic",
  allowed: (recallTool(c, suspect, held).parameters as { properties: { topic: { enum: string[] } } }).properties.topic.enum,
});
const EN = "Where were you at 21:00?";
const ZH = "21:00 你在哪里？";

// ---- Batch a: are the fields right, and what does each kind of step cost? ----

const batchA: Step[] = [
  {
    n: 1,
    what: ["ping: smallest possible request", "连通测试：最小的请求"],
    build: () => ({ step: "smoke.ping", promptId: "ping-v1", messages: [{ role: "user", content: "Reply with the single word: ready" }], maxOutputTokens: 200 }),
  },
  {
    n: 2,
    what: ["suspect, English question: expect a recall tool call (effort low)", "嫌疑人，英文提问：应调用 recall（推理档位 low）"],
    build: () => ({ step: "suspect.recall", promptId: "suspect-v1", messages: ask("s-ada", EN), tools: [recallTool(c, "s-ada", held)], maxOutputTokens: 400 }),
    expect: recallExpect("s-ada"),
    after: (r, ctx) => (ctx.calls.en = r.toolCalls[0]),
  },
  {
    n: 3,
    what: ["suspect, English: answer after recall, structured (effort low)", "嫌疑人，英文：查询后作答，结构化输出（low）"],
    build: (ctx) => (ctx.calls.en ? { step: "suspect.answer", promptId: "suspect-v1", messages: afterRecall("s-ada", EN, ctx.calls.en), responseSchema: suspectAnswerSchema, maxOutputTokens: 400 } : null),
  },
  {
    n: 4,
    what: ["suspect, Chinese question: expect a recall tool call (effort minimal)", "嫌疑人，中文提问：应调用 recall（推理档位 minimal）"],
    build: () => ({ step: "suspect.recall", promptId: "suspect-v1", messages: ask("s-ada", ZH), tools: [recallTool(c, "s-ada", held)], maxOutputTokens: 400, reasoningEffort: "minimal" }),
    expect: recallExpect("s-ada"),
    after: (r, ctx) => (ctx.calls.zh = r.toolCalls[0]),
  },
  {
    n: 5,
    what: ["suspect, Chinese: answer after recall, structured (effort minimal)", "嫌疑人，中文：查询后作答，结构化输出（minimal）"],
    build: (ctx) =>
      ctx.calls.zh
        ? { step: "suspect.answer", promptId: "suspect-v1", messages: afterRecall("s-ada", ZH, ctx.calls.zh), responseSchema: suspectAnswerSchema, maxOutputTokens: 400, reasoningEffort: "minimal" }
        : null,
  },
  {
    n: 6,
    what: ["detective: choose the next action", "侦探：选择下一步行动"],
    build: () => ({ step: "detective.turn", promptId: "detective-v1", messages: [detectiveSystem, { role: "user", content: detectiveTurn }], responseSchema: detectiveSchema, maxOutputTokens: 400 }),
  },
  {
    n: 7,
    what: ["gossip: Ben decides whom to tell", "传闻：欧本决定告诉谁"],
    build: () => ({
      step: "gossip.turn",
      promptId: "gossip-v1",
      messages: [...suspectSystemMessages(c, "s-ben"), { role: "user", content: gossipTurn('a-ben-foyer-2100: "I was in the foyer at 21:00."') }],
      responseSchema: gossipSchema,
      maxOutputTokens: 300,
    }),
  },
  {
    n: 8,
    what: ["gossip: Ada decides whom to tell", "传闻：马艾达决定告诉谁"],
    build: () => ({
      step: "gossip.turn",
      promptId: "gossip-v1",
      messages: [...suspectSystemMessages(c, "s-ada"), { role: "user", content: gossipTurn('a-ada-foyer-2100: "I was in the foyer at 21:00."') }],
      responseSchema: gossipSchema,
      maxOutputTokens: 300,
    }),
  },
  {
    n: 9,
    what: ["case writer, stage 1: skeleton of a new four-suspect case", "案件写作，第一阶段：一个四人新案件的骨架"],
    build: () => ({
      step: "writer.skeleton",
      promptId: "writer-skeleton-v1",
      messages: [writerSystem, { role: "user", content: "Write the skeleton of a new case set in a lighthouse during a storm. Three time slots starting at 22:00, three connected rooms, four suspects. Use short ids like l-lamp and s-keeper." }],
      responseSchema: skeletonSchema,
      maxOutputTokens: 1500,
    }),
    after: (r, ctx) => (ctx.skeleton = r.text ?? undefined),
  },
  {
    n: 10,
    what: ["case writer, stage 2: people for that skeleton", "案件写作，第二阶段：为该骨架写人物"],
    build: (ctx) =>
      ctx.skeleton
        ? {
            step: "writer.people",
            promptId: "writer-people-v1",
            messages: [
              writerSystem,
              {
                role: "user",
                content: `Here is a case skeleton:\n${ctx.skeleton}\n\nThe victim dies in the first room listed, during the second time slot. For each suspect give a voice, where they were in every slot (moving at most one room between slots), whether they could reach the weapon, and a motive or an empty string. Exactly one suspect is in the first room during the second slot with the means and a motive: name that suspect as the culprit.`,
              },
            ],
            responseSchema: peopleSchema,
            maxOutputTokens: 2500,
          }
        : null,
  },
];

// ---- Batch b: suspect voice, gossip prompt, caching with a long prefix ----

/** One question to one suspect: the recall request, then the answer. Two steps. */
function exchange(n: number, key: string, suspect: string, question: string, note: [string, string]): Step[] {
  return [
    {
      n,
      what: [`${note[0]}: question -> recall`, `${note[1]}：提问 -> recall`],
      build: () => ({ step: "suspect.recall", promptId: "suspect-v2", messages: ask(suspect, question), tools: [recallTool(c, suspect, held)], maxOutputTokens: 400 }),
      expect: recallExpect(suspect),
      after: (r, ctx) => (ctx.calls[key] = r.toolCalls[0]),
    },
    {
      n: n + 1,
      what: [`${note[0]}: answer in character`, `${note[1]}：以角色语气作答`],
      build: (ctx) =>
        ctx.calls[key] ? { step: "suspect.answer", promptId: "suspect-v2", messages: afterRecall(suspect, question, ctx.calls[key]!), responseSchema: suspectAnswerSchema, maxOutputTokens: 500 } : null,
    },
  ];
}

const others = (suspect: string) => c.suspects.map((s) => s.id).filter((id) => id !== suspect);
const compactGossipSchema = (suspect: string) => ({ name: "gossip_choice", schema: object({ to: { type: "string", enum: [...others(suspect), "nobody"] } }) });
const compactGossip = (suspect: string): ChatMessage[] => [
  ...suspectSystemMessages(c, suspect),
  {
    role: "user",
    content: `Between the detective's questions you may repeat what you told the detective to one other person in the house, or keep it to yourself. You told the detective: "I was in the foyer at 21:00." Choose whom you tell: ${others(suspect).join(", ")}, or nobody. Just choose; no explanation is needed.`,
  },
];
const gossipStep = (n: number, suspect: string, effort: "low" | "minimal"): Step => ({
  n,
  what: [`gossip, compact prompt, ${suspect}, effort ${effort}, limit 600`, `传闻，精简提示词，${suspect}，推理档位 ${effort}，上限 600`],
  build: () => ({ step: "gossip.turn", promptId: "gossip-v2", messages: compactGossip(suspect), responseSchema: compactGossipSchema(suspect), maxOutputTokens: 600, reasoningEffort: effort }),
});

// A shared prefix long enough that a cache should notice it: the briefing plus house notes.
const houseNotes = Array.from(
  { length: 120 },
  (_, i) => `Note ${i + 1}: after 20:00 the east stairwell is closed and visitors use the main stairs; the desk keeps a log. / 注 ${i + 1}：20:00 后东侧楼梯关闭，访客走主楼梯；前台有登记。`,
).join("\n");
const longAsk = (question: string): ChatMessage[] => [
  { role: "system", content: `${publicBriefing(c)}\n\nHOUSE NOTES\n${houseNotes}` },
  suspectSystemMessages(c, "s-ada")[1]!,
  { role: "user", content: question },
];
const cacheStep = (n: number, question: string, cacheKey?: string): Step => ({
  n,
  what: [`long shared prefix${cacheKey ? ", with a cache label" : ""}: "${question}"`, `长共享前缀${cacheKey ? "，带缓存标签" : ""}："${question}"`],
  build: () => ({ step: "cache.probe", promptId: "suspect-v2-long", messages: longAsk(question), tools: [recallTool(c, "s-ada", held)], maxOutputTokens: 300, ...(cacheKey ? { cacheKey } : {}) }),
  expect: recallExpect("s-ada"),
});

const batchB: Step[] = [
  ...exchange(1, "ada-en", "s-ada", EN, ["Ada, English, where were you", "马艾达，英文，你在哪里"]),
  ...exchange(3, "ada-zh", "s-ada", ZH, ["Ada, Chinese, where were you", "马艾达，中文，你在哪里"]),
  ...exchange(5, "ben-en", "s-ben", EN, ["Ben, English, where were you", "欧本，英文，你在哪里"]),
  ...exchange(7, "ben-zh", "s-ben", ZH, ["Ben, Chinese, where were you", "欧本，中文，你在哪里"]),
  ...exchange(9, "ada-who", "s-ada", "Who do you think killed Mr. Shen?", ["Ada, English, a question with no topic", "马艾达，英文，没有对应话题的问题"]),
  ...exchange(11, "ben-who", "s-ben", "你觉得是谁杀了沈先生？", ["Ben, Chinese, a question with no topic", "欧本，中文，没有对应话题的问题"]),
  ...exchange(13, "ada-seen", "s-ada", "Did anyone see you in the foyer at 21:00?", ["Ada, English, a question that invites inventing a witness", "马艾达，英文，诱导编造目击者的问题"]),
  {
    n: 15,
    what: ["gossip, first prompt again, Ben, effort low, limit 1000", "传闻，沿用第一版提示词，欧本，low，上限 1000"],
    build: () => ({
      step: "gossip.turn",
      promptId: "gossip-v1",
      messages: [...suspectSystemMessages(c, "s-ben"), { role: "user", content: gossipTurn('a-ben-foyer-2100: "I was in the foyer at 21:00."') }],
      responseSchema: gossipSchema,
      maxOutputTokens: 1000,
    }),
  },
  gossipStep(16, "s-ben", "low"),
  gossipStep(17, "s-ada", "low"),
  gossipStep(18, "s-ben", "minimal"),
  gossipStep(19, "s-ada", "minimal"),
  cacheStep(20, "Where were you at 21:00?"),
  cacheStep(21, "And where were you at 21:20?"),
  cacheStep(22, "Where were you at 20:40?"),
  cacheStep(23, "Where were you at 21:00?", "case:archive-pass"),
  cacheStep(24, "And where were you at 21:20?", "case:archive-pass"),
];

const batches: Record<string, Step[]> = { a: batchA, b: batchB };
const steps = batches[LABEL];
if (!steps) {
  say(`No such batch: ${LABEL}. Batches: ${Object.keys(batches).join(", ")}.`, `没有这个批次：${LABEL}。可用批次：${Object.keys(batches).join("、")}。`);
  process.exit(1);
}

if (process.argv.includes("--plan")) {
  say(`The ${steps.length} requests of batch ${LABEL}, in order. Nothing is sent.`, `批次 ${LABEL} 的 ${steps.length} 次请求，按顺序列出。不会发送任何内容。`);
  for (const s of steps) console.log(`  ${idOf(s.n)}  ${both(...s.what)}`);
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

const label: Record<TrialOutcome, [string, string]> = {
  ok: ["ok", "正常"],
  truncated: ["TRUNCATED (paid for, not usable)", "被截断（已计费，结果不可用）"],
  invalid: ["INVALID (paid for, reply not in the expected shape)", "无效（已计费，回复不符合预期格式）"],
  unconfirmed: ["UNCONFIRMED (sent, settlement not confirmed)", "未确认（已发送，结算未确认）"],
  failed: ["FAILED (sent, outcome unknown, full hold kept)", "失败（已发送，结果不明，预留额全额保留）"],
  refused: ["REFUSED (not sent)", "被拒绝（未发送）"],
  earlier: ["sent in an earlier run (not sent again)", "此前已发送（本次未重发）"],
  skipped: ["SKIPPED (needs an earlier reply this run did not produce)", "已跳过（依赖的前一步在本次运行中没有结果）"],
  "not-reached": ["not reached (the run stopped before it)", "未执行（运行已提前停止）"],
};

const report = await runBatch({
  metered: runtime.metered,
  steps,
  idOf,
  onRow: (s, r) => {
    console.log(`\n${r.id}  ${both(...s.what)}`);
    if (r.costNano !== undefined && r.response) {
      console.log(`  ${r.ms} ms | in ${r.input} (cached ${r.cached}) | out ${r.output} (reasoning ${r.reasoning ?? "?"}) | ${usd(r.costNano)} | finish ${r.response.finishReason ?? "?"}`);
      if (r.response.toolCalls.length > 0) console.log(`  tool calls: ${JSON.stringify(r.response.toolCalls.map((t) => ({ name: t.name, arguments: t.arguments })))}`);
      if (r.response.text) console.log(`  text: ${r.response.text.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    if (r.outcome !== "ok") console.log(`  ${both(...label[r.outcome])}${r.detail ? `: ${r.detail}` : ""}`);
  },
});
const rows = report.rows;

// ---- Summary: one line per request, then the counts. ----
console.log();
say("Summary", "汇总");
for (const r of rows) {
  const numbers =
    r.costNano === undefined
      ? ""
      : `  in ${String(r.input).padStart(5)} cached ${String(r.cached).padStart(5)} out ${String(r.output).padStart(5)} reasoning ${String(r.reasoning ?? "?").padStart(5)}  ${usd(r.costNano)}  ${r.ms} ms`;
  console.log(`  ${r.id}  ${r.step.padEnd(16)} ${both(...label[r.outcome])}${numbers}`);
}
const count = (o: TrialOutcome) => rows.filter((r) => r.outcome === o).length;
const priced = rows.filter((r) => r.costNano !== undefined);
const total = report.pricedNano;
say(
  `${count("ok")} ok, ${count("truncated")} truncated, ${count("invalid")} invalid, ${count("unconfirmed")} unconfirmed, ${count("failed")} failed, ${count("refused")} refused, ${count("earlier")} sent earlier, ${count("skipped")} skipped, ${count("not-reached")} not reached.`,
  `正常 ${count("ok")}，截断 ${count("truncated")}，无效 ${count("invalid")}，未确认 ${count("unconfirmed")}，失败 ${count("failed")}，被拒绝 ${count("refused")}，此前已发送 ${count("earlier")}，跳过 ${count("skipped")}，未执行 ${count("not-reached")}。`,
);
say(`${priced.length} request(s) priced in this run, ${usd(total)} in total.`, `本次运行计费 ${priced.length} 次请求，合计 ${usd(total)}。`);

// How many tokens one byte of body became, from the trace. Information only.
const tracePath = `traces/${runtime.config.envelope}.trace.jsonl`;
if (existsSync(tracePath)) {
  const ratios = readFileSync(tracePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { attemptId: string; payloadBytes: number; inputTokens?: number })
    .filter((e) => e.attemptId.startsWith(`smoke-${LABEL}-`) && e.inputTokens !== undefined)
    .map((e) => e.inputTokens! / e.payloadBytes);
  if (ratios.length > 0) {
    say(
      `Input tokens per body byte in this batch: lowest ${Math.min(...ratios).toFixed(3)}, highest ${Math.max(...ratios).toFixed(3)} (information only; it changes no hold).`,
      `本批次每字节请求体对应的输入 token：最低 ${Math.min(...ratios).toFixed(3)}，最高 ${Math.max(...ratios).toFixed(3)}（仅供参考，不影响预留额）。`,
    );
  }
}
const after = await runtime.store.totals(runtime.config.envelope);
say(
  `Envelope now: settled ${usd(after.settledNano)}, kept for unknown outcomes ${usd(after.retainedNano)}, committed ${usd(after.committedNano)}.${after.suspended ? ` SUSPENDED: ${after.suspended}` : ""}`,
  `额度现状：已结算 ${usd(after.settledNano)}，结果不明而保留 ${usd(after.retainedNano)}，已占用 ${usd(after.committedNano)}。${after.suspended ? "额度已停用。" : ""}`,
);

const complete = report.complete;
if (complete) say("Complete: every request was sent, confirmed and usable.", "完成：每个请求都已发送、确认且结果可用。");
else say("INCOMPLETE: see the lines above that are not ok.", "未完成：见上方状态不是“正常”的各行。");
await runtime.close();
process.exit(complete ? 0 : 1);
