/**
 * The first paid test: at most ten fixed requests to Muse Ember, one after another.
 * 首次付费测试：最多十次固定请求，逐个发送。
 *
 *   npm run smoke            send them (needs `npm run spend -- allow-paid "..."` first)
 *   npm run smoke -- --plan  list them without sending anything
 *
 * Each request has a fixed id (smoke-a-01 … smoke-a-10) and an id can be sent once, ever:
 * running this again sends nothing that already went out. It stops at the first request that
 * does not come back clean, so one wrong field cannot use up all ten.
 *
 * What it measures: whether the request and usage fields are right, how many model requests
 * one answered question takes, whether the shared prompt prefix is cached, how many reasoning
 * tokens "low" and "minimal" effort use, and what each kind of step costs.
 */
import { existsSync, readFileSync } from "node:fs";
import { publicBriefing, recallResult, recallTool, suspectAnswerSchema, suspectSystemMessages } from "../src/agents/suspect-prompt";
import { archivePass } from "../src/case/fixtures/archive";
import type { MeteredRequest } from "../src/metered";
import type { ChatMessage, ProviderResponse, ToolCall } from "../src/provider/types";
import { createRuntime } from "../src/runtime";
import { nanoToUsd } from "../src/spend/pricing";
import { say } from "./say";

const c = archivePass;
const LABEL = "a";
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

interface Ctx {
  calls: Record<string, ToolCall | undefined>;
  skeleton?: string | undefined;
}
interface Step {
  n: number;
  what: string;
  /** Returns null when the step cannot be built (an earlier step did not give what it needs). */
  build(ctx: Ctx): Omit<MeteredRequest, "attemptId"> | null;
  after?(response: ProviderResponse, ctx: Ctx): void;
}

const ask = (suspect: string, question: string): ChatMessage[] => [...suspectSystemMessages(c, suspect), { role: "user", content: question }];
const afterRecall = (suspect: string, question: string, call: ToolCall): ChatMessage[] => {
  let topic = "none";
  try {
    topic = String(JSON.parse(call.arguments).topic);
  } catch {
    // unreadable arguments are treated as "none"
  }
  return [...ask(suspect, question), { role: "assistant", content: "", toolCalls: [call] }, { role: "tool", toolCallId: call.id, content: recallResult(c, suspect, topic) }];
};
const EN = "Where were you at 21:00?";
const ZH = "21:00 你在哪里？";

const steps: Step[] = [
  {
    n: 1,
    what: "ping: smallest possible request",
    build: () => ({ step: "smoke.ping", promptId: "ping-v1", messages: [{ role: "user", content: "Reply with the single word: ready" }], maxOutputTokens: 200 }),
  },
  {
    n: 2,
    what: "suspect, English question: expect a recall tool call (effort low)",
    build: () => ({ step: "suspect.recall", promptId: "suspect-v1", messages: ask("s-ada", EN), tools: [recallTool(c, "s-ada")], maxOutputTokens: 400 }),
    after: (r, ctx) => (ctx.calls.en = r.toolCalls[0]),
  },
  {
    n: 3,
    what: "suspect, English: answer after recall, as structured output (effort low)",
    build: (ctx) => (ctx.calls.en ? { step: "suspect.answer", promptId: "suspect-v1", messages: afterRecall("s-ada", EN, ctx.calls.en), responseSchema: suspectAnswerSchema, maxOutputTokens: 400 } : null),
  },
  {
    n: 4,
    what: "suspect, Chinese question: expect a recall tool call (effort minimal)",
    build: () => ({ step: "suspect.recall", promptId: "suspect-v1", messages: ask("s-ada", ZH), tools: [recallTool(c, "s-ada")], maxOutputTokens: 400, reasoningEffort: "minimal" }),
    after: (r, ctx) => (ctx.calls.zh = r.toolCalls[0]),
  },
  {
    n: 5,
    what: "suspect, Chinese: answer after recall, as structured output (effort minimal)",
    build: (ctx) =>
      ctx.calls.zh
        ? { step: "suspect.answer", promptId: "suspect-v1", messages: afterRecall("s-ada", ZH, ctx.calls.zh), responseSchema: suspectAnswerSchema, maxOutputTokens: 400, reasoningEffort: "minimal" }
        : null,
  },
  {
    n: 6,
    what: "detective: choose the next action",
    build: () => ({ step: "detective.turn", promptId: "detective-v1", messages: [detectiveSystem, { role: "user", content: detectiveTurn }], responseSchema: detectiveSchema, maxOutputTokens: 400 }),
  },
  {
    n: 7,
    what: "gossip: Ben decides whom to tell",
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
    what: "gossip: Ada decides whom to tell",
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
    what: "case writer, stage 1: skeleton of a new four-suspect case",
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
    what: "case writer, stage 2: people for that skeleton",
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

if (process.argv.includes("--plan")) {
  say("The ten requests, in order. Nothing is sent.", "十次请求的顺序。不会发送任何内容。");
  for (const s of steps) console.log(`  ${idOf(s.n)}  ${s.what}`);
  process.exit(0);
}

const runtime = await createRuntime(process.env);
const before = await runtime.store.totals(runtime.config.envelope);
if (!before.paidAllowed) {
  say("Paid requests are not authorized on this envelope. Nothing was sent.", "该额度未授权付费请求。未发送任何内容。");
  await runtime.close();
  process.exit(1);
}
say(`Envelope "${runtime.config.envelope}": ${usd(before.committedNano)} committed before the test.`, `额度 "${runtime.config.envelope}"：测试前已占用 ${usd(before.committedNano)}。`);

interface Row {
  id: string;
  step: string;
  ms: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number | undefined;
  costNano: number;
  finish: string | undefined;
}
const rows: Row[] = [];
const ctx: Ctx = { calls: {} };
let stopped: string | null = null;

for (const s of steps) {
  const attemptId = idOf(s.n);
  const built = s.build(ctx);
  if (!built) {
    console.log(`\n${attemptId}  ${s.what}\n  skipped: an earlier step did not return what this one needs`);
    continue;
  }
  console.log(`\n${attemptId}  ${s.what}`);
  const started = Date.now();
  const result = await runtime.metered({ ...built, attemptId });
  const ms = Date.now() - started;

  if (!result.ok) {
    if (!result.sent && result.reason === "duplicate-attempt") {
      console.log("  already sent in an earlier run; not sent again");
      continue;
    }
    console.log(`  NOT OK: ${result.reason}${result.sent ? " (sent; its full hold stays charged)" : " (nothing was sent)"}`);
    if (result.sent && result.error) console.log(`  ${String((result.error as Error).message ?? result.error).slice(0, 400)}`);
    stopped = `${attemptId}: ${result.reason}`;
    break;
  }
  const u = result.response.usage!;
  rows.push({ id: attemptId, step: built.step, ms, input: u.inputTokens, cached: u.cachedTokens, output: u.outputTokens, reasoning: u.reasoningTokens, costNano: result.costNano, finish: result.response.finishReason });
  console.log(`  ${ms} ms | in ${u.inputTokens} (cached ${u.cachedTokens}) | out ${u.outputTokens} (reasoning ${u.reasoningTokens ?? "?"}) | ${usd(result.costNano)} | finish ${result.response.finishReason ?? "?"}`);
  if (result.response.toolCalls.length > 0) console.log(`  tool calls: ${JSON.stringify(result.response.toolCalls.map((t) => ({ name: t.name, arguments: t.arguments })))}`);
  if (result.response.text) console.log(`  text: ${result.response.text.replace(/\s+/g, " ").slice(0, 300)}`);
  s.after?.(result.response, ctx);
  if (!result.settled || result.breached) {
    stopped = `${attemptId}: ${result.breached ? "the envelope was suspended" : "the settlement was not confirmed"}`;
    console.log(`  STOPPING: ${stopped}`);
    break;
  }
}

// ---- Summary ----
console.log();
say("Summary", "汇总");
const total = rows.reduce((sum, r) => sum + r.costNano, 0);
for (const r of rows) {
  console.log(`  ${r.id}  ${r.step.padEnd(16)} in ${String(r.input).padStart(5)} cached ${String(r.cached).padStart(5)} out ${String(r.output).padStart(5)} reasoning ${String(r.reasoning ?? "?").padStart(5)}  ${usd(r.costNano)}  ${r.ms} ms`);
}
say(`${rows.length} request(s) settled, ${usd(total)} in total.`, `共结算 ${rows.length} 次请求，合计 ${usd(total)}。`);

// How many tokens one byte of body became, from the trace this run wrote.
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
      `Input tokens per body byte: lowest ${Math.min(...ratios).toFixed(3)}, highest ${Math.max(...ratios).toFixed(3)} (for information only; it changes no hold).`,
      `每字节请求体对应的输入 token：最低 ${Math.min(...ratios).toFixed(3)}，最高 ${Math.max(...ratios).toFixed(3)}（仅供参考，不影响预留额）。`,
    );
  }
}
const after = await runtime.store.totals(runtime.config.envelope);
say(
  `Envelope now: settled ${usd(after.settledNano)}, kept for unknown outcomes ${usd(after.retainedNano)}, committed ${usd(after.committedNano)}.${after.suspended ? ` SUSPENDED: ${after.suspended}` : ""}`,
  `额度现状：已结算 ${usd(after.settledNano)}，结果不明而保留 ${usd(after.retainedNano)}，已占用 ${usd(after.committedNano)}。`,
);
if (stopped) say(`Stopped early at ${stopped}.`, `提前停止于 ${stopped}。`);
await runtime.close();
process.exit(stopped ? 1 : 0);
