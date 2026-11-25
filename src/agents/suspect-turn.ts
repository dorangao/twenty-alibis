import type { Held } from "../case/access";
import type { Assertion, Case } from "../case/schema";
import type { Metered, MeteredRequest } from "../metered";
import type { ChatMessage, ProviderResponse, ToolCall } from "../provider/types";
import { guardLine, languageOf, type GuardReason } from "./line-guard";
import { renderAssertion, type Lang } from "./render";
import { recallResult, recallTool, suspectAnswerSchema, suspectSystemMessages } from "./suspect-prompt";

/**
 * One question to one suspect, start to finish.
 *
 * The model chooses a topic and writes the line. Code decides everything that counts:
 *
 *  - The statements of the turn are the ones `recall` returned for the topic. They come from
 *    the case file, not from the model's reply, so a turn's notebook entries are fixed the
 *    moment the topic is known. Asking a topic always yields its statements, which is what
 *    the solver assumes.
 *  - The model's line is shown only if it claims no statement outside that set and passes
 *    the line guard. It gets one retry. After that the code-rendered sentence is shown.
 *  - If a request is refused or fails, the turn still ends with a line: the rendered
 *    sentence when the topic is known, a fixed deflection when it is not.
 *
 * The text a model sends along with a tool call is never shown to anyone.
 */

export const SUSPECT_PROMPT_ID = "suspect-v2";
/** Output limits per request, reasoning included. */
export const RECALL_OUTPUT_TOKENS = 400;
export const ANSWER_OUTPUT_TOKENS = 500;
/** The most requests one turn may send: choose the topic, answer, and one retry of the answer. */
export const MAX_TURN_REQUESTS = 3;

/** Where the shown line came from. */
export type LineSource =
  /** The model's line, first try. */
  | "model"
  /** The model's line, after one retry. */
  | "model-retry"
  /** The statements as code words them. */
  | "rendered"
  /** A fixed line, used when there is no statement to render. */
  | "deflection";

export type RejectionReason =
  | GuardReason
  /** The reply was cut off at the output limit. */
  | "truncated"
  /** The reply is not the JSON object that was asked for. */
  | "malformed"
  /** The reply claims a statement that `recall` did not return this turn. */
  | "unknown-claim";

export interface Rejection {
  /** Which request produced the line: "recall" (text instead of a tool call), "answer" or "retry". */
  from: "recall" | "answer" | "retry";
  reason: RejectionReason;
  detail: string;
}

export interface NotebookStatement {
  assertion: string;
  en: string;
  zh: string;
}

export interface SuspectTurn {
  suspect: string;
  /** The topic the turn settled on, or null when no topic fit. */
  topic: string | null;
  /** True when the player picked the topic from the menu, false when the model chose it. */
  topicGiven: boolean;
  language: Lang;
  /** The statements this turn puts in the notebook, worded by code. */
  statements: NotebookStatement[];
  /** What the player is shown. */
  line: string;
  source: LineSource;
  /** Every line of the model's that was not used, and why. */
  rejections: Rejection[];
  /** Requests that left this machine. */
  requests: number;
  /** The confirmed cost of the requests that came back. A request with an unknown outcome is not in it: its hold stays with the spend guard. */
  costNano: number;
  /** Set when a request was refused or failed, e.g. "refused:envelope-exhausted". The turn fell back. */
  problem?: string;
}

export const DEFLECTION: Record<Lang, string> = {
  en: "I have nothing to tell you about that.",
  zh: "这个我没什么可说的。",
};

export interface SuspectTurnArgs {
  metered: Metered;
  c: Case;
  suspect: string;
  /** What the player holds now. It decides which topics are open. */
  held: Held;
  /** The player's words. */
  question: string;
  /**
   * When the player picked a topic from the menu, its id. The request that would ask the
   * model to choose a topic is then skipped: code already knows the answer.
   */
  topic?: string;
  /**
   * A stable id for this turn, e.g. "<session>:<turn number>". Each request is "<turnId>:recall",
   * "<turnId>:answer" or "<turnId>:retry", so a redelivered turn is never sent twice.
   */
  turnId: string;
  /** A label for requests that share this case's prompt prefix. */
  cacheKey?: string;
}

/**
 * What the model is told before its one retry. It travels as a `note` field inside the tool
 * result, so a retry request has exactly the shape of an ordinary answer request and the
 * note cannot be taken for something the detective said.
 */
export const retryNote = (lang: Lang, rejection: Rejection): string =>
  lang === "en"
    ? `[Note from the game, not from the detective] Your last line cannot be used (${rejection.reason}${rejection.detail ? `: ${rejection.detail}` : ""}). Answer again in English. Make the statements from recall and nothing more: name no other person, place, time or object, deny nothing, and say nothing about who else was there.`
    : `[游戏提示，不是侦探说的话] 你上一句不能用（${rejection.reason}${rejection.detail ? `：${rejection.detail}` : ""}）。请用简体中文重新回答。只说 recall 给出的陈述：不要提到其他人、地点、时间或物品，不要否认任何事，也不要说还有谁在或不在场。`;

/** Read a structured answer. Null when it is not the object that was asked for. */
function parseAnswer(response: ProviderResponse): { assertions: string[]; line: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text ?? "");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { assertions, line } = parsed as Record<string, unknown>;
  if (!Array.isArray(assertions) || !assertions.every((a) => typeof a === "string") || typeof line !== "string") return null;
  return { assertions: assertions as string[], line };
}

export async function suspectTurn(args: SuspectTurnArgs): Promise<SuspectTurn> {
  const { metered, c, suspect, held, question, turnId } = args;
  if (!c.suspects.some((s) => s.id === suspect)) throw new Error(`no such suspect: ${suspect}`);

  const language = languageOf(question);
  const rejections: Rejection[] = [];
  let requests = 0;
  let costNano = 0;
  let problem: string | undefined;

  /** Send one request. Null when it was refused or failed; no further request is sent after that. */
  const send = async (suffix: string, request: Omit<MeteredRequest, "attemptId" | "promptId" | "cacheKey">): Promise<ProviderResponse | null> => {
    if (problem || requests >= MAX_TURN_REQUESTS) return null;
    const result = await metered({ ...request, promptId: SUSPECT_PROMPT_ID, attemptId: `${turnId}:${suffix}`, ...(args.cacheKey ? { cacheKey: args.cacheKey } : {}) });
    if (!result.ok) {
      if (result.sent) requests++;
      problem = result.sent ? "failed:outcome-unknown" : `refused:${result.reason}`;
      return null;
    }
    requests++;
    costNano += result.costNano;
    return result.response;
  };

  const base: ChatMessage[] = [...suspectSystemMessages(c, suspect), { role: "user", content: question }];
  const menu = (recallTool(c, suspect, held).parameters as { properties: { topic: { enum: string[] } } }).properties.topic.enum;

  // ---- 1. The topic: given by the player, or chosen by the model through `recall`. ----
  let call: ToolCall | null = null;
  let topic: string | null = null;
  const topicGiven = args.topic !== undefined;
  /** Text the model gave instead of a tool call. It is treated as a line that makes no statement. */
  let unprompted: string | null = null;

  if (args.topic !== undefined) {
    if (!menu.includes(args.topic) || args.topic === "none") throw new Error(`topic ${args.topic} is not open for ${suspect}`);
    topic = args.topic;
    call = { id: "call_topic", name: "recall", arguments: JSON.stringify({ topic }) };
  } else {
    const response = await send("recall", { step: "suspect.recall", messages: base, tools: [recallTool(c, suspect, held)], maxOutputTokens: RECALL_OUTPUT_TOKENS });
    if (response) {
      const made = response.toolCalls.find((t) => t.name === "recall");
      if (made) {
        call = made;
        let asked: unknown;
        try {
          asked = (JSON.parse(made.arguments) as { topic?: unknown }).topic;
        } catch {
          asked = undefined;
        }
        topic = typeof asked === "string" && asked !== "none" && menu.includes(asked) ? asked : null;
      } else if (response.finishReason === "length") {
        rejections.push({ from: "recall", reason: "truncated", detail: "" });
      } else {
        unprompted = response.text ?? "";
      }
    }
  }

  // The statements are fixed here, by the case file.
  const recallText = recallResult(c, suspect, topic ?? "none", held);
  const recalled = JSON.parse(recallText) as { statements: { id: string; en: string; zh: string }[] };
  const statements: NotebookStatement[] = recalled.statements.map((s) => ({ assertion: s.id, en: s.en, zh: s.zh }));
  const accepted: Assertion[] = statements.flatMap((s) => c.assertions.filter((a) => a.id === s.assertion));
  const allowedIds = new Set(statements.map((s) => s.assertion));

  const done = (line: string, source: LineSource): SuspectTurn => ({
    suspect,
    topic,
    topicGiven,
    language,
    statements,
    line,
    source,
    rejections,
    requests,
    costNano,
    ...(problem ? { problem } : {}),
  });
  const fallback = (): SuspectTurn =>
    accepted.length > 0 ? done(accepted.map((a) => renderAssertion(c, suspect, a, language)).join(" "), "rendered") : done(DEFLECTION[language], "deflection");

  /** Why a candidate line cannot be shown, or null when it can. */
  const check = (from: Rejection["from"], claimed: readonly string[], line: string): Rejection | null => {
    const unknown = claimed.filter((id) => !allowedIds.has(id));
    if (unknown.length > 0) return { from, reason: "unknown-claim", detail: unknown.join(", ") };
    const verdict = guardLine(c, suspect, accepted, line, language);
    return verdict.ok ? null : { from, reason: verdict.reason, detail: verdict.detail };
  };

  // ---- 2. No tool call: the model answered straight away. ----
  if (!call) {
    if (unprompted === null) return fallback();
    const rejection = check("recall", [], unprompted);
    if (!rejection) return done(unprompted.trim(), "model");
    rejections.push(rejection);
    return fallback();
  }

  // ---- 3. The answer, and at most one retry. ----
  const made = call;
  const afterRecall = (toolResult: string): ChatMessage[] => [
    ...base,
    { role: "assistant", content: "", toolCalls: [made] },
    { role: "tool", toolCallId: made.id, content: toolResult },
  ];

  for (const attempt of ["answer", "retry"] as const) {
    const last = rejections[rejections.length - 1];
    const messages = afterRecall(attempt === "retry" && last ? JSON.stringify({ ...recalled, note: retryNote(language, last) }) : recallText);
    const response = await send(attempt, { step: `suspect.${attempt}`, messages, responseSchema: suspectAnswerSchema, maxOutputTokens: ANSWER_OUTPUT_TOKENS });
    if (!response) break;
    if (response.finishReason === "length") {
      // The limit was spent on reasoning or on text that never ended. Asking again would most likely end the same way.
      rejections.push({ from: attempt, reason: "truncated", detail: "" });
      break;
    }
    const answer = parseAnswer(response);
    const rejection: Rejection | null = answer ? check(attempt, answer.assertions, answer.line) : { from: attempt, reason: "malformed", detail: "" };
    if (!rejection) return done(answer!.line.trim(), attempt === "answer" ? "model" : "model-retry");
    rejections.push(rejection);
  }
  return fallback();
}
