import { randomUUID } from "node:crypto";
import type { Case, Text } from "../case/schema";
import { accuse, ask, inspect, MAX_QUESTION_CHARS, SessionError, startSession, type Session, type SessionErrorCode } from "../game/session";
import type { Metered } from "../metered";
import type { SessionStore } from "./sessions";
import { caseCard, viewOf, type CaseCard, type View } from "./view";

/**
 * The game over HTTP: one function from a request to a response.
 *
 * It is written against the web-standard Request and Response, so the same code runs under
 * the local dev server and as one serverless function. Everything it needs is passed in.
 *
 *   GET  /api/cases                    the library
 *   POST /api/sessions                 { caseId }                              start a session
 *   GET  /api/sessions/:id             the session's view
 *   POST /api/sessions/:id/ask         { suspect, topic, language? }           a topic from the menu
 *                                      { suspect, question }                   the player's own words
 *   POST /api/sessions/:id/inspect     { inspection }
 *   POST /api/sessions/:id/accuse      { suspect, evidence: [...] }
 *
 * Every answer is a view (src/web/view.ts) or an error with a fixed code and a fixed sentence
 * in both languages. No message from the validator, the solver or the spend guard is passed
 * on: those can name the people and facts of a case.
 */
export interface ApiDeps {
  /** The cases that can be played. Each has already passed the gate. */
  cases: readonly Case[];
  sessions: SessionStore;
  /** The model, as it was decided when the server started. */
  metered: Metered;
  /** True when the model is off for this server: menu topics still work, typed questions do not. */
  modelOff: boolean;
  /** A new, unguessable session id. */
  newId?: () => string;
}

export type ErrorCode = "not-found" | "method" | "bad-request" | "busy" | "model-off" | "server" | SessionErrorCode;

export interface ApiError {
  error: { code: ErrorCode; text: Text };
}

/** What an ask adds to the view: whether the question was a saved one, and whether it was kept. */
export interface AskNote {
  replayed: boolean;
  recorded: boolean;
  /** Set when the model could not be used for this question. */
  notice?: { code: "not-asked" | "worded-by-code"; text: Text };
}

export interface ViewReply {
  view: View;
  ask?: AskNote;
}

export interface CasesReply {
  cases: CaseCard[];
  model: "on" | "off";
}

const ERRORS: Record<ErrorCode, { status: number; text: Text }> = {
  "not-found": { status: 404, text: { en: "There is nothing here.", zh: "这里什么都没有。" } },
  method: { status: 405, text: { en: "That is not how this is asked for.", zh: "请求方式不对。" } },
  "bad-request": { status: 400, text: { en: "The request could not be read.", zh: "无法读取这个请求。" } },
  busy: { status: 409, text: { en: "The last action is still being worked on. Try again in a moment.", zh: "上一步还在进行中，请稍后再试。" } },
  "model-off": { status: 409, text: { en: "A question in your own words needs the model, and the model is off. Pick a topic from the menu.", zh: "用自己的话提问需要模型，而模型现在是关闭的。请从话题列表里选。" } },
  server: { status: 500, text: { en: "Something went wrong on the server. Nothing was changed.", zh: "服务器出了问题。没有做任何改动。" } },
  over: { status: 409, text: { en: "This case has ended with an accusation.", zh: "本案已经以指认结束。" } },
  cap: { status: 409, text: { en: "You have no actions left. You can still accuse.", zh: "行动次数已用完。仍然可以指认。" } },
  "not-available": { status: 404, text: { en: "That is not open to you right now.", zh: "这一项现在还不能用。" } },
  "bad-question": { status: 400, text: { en: `A question must have some words in it, and at most ${MAX_QUESTION_CHARS} characters.`, zh: `提问不能为空，且最多 ${MAX_QUESTION_CHARS} 个字符。` } },
  "not-held": { status: 400, text: { en: "You can only cite evidence that is in your notebook.", zh: "只能引用笔记本里已有的证据。" } },
};

const NOTICES: Record<NonNullable<AskNote["notice"]>["code"], Text> = {
  "not-asked": { en: "The model is not available right now, so this question was not asked. Nothing was used.", zh: "模型现在不可用，这个问题没有问出去。没有消耗任何行动。" },
  "worded-by-code": { en: "The model could not be used for this answer. The statement is worded by code.", zh: "这次回答无法使用模型。陈述由代码写成。" },
};

/** The largest request body that is read. */
export const MAX_BODY_BYTES = 4_000;
/** The most evidence ids an accusation may cite. */
const MAX_CITED = 200;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (code: ErrorCode): Response => json(ERRORS[code].status, { error: { code, text: ERRORS[code].text } } satisfies ApiError);

class BadRequest extends Error {}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new BadRequest();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRequest();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequest();
  return parsed as Record<string, unknown>;
}
const text = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000) throw new BadRequest();
  return value;
};

export async function handle(request: Request, deps: ApiDeps): Promise<Response> {
  try {
    return await route(request, deps);
  } catch (error) {
    if (error instanceof BadRequest) return fail("bad-request");
    if (error instanceof SessionError) return fail(error.code);
    // Nothing about the error is sent: it may quote a case.
    return fail("server");
  }
}

async function route(request: Request, deps: ApiDeps): Promise<Response> {
  const model = deps.modelOff ? "off" : "on";
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") return fail("not-found");
  const caseOf = (id: string): Case | undefined => deps.cases.find((c) => c.id === id);

  if (parts.length === 2 && parts[1] === "cases") {
    if (request.method !== "GET") return fail("method");
    return json(200, { cases: deps.cases.map(caseCard), model } satisfies CasesReply);
  }

  if (parts[1] !== "sessions") return fail("not-found");

  if (parts.length === 2) {
    if (request.method !== "POST") return fail("method");
    const body = await readBody(request);
    const c = caseOf(text(body, "caseId"));
    if (!c) return fail("not-found");
    const session = startSession(c, (deps.newId ?? randomUUID)());
    await deps.sessions.create(session);
    return json(201, { view: viewOf(c, session, model) } satisfies ViewReply);
  }

  const id = parts[2]!;
  // An id that could not be one of ours and one that is not known get the same answer.
  if (!SESSION_ID.test(id)) return fail("not-found");

  if (parts.length === 3) {
    if (request.method !== "GET") return fail("method");
    const session = await deps.sessions.read(id);
    const c = session && caseOf(session.caseId);
    if (!session || !c) return fail("not-found");
    return json(200, { view: viewOf(c, session, model) } satisfies ViewReply);
  }

  if (parts.length !== 4 || !["ask", "inspect", "accuse"].includes(parts[3]!)) return fail("not-found");
  if (request.method !== "POST") return fail("method");
  const action = parts[3] as "ask" | "inspect" | "accuse";
  const body = await readBody(request);

  const done = await deps.sessions.update<ViewReply>(id, async (session) => {
    const c = caseOf(session.caseId);
    if (!c) throw new SessionError("not-available", "the session's case is not in the library");
    const reply = (next: Session, note?: AskNote): { session: Session; value: ViewReply } => ({ session: next, value: { view: viewOf(c, next, model), ...(note ? { ask: note } : {}) } });

    if (action === "inspect") return reply(inspect(c, session, text(body, "inspection")).session);

    if (action === "accuse") {
      const cited = body.evidence;
      if (!Array.isArray(cited) || cited.length > MAX_CITED || cited.some((e) => typeof e !== "string" || e.length === 0 || e.length > 200)) throw new BadRequest();
      return reply(accuse(c, session, { suspect: text(body, "suspect"), evidence: cited as string[] }).session);
    }

    const suspect = text(body, "suspect");
    const language = body.language === "zh" ? "zh" : "en";
    if (body.topic !== undefined) {
      const result = await ask(deps.metered, c, session, { suspect, topic: text(body, "topic"), language, cacheKey: `case:${c.id}` });
      return reply(result.session, noteOf(result, deps.modelOff));
    }
    // A question in the player's own words. With the model off it is not asked at all: nothing is used.
    const question = text(body, "question");
    if (deps.modelOff) throw new ModelOff();
    const result = await ask(deps.metered, c, session, { suspect, question, cacheKey: `case:${c.id}` });
    return reply(result.session, noteOf(result, deps.modelOff));
  }).catch((error: unknown) => {
    if (error instanceof ModelOff) return "model-off" as const;
    throw error;
  });

  if (done === "model-off") return fail("model-off");
  if (!done.ok) return fail(done.why === "busy" ? "busy" : "not-found");
  return json(200, done.value);
}

class ModelOff extends Error {}

function noteOf(result: { replayed: boolean; recorded: boolean; turn: { problem?: string; source: string } }, modelOff: boolean): AskNote {
  const note: AskNote = { replayed: result.replayed, recorded: result.recorded };
  if (!result.recorded) note.notice = { code: "not-asked", text: NOTICES["not-asked"] };
  // With the model off, a statement worded by code is the expected answer and needs no notice.
  else if (!modelOff && !result.replayed && result.turn.problem) note.notice = { code: "worded-by-code", text: NOTICES["worded-by-code"] };
  return note;
}
