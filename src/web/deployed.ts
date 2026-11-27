import type { IncomingMessage, ServerResponse } from "node:http";
import { ANSWER_OUTPUT_TOKENS } from "../agents/suspect-turn";
import type { Case } from "../case/schema";
import type { Metered, TraceEvent } from "../metered";
import { guardedModel, readSpendConfig, resolveApiKey } from "../runtime";
import { absoluteWorstNano } from "../spend/pricing";
import { connectRedis } from "../spend/redis-client";
import type { ScriptRunner } from "../spend/redis-store";
import type { EnvelopeTotals } from "../spend/store";
import { DEFAULT_LIMITS, redisAllowance, type AllowanceLimits } from "./allowance";
import { handleRequest, serverFailure } from "./api";
import { loadLibrary } from "./library";
import { requestOf, respond } from "./node";
import { redisSessions } from "./redis-sessions";

/**
 * The game API as a deployed server runs it: many short-lived workers that share nothing
 * but Redis.
 *
 * Everything is kept in Redis: the sessions, the visitor allowance, the spend counter and
 * the usage trace. The model is reached only through the spend guard, on the envelope the
 * server is configured with, and only while all of this holds:
 *
 *   - the server has a key, and EMBER_DISABLED is not "1";
 *   - an operator has authorized paid requests on the envelope, and it is not suspended;
 *   - the envelope has room for one more request at its worst-case cost.
 *
 * Otherwise the model is off: games start with the model off and stay that way, topics from
 * the menu are worded by code, and a typed question says it needs the model. The spend guard
 * still checks every one of these again at each request; what is decided here is only what a
 * visitor is told and how a new game starts.
 *
 * It fails closed. Without its configuration the server answers every request with the fixed
 * server error and sends nothing. If Redis cannot be reached, no game starts and no request
 * is sent.
 */
type Env = Record<string, string | undefined>;

/** Thrown when the server's configuration is missing or wrong. Its message names the setting, never its value. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export interface DeployedConfig {
  /** The site's own origin, e.g. "https://example.com". A request that changes something must come from exactly here. */
  origin: string;
  redisUrl: string;
  envelope: string;
  limitNano: number;
  limits: AllowanceLimits;
  /** The first part of every key the web server writes. */
  prefix: string;
  /** Where the released case files are, beside the function. */
  casesDir: string;
}

/** The first part of the web server's keys when none is configured. The spend counter has its own key. */
export const WEB_PREFIX = "ta:web";
/** How many trace lines are kept in Redis. Older lines are dropped. */
const TRACE_LINES = 50_000;
/** How long the answer to "is the model on?" is reused. The spend guard itself asks every time. */
const MODEL_STATE_MS = 5_000;

/**
 * The server's configuration, read from its environment:
 *
 *   PUBLIC_ORIGIN            the site's https origin, nothing after the host
 *   REDIS_URL, SPEND_ENVELOPE, SPEND_LIMIT_USD   as for a local run
 *   VISITOR_GAMES_PER_DAY, VISITOR_REQUESTS_PER_DAY, GAMES_PER_HOUR   optional; the allowance
 *   WEB_KEY_PREFIX           optional; the first part of the web server's keys
 */
export function readDeployedConfig(env: Env): DeployedConfig {
  const raw = env.PUBLIC_ORIGIN?.trim();
  if (!raw) throw new ConfigError("PUBLIC_ORIGIN is not set");
  let origin: string | null = null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && url.origin === raw) origin = url.origin;
  } catch {
    origin = null;
  }
  if (origin === null) throw new ConfigError("PUBLIC_ORIGIN must be the site's own https origin, with nothing after the host");

  let spend: ReturnType<typeof readSpendConfig>;
  try {
    spend = readSpendConfig(env);
  } catch (error) {
    // Those messages name the setting only.
    throw new ConfigError((error as Error).message);
  }
  const count = (name: string, fallback: number): number => {
    const value = env[name]?.trim();
    if (!value) return fallback;
    if (!/^[1-9]\d{0,8}$/.test(value)) throw new ConfigError(`${name} must be a whole number above zero`);
    return Number(value);
  };
  const prefix = env.WEB_KEY_PREFIX?.trim() || WEB_PREFIX;
  if (!/^[A-Za-z0-9:_-]{1,80}$/.test(prefix)) throw new ConfigError("WEB_KEY_PREFIX may only have letters, digits, ':', '_' and '-'");
  return {
    origin,
    ...spend,
    limits: {
      ...DEFAULT_LIMITS,
      sessionsPerVisitor: count("VISITOR_GAMES_PER_DAY", DEFAULT_LIMITS.sessionsPerVisitor),
      requestsPerVisitor: count("VISITOR_REQUESTS_PER_DAY", DEFAULT_LIMITS.requestsPerVisitor),
      sessionsPerHour: count("GAMES_PER_HOUR", DEFAULT_LIMITS.sessionsPerHour),
    },
    prefix,
    casesDir: "cases/released",
  };
}

type Connection = Awaited<ReturnType<typeof connectRedis>>;

/**
 * One Redis connection that is opened when first needed and opened again when it has died.
 *
 * A worker can sit idle, or be frozen, for a long time between requests, and find its
 * connection gone when it wakes. So a connection that has not been used for a while is
 * asked for a sign of life first, and replaced if none comes. A command is never sent
 * twice: if it fails, the caller is told, and only the next command gets a new connection.
 */
export function reconnecting(connect: () => Promise<Connection>, options: { idleMs?: number; pingTimeoutMs?: number; now?: () => number } = {}): ScriptRunner & { close(): Promise<void> } {
  const idleMs = options.idleMs ?? 10_000;
  const pingTimeoutMs = options.pingTimeoutMs ?? 2_000;
  const now = options.now ?? Date.now;
  let current: { connection: Connection; usedAt: number } | null = null;
  let opening: Promise<Connection> | null = null;
  const drop = (connection: Connection): void => {
    if (current?.connection === connection) current = null;
    void connection.close().catch(() => undefined);
  };
  const alive = async (connection: Connection): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), pingTimeoutMs)));
    try {
      return await Promise.race([connection.ping().then(() => true, () => false), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  const get = async (): Promise<Connection> => {
    const had = current;
    if (had && now() - had.usedAt > idleMs && !(await alive(had.connection))) drop(had.connection);
    if (current) {
      current.usedAt = now();
      return current.connection;
    }
    opening ??= connect()
      .then((connection) => {
        current = { connection, usedAt: now() };
        return connection;
      })
      .finally(() => (opening = null));
    return opening;
  };
  return {
    eval: async (script, keys, args) => {
      const connection = await get();
      try {
        return await connection.runner.eval(script, keys, args);
      } catch (error) {
        // An answer from Redis that says "no" is an answer. Anything else is trouble with the connection.
        if (!(error instanceof Error && error.name === "ReplyError")) drop(connection);
        throw error;
      }
    },
    close: async () => {
      const had = current;
      current = null;
      await had?.connection.close().catch(() => undefined);
    },
  };
}

// KEYS: the trace list.  ARGV: one line, how many to keep
const TRACE = "redis.call('RPUSH', KEYS[1], ARGV[1]) redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1) return 1";

/**
 * The usage trace as a list in Redis: one JSON line per request, newest last. A worker has
 * no file of its own to write to. Lines hold what the local trace holds: ids, token counts
 * and costs, never prompt or reply text. A line that cannot be written is lost, and changes
 * nothing about what is sent or charged. `pending` holds the writes still on their way, so
 * the worker can wait for them before it answers.
 */
export function redisTrace(redis: ScriptRunner, key: string, pending: Set<Promise<unknown>>): (event: TraceEvent) => void {
  return (event) => {
    const write = redis.eval(TRACE, [key], [JSON.stringify(event), String(TRACE_LINES)]).catch(() => undefined);
    pending.add(write);
    void write.finally(() => pending.delete(write));
  };
}

export interface DeployedParts {
  cases: readonly Case[];
  redis: ScriptRunner;
  origin: string;
  limits: AllowanceLimits;
  prefix: string;
  /** Null when the server has no key: the model is off, and nothing can turn it on. */
  model: {
    metered: Metered;
    totals(): Promise<EnvelopeTotals>;
    limitNano: number;
    /** The server's own switch, read at every request. */
    disabled(): boolean;
    /** Wait for the trace lines that are still being written. */
    settle(): Promise<void>;
  } | null;
  now?: () => number;
}

const refuse: Metered = async (request) => ({ ok: false, attemptId: request.attemptId, sent: false, reason: "kill-switch" });

/** The API over these parts: one function from a request to a response. */
export function deployedApi(parts: DeployedParts): (request: Request) => Promise<Response> {
  const now = parts.now ?? Date.now;
  const sessions = redisSessions(parts.redis, { prefix: parts.prefix });
  const allowance = redisAllowance(parts.redis, { prefix: parts.prefix, limits: parts.limits });
  // The most one request can hold. With less room than this in the envelope, none can be sent.
  const oneRequest = absoluteWorstNano(ANSWER_OUTPUT_TOKENS);
  let seen: { at: number; off: boolean } | null = null;
  const modelOff = async (): Promise<boolean> => {
    const model = parts.model;
    if (!model || model.disabled()) return true;
    if (seen && now() - seen.at < MODEL_STATE_MS) return seen.off;
    let off = true;
    try {
      const totals = await model.totals();
      off = totals.suspended !== null || totals.paidAllowed === null || model.limitNano - totals.committedNano < oneRequest;
    } catch {
      // The counter cannot be read: nothing would be admitted, so the model is off.
      off = true;
    }
    seen = { at: now(), off };
    return off;
  };
  return async (request) => {
    const response = await handleRequest(request, { cases: parts.cases, sessions, allowance, origin: parts.origin, metered: parts.model?.metered ?? refuse, modelOff: await modelOff() });
    await parts.model?.settle();
    return response;
  };
}

/** The parts, made from the server's environment. Throws `ConfigError` if the configuration is missing or wrong. */
export function deployedParts(env: Env = process.env): DeployedParts {
  const config = readDeployedConfig(env);
  const redis = reconnecting(() => connectRedis(config.redisUrl, { commandTimeoutMs: 5_000 }));
  const { cases } = loadLibrary(config.casesDir);
  const key = resolveApiKey(env);
  let model: DeployedParts["model"] = null;
  if (key) {
    const pending = new Set<Promise<unknown>>();
    const { metered, store } = guardedModel({ env, config, apiKey: key.key, redis, trace: redisTrace(redis, `${config.prefix}:trace:${config.envelope}`, pending) });
    model = {
      metered,
      totals: () => store.totals(config.envelope),
      limitNano: config.limitNano,
      disabled: () => env.EMBER_DISABLED === "1",
      settle: async () => void (await Promise.allSettled([...pending])),
    };
  }
  return { cases, redis, origin: config.origin, limits: config.limits, prefix: config.prefix, model };
}

/**
 * The deployed server as a Node listener, which is what the host calls. It sits behind the
 * host's proxy, so the scheme the proxy reports is believed; what counts for the origin
 * check and the cookie is the configured origin in any case.
 *
 * The parts are made on the first request and kept. If they cannot be made, the answer is
 * the fixed server error, the reason is written to the log by the setting's name only, and
 * the next request tries again.
 */
export function deployedListener(setup: () => DeployedParts | Promise<DeployedParts> = () => deployedParts(), log: (line: string) => void = (line) => console.error(line)): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let ready: Promise<(request: Request) => Promise<Response>> | null = null;
  return async (req, res) => {
    let api: (request: Request) => Promise<Response>;
    try {
      ready ??= Promise.resolve()
        .then(setup)
        .then(deployedApi);
      api = await ready;
    } catch (error) {
      ready = null;
      log(`twenty-alibis: the server is not ready: ${error instanceof ConfigError ? error.message : "it could not be set up"}`);
      await respond(req, res, serverFailure());
      return;
    }
    await respond(req, res, await api(requestOf(req, { trustProxy: true })));
  };
}
