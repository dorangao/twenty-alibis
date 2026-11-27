import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Lang } from "../agents/render";
import type { LineSource } from "../agents/suspect-turn";
import type { Case, Text } from "../case/schema";
import { accuse, ask, inspect, MAX_QUESTION_CHARS, SessionError, startSession, type Session, type SessionErrorCode } from "../game/session";
import type { Metered } from "../metered";
import type { Allowance } from "./allowance";
import type { SessionRecord, SessionStore } from "./sessions";
import { caseCard, handlesOf, viewOf, withHandles, type CaseCard, type View } from "./view";

/**
 * The game over HTTP: one function from a request to a response.
 *
 * It is written against the web-standard Request and Response, so the same code runs under
 * the local dev server and as one serverless function. Everything it needs is passed in.
 *
 *   GET  /api/cases                    the library
 *   POST /api/sessions                 { caseId }                               start a session
 *   GET  /api/sessions/:id             the session's view
 *   POST /api/sessions/:id/ask         { revision, topic, language? }           a topic from the menu
 *                                      { revision, person, question }           the player's own words
 *   POST /api/sessions/:id/inspect     { revision, inspection }
 *   POST /api/sessions/:id/accuse      { revision, person, evidence: [...] }
 *
 * Who may touch a session. The id in the path is a locator, not a credential: it is in views
 * and in the ids of the session's model requests. What proves a request is its visitor's is
 * a secret in a cookie that the page's scripts cannot read (HttpOnly) and that other sites'
 * requests do not carry (SameSite=Strict). The server keeps only its hash, with the session.
 * A session asked for by anyone else answers exactly like one that does not exist.
 *
 * Once only. Every view carries a revision, and every request to act carries the revision it
 * was made on. If the session has moved on, the request is refused as stale and nothing is
 * done: a click delivered twice, or a tab left open, cannot act twice. The page then reads
 * the session and sees where it stands.
 *
 * Lost work. A question is written down as begun before its first request to the model is
 * sent, and that already moves the revision: the click that asked it cannot be taken twice.
 * If the server stops before the answer is kept, the game stands where it stood, the next
 * view says so, and the question's number is not used again, so its requests can never be
 * sent a second time under the same ids. Asking again is a new click on the new view. What
 * the lost requests cost stays counted by the spend guard.
 *
 * Names. A request names things by the handles its view gave it (P3, T7, I2, E4), never by
 * the case file's ids, and a handle is taken only if it is on the menu or in the notebook.
 *
 * Every answer is a view (src/web/view.ts) or an error with a fixed code and a fixed sentence
 * in both languages. No message from the validator, the solver or the spend guard is passed
 * on: those can name the people and facts of a case.
 */
export interface ApiDeps {
  /** The cases that can be played. Each has already passed the gate. */
  cases: readonly Case[];
  sessions: SessionStore;
  /** The model. Every request through it still asks the spend guard. */
  metered: Metered;
  /** True when the model is off for this server: menu topics still work, typed questions do not. */
  modelOff: boolean;
  /** A new session id: a locator, unique, not a secret. */
  newId?: () => string;
  /** A new visitor secret: 64 hex characters nobody could guess. */
  newSecret?: () => string;
  /**
   * The game's own public origin, scheme and port included ("https://example.com"). A request
   * that changes something must come from exactly this origin. A deployed server sets it; when
   * it is not set, the origin of the request's own URL is used, which is right for a local
   * server that is reached directly.
   */
  origin?: string;
  /**
   * How many games a visitor may start and how many requests their games may send. A server
   * that can reach the model sets it. Without it nothing is counted, which is right for a
   * local server with the model off.
   */
  allowance?: Allowance;
  now?: () => number;
}

export type ErrorCode = "not-found" | "method" | "bad-request" | "forbidden" | "busy" | "stale" | "expired" | "full" | "allowance" | "crowded" | "model-off" | "server" | SessionErrorCode;

export interface ApiError {
  error: { code: ErrorCode; text: Text };
}

/** What an ask adds to the view. */
export interface AskNote {
  /** True when a saved turn was given again: nothing was sent and no action was used. */
  replayed: boolean;
  /** False when the question was not asked at all. */
  recorded: boolean;
  /**
   * The answer as it is to be shown now. For a topic heard before and asked again in the
   * other language this is that turn in the language asked, worded by code; the transcript
   * keeps the turn as it was first heard.
   */
  shown?: { person: string; line: string; language: Lang; source: LineSource };
  /** Set when the model could not be used for this question. */
  notice?: { code: "not-asked" | "allowance" | "worded-by-code"; text: Text };
}

export interface ViewReply {
  view: View;
  ask?: AskNote;
  /**
   * Set when the last question was begun and never finished: the server stopped before its
   * answer was kept. It stays until the next thing the player does is kept.
   */
  status?: { code: "interrupted"; text: Text };
}

export interface CasesReply {
  cases: CaseCard[];
  model: "on" | "off";
}

const ERRORS: Record<ErrorCode, { status: number; text: Text }> = {
  "not-found": { status: 404, text: { en: "There is nothing here.", zh: "这里什么都没有。" } },
  method: { status: 405, text: { en: "That is not how this is asked for.", zh: "请求方式不对。" } },
  "bad-request": { status: 400, text: { en: "The request could not be read.", zh: "无法读取这个请求。" } },
  forbidden: { status: 403, text: { en: "This request did not come from the game's own page.", zh: "这个请求不是从游戏页面发出的。" } },
  busy: { status: 409, text: { en: "The last action is still being worked on. Try again in a moment.", zh: "上一步还在进行中，请稍后再试。" } },
  stale: { status: 409, text: { en: "The game has moved on since this page was shown. It has been brought up to date; nothing was done.", zh: "页面显示之后，游戏已经有了新的进展。页面已更新，这一步没有执行。" } },
  expired: { status: 410, text: { en: "This game can no longer be continued. Please start the case again.", zh: "这一局已无法继续。请重新开始本案。" } },
  full: { status: 503, text: { en: "Too many games are in progress right now. Please try again in a moment.", zh: "当前进行中的游戏太多。请稍后再试。" } },
  allowance: { status: 429, text: { en: "You have started as many games as one visitor may in a day. Go on with one you have, or come back tomorrow.", zh: "你今天开始的游戏已达到每位访客的上限。请继续已有的一局，或明天再来。" } },
  crowded: { status: 503, text: { en: "Too many games have been started in the last hour. Please try again later.", zh: "过去一小时内开始的游戏太多。请稍后再试。" } },
  "model-off": { status: 409, text: { en: "A question in your own words needs the model, and the model is off. Pick a topic from the menu.", zh: "用自己的话提问需要模型，而模型现在是关闭的。请从话题列表里选。" } },
  server: { status: 500, text: { en: "Something went wrong on the server. Reload the page to see where the game stands.", zh: "服务器出了问题。请刷新页面，查看这一局的进展。" } },
  over: { status: 409, text: { en: "This case has ended with an accusation.", zh: "本案已经以指认结束。" } },
  cap: { status: 409, text: { en: "You have no actions left. You can still accuse.", zh: "行动次数已用完。仍然可以指认。" } },
  "not-available": { status: 404, text: { en: "That is not open to you right now.", zh: "这一项现在还不能用。" } },
  "bad-question": { status: 400, text: { en: `A question must have some words in it, and at most ${MAX_QUESTION_CHARS} characters.`, zh: `提问不能为空，且最多 ${MAX_QUESTION_CHARS} 个字符。` } },
  "not-held": { status: 400, text: { en: "You can only cite evidence that is in your notebook.", zh: "只能引用笔记本里已有的证据。" } },
};

const NOTICES: Record<NonNullable<AskNote["notice"]>["code"], Text> = {
  "not-asked": { en: "The model is not available right now, so this question was not asked. No action was used.", zh: "模型现在不可用，这个问题没有问出去。没有消耗行动。" },
  allowance: { en: "You have used all the questions to the model that one visitor may ask in a day, so this question was not asked. No action was used. Topics from the menu still work.", zh: "你今天向模型提问的次数已达到每位访客的上限，这个问题没有问出去。没有消耗行动。话题列表仍然可以用。" },
  "worded-by-code": { en: "The model could not be used for this answer. The statement is worded by code.", zh: "这次回答无法使用模型。陈述由代码写成。" },
};

const INTERRUPTED: Text = {
  en: "The last question did not finish: the server stopped before its answer was kept. The game stands where it was, and no action was used. If the question had reached the model, its cost is still counted on the server and is not in the total shown here. You can ask again.",
  zh: "上一个问题没有完成：服务器在保存回答之前中断了。这一局停在原来的位置，没有消耗行动。如果问题已经发给了模型，它的费用仍由服务器计入，但不在这里显示的合计里。可以重新提问。",
};

/** The largest request body that is read. */
export const MAX_BODY_BYTES = 4_000;
/** The most evidence handles an accusation may cite. */
const MAX_CITED = 200;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HANDLE = /^[PTIE][1-9]\d{0,3}$/;

/** The cookie that carries the visitor's secret. */
export const VISITOR_COOKIE = "ta_visitor";
const VISITOR_MAX_AGE_S = 7 * 24 * 60 * 60;
const SECRET = /^[0-9a-f]{64}$/;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
/** A case's version: any change to the case file changes it. */
const versions = new WeakMap<Case, string>();
export function caseVersion(c: Case): string {
  let version = versions.get(c);
  if (!version) {
    version = hash(JSON.stringify(c)).slice(0, 16);
    versions.set(c, version);
  }
  return version;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const fail = (code: ErrorCode): Response => json(ERRORS[code].status, { error: { code, text: ERRORS[code].text } } satisfies ApiError);

class Refused extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

/**
 * The request's body, read no further than the limit. Bytes are counted as they arrive, and
 * the moment there are too many the rest is not read: a body of unknown or dishonest length
 * cannot make the server hold more than the limit.
 */
async function readLimited(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Refused("bad-request");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Refused("bad-request");
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(whole);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readLimited(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Refused("bad-request");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Refused("bad-request");
  return parsed as Record<string, unknown>;
}
const text = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000) throw new Refused("bad-request");
  return value;
};
const handle = (body: Record<string, unknown>, key: string): string => {
  const value = text(body, key);
  // A handle of the wrong shape names nothing, like one that is not on the menu.
  if (!HANDLE.test(value)) throw new Refused(key === "evidence" ? "not-held" : "not-available");
  return value;
};

/** The visitor's secret from the request's cookie, if it carries a well-formed one. */
function visitorOf(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === VISITOR_COOKIE) {
      const value = part.slice(at + 1).trim();
      return SECRET.test(value) ? value : null;
    }
  }
  return null;
}

/**
 * A request that changes something must come from the game's own page: its Origin header
 * must be there, and must be exactly the game's origin, scheme, host and port. Browsers send
 * Origin with every POST a page makes, so a request without one did not come from the page.
 * "http://example.com" is not "https://example.com", and neither is another port.
 */
function sameOrigin(request: Request, expected: string | undefined): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    // `origin` of a URL is its scheme, host and port in canonical form; "null" and junk do not parse to one.
    return new URL(origin).origin === new URL(expected ?? request.url).origin && new URL(origin).origin === origin;
  } catch {
    return false;
  }
}

export async function handleRequest(request: Request, deps: ApiDeps): Promise<Response> {
  try {
    return await route(request, deps);
  } catch (error) {
    if (error instanceof Refused) return fail(error.code);
    if (error instanceof SessionError) return fail(error.code);
    // Nothing about the error is sent: it may quote a case.
    return fail("server");
  }
}

async function route(request: Request, deps: ApiDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") return fail("not-found");
  const caseOf = (id: string): Case | undefined => deps.cases.find((c) => c.id === id);
  /** The model is on for a session only if it was on when the session began and is on now. */
  const modelFor = (record: SessionRecord): "on" | "off" => (record.mode === "live" && !deps.modelOff ? "on" : "off");
  /**
   * A view of a record, with the word that its last question was lost. A question that is
   * written down as begun while a request is at work on the session is simply in progress.
   */
  const replyOf = (c: Case, record: SessionRecord, busy: boolean, note?: AskNote): ViewReply => {
    const interrupted = record.inFlight !== undefined && !busy;
    return { view: viewOf(c, record, modelFor(record), interrupted), ...(note ? { ask: note } : {}), ...(interrupted ? { status: { code: "interrupted", text: INTERRUPTED } } : {}) };
  };

  if (parts.length === 2 && parts[1] === "cases") {
    if (request.method !== "GET") return fail("method");
    return json(200, { cases: deps.cases.map(caseCard), model: deps.modelOff ? "off" : "on" } satisfies CasesReply);
  }

  if (parts[1] !== "sessions") return fail("not-found");
  if (request.method === "POST" && !sameOrigin(request, deps.origin)) return fail("forbidden");

  if (parts.length === 2) {
    if (request.method !== "POST") return fail("method");
    const body = await readBody(request);
    const c = caseOf(text(body, "caseId"));
    if (!c) return fail("not-found");
    // A visitor without a secret is given one now, in a cookie the page's scripts cannot read.
    const secret = visitorOf(request) ?? (deps.newSecret ?? (() => randomBytes(32).toString("hex")))();
    // Counted before the session is made. If the count cannot be read, this throws and nothing is started.
    const allowed = deps.allowance ? await deps.allowance.session(hash(secret)) : "ok";
    if (allowed !== "ok") return fail(allowed === "visitor" ? "allowance" : "crowded");
    const record = withHandles(c, {
      session: startSession(c, (deps.newId ?? randomUUID)()),
      owner: hash(secret),
      revision: 1,
      mode: deps.modelOff ? "off" : "live",
      caseVersion: caseVersion(c),
      topics: [],
      inspections: [],
      createdAt: now(),
    });
    if (!(await deps.sessions.create(record))) return fail("full");
    // The cookie is sent with every new session, also to a visitor who has one: that renews its
    // term, so a game begun today cannot outlive the cookie that opens it.
    const secure = new URL(deps.origin ?? request.url).protocol === "https:" ? "; Secure" : "";
    const cookie = { "set-cookie": `${VISITOR_COOKIE}=${secret}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${VISITOR_MAX_AGE_S}${secure}` };
    return json(201, replyOf(c, record, false), cookie);
  }

  const id = parts[2]!;
  const visitor = visitorOf(request);
  // An id that could not be one of ours, one that is not known, and one that is someone else's get the same answer.
  if (!SESSION_ID.test(id) || visitor === null) return fail("not-found");
  const owner = hash(visitor);
  /** The session's case, as long as it is still the version the session began on. */
  const caseFor = (record: SessionRecord): Case => {
    const c = caseOf(record.session.caseId);
    if (!c || caseVersion(c) !== record.caseVersion) throw new Refused("expired");
    return c;
  };

  if (parts.length === 3) {
    if (request.method !== "GET") return fail("method");
    const found = await deps.sessions.read(id);
    if (!found || found.record.owner !== owner) return fail("not-found");
    return json(200, replyOf(caseFor(found.record), found.record, found.busy));
  }

  if (parts.length !== 4 || !["ask", "inspect", "accuse"].includes(parts[3]!)) return fail("not-found");
  if (request.method !== "POST") return fail("method");
  const action = parts[3] as "ask" | "inspect" | "accuse";
  const body = await readBody(request);
  if (typeof body.revision !== "number" || !Number.isSafeInteger(body.revision)) return fail("bad-request");
  const revision = body.revision;

  const done = await deps.sessions.update<ViewReply>(id, owner, async (record, hold) => {
    const c = caseFor(record);
    // The page acted on a view the session has since left behind. Nothing is done.
    if (record.revision !== revision) throw new Refused("stale");
    const h = handlesOf(c, record);
    const model = modelFor(record);
    /** The record as the store has it now: the one this work was handed, or the one it saved when a question began. */
    let base = record;
    /** True once a question has been written down as begun, which happens before its first request. */
    let begun = false;
    /** True once the visitor's allowance has refused a request of this question. */
    let spent = false;
    const keep = (next: Session, note?: AskNote): { record: SessionRecord; value: ViewReply } => {
      // The revision moves only when the session did: a saved answer given again changes nothing.
      // A question that was begun always moved it: its number is used, whatever came of it.
      const changed = begun || JSON.stringify(next) !== JSON.stringify(base.session);
      // Once something new is kept, the question that was begun is either in it or behind it.
      const { inFlight: _begun, ...settled } = base;
      // A mark that was already there when this work started is a question that never finished.
      const lost = (record.lost ?? 0) + (record.inFlight !== undefined ? 1 : 0);
      const kept = changed ? withHandles(c, { ...settled, session: next, revision: base.revision + 1, ...(lost > 0 ? { lost } : {}) }) : base;
      // This request holds the session, so a question still marked as begun is one that was lost.
      return { record: kept, value: replyOf(c, kept, false, note) };
    };
    /** The case's id for a handle, or a refusal that is the same whether the thing is locked or was never there. */
    const need = (found: string | undefined, code: ErrorCode = "not-available"): string => {
      if (found === undefined) throw new Refused(code);
      return found;
    };

    if (action === "inspect") return keep(inspect(c, record.session, need(h.inspection.id(handle(body, "inspection")))).session);

    if (action === "accuse") {
      const cited = body.evidence;
      if (!Array.isArray(cited) || cited.length > MAX_CITED || cited.some((e) => typeof e !== "string")) throw new Refused("bad-request");
      const evidence = (cited as string[]).map((e) => need(HANDLE.test(e) ? h.evidence.id(e) : undefined, "not-held"));
      return keep(accuse(c, record.session, { suspect: need(h.person.id(handle(body, "person"))), evidence }).session);
    }

    const noteOf = (result: { replayed: boolean; recorded: boolean; turn: { suspect: string; line: string; language: Lang; source: LineSource; problem?: string } }): AskNote => {
      const note: AskNote = { replayed: result.replayed, recorded: result.recorded };
      if (!result.recorded) note.notice = spent ? { code: "allowance", text: NOTICES.allowance } : { code: "not-asked", text: NOTICES["not-asked"] };
      else {
        note.shown = { person: h.person.handle(result.turn.suspect), line: result.turn.line, language: result.turn.language, source: result.turn.source };
        // With the model off, a statement worded by code is the expected answer and needs no notice.
        if (model === "on" && !result.replayed && result.turn.problem) note.notice = { code: "worded-by-code", text: NOTICES["worded-by-code"] };
      }
      return note;
    };
    // A session that began with the model off never reaches the real one, whatever the server holds now.
    const refuse: Metered = async (r) => ({ ok: false, attemptId: r.attemptId, sent: false, reason: "kill-switch" });
    const live: Metered = async (r) => {
      // Before the question's first request: write down that it has begun, and move its number
      // and the session's revision on. From here the click that asked it is used up: delivered
      // again, it is stale and does nothing. If this worker is lost, the next view says so, and
      // asking again is a new click on that view. If this cannot be written, it throws, and
      // nothing is sent.
      if (!begun) {
        const n = record.session.asked + 1;
        const admitted: SessionRecord = { ...record, session: { ...record.session, asked: n }, inFlight: n, revision: record.revision + 1 };
        await hold.save(admitted);
        base = admitted;
        begun = true;
      } else {
        // A further request of the same question: only if this worker still holds the session.
        // A worker that stalled and lost it to another must send nothing more. This throws then.
        await hold.check();
      }
      if (spent) return refuse(r);
      if (deps.allowance) {
        // An allowance that cannot be read is "no": the request is not sent.
        const allowed = await deps.allowance.request(owner).catch(() => null);
        if (allowed !== true) {
          spent = allowed === false;
          return refuse(r);
        }
      }
      return deps.metered(r);
    };
    const metered: Metered = model === "on" ? live : refuse;

    if (body.topic !== undefined) {
      const topic = need(h.topic.id(handle(body, "topic")));
      const suspect = need(c.actions.topics.find((t) => t.id === topic)?.suspect);
      const result = await ask(metered, c, record.session, { suspect, topic, language: body.language === "zh" ? "zh" : "en", cacheKey: `case:${c.id}` });
      return keep(result.session, noteOf(result));
    }
    // A question in the player's own words. With the model off it is not asked at all: nothing is used.
    const suspect = need(h.person.id(handle(body, "person")));
    const question = text(body, "question");
    if (model === "off") throw new Refused("model-off");
    const result = await ask(metered, c, record.session, { suspect, question, cacheKey: `case:${c.id}` });
    return keep(result.session, noteOf(result));
  });

  if (!done.ok) return fail(done.why === "missing" ? "not-found" : done.why);
  return json(200, done.value);
}
